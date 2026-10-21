import type {
  ActionResponse,
  ApiError,
  CreateSessionResponse,
  PublicPuzzle,
  SessionView,
} from '../../packages/shared/src/contracts.js';
import { parseRetryAfterDeadline } from './retry-policy.js';

type HealthResponse = { status: 'ok'; ai: { configured: boolean } };
type PuzzlesResponse = { puzzles: PublicPuzzle[] };
type SessionResponse = { session: SessionView };
type ActionKind = 'question' | 'hint' | 'reveal' | 'give-up' | 'leave';

export class ApiClientError extends Error {
  readonly code: ApiError['error']['code'];
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly retryAfterAt?: number;

  constructor(status: number, payload: ApiError | undefined, retryAfter: string | null) {
    super(payload?.error.message ?? '服务器暂时无法处理这次请求。');
    this.name = 'ApiClientError';
    this.status = status;
    this.code = payload?.error.code ?? 'INTERNAL_ERROR';
    this.retryable = payload?.error.retryable ?? status >= 500;
    const retryAfterAt = parseRetryAfterDeadline(retryAfter);
    if (retryAfterAt !== undefined) {
      this.retryAfterAt = retryAfterAt;
      this.retryAfterSeconds = Math.max(0, (retryAfterAt - Date.now()) / 1000);
    }
  }
}

export class ApiRequestTimeoutError extends Error {
  constructor() {
    super('The API request exceeded the client deadline.');
    this.name = 'ApiRequestTimeoutError';
  }
}

export const API_REQUEST_DEADLINE_MS = 40_000;

export type ApiEndpoint = { base: string | null; addressMissing: boolean };

function withApiPath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

export function resolveApiEndpoint(native: boolean, configured: string | undefined): ApiEndpoint {
  const value = configured?.trim() ?? '';
  if (native) {
    if (!value) return { base: null, addressMissing: true };
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { base: null, addressMissing: true };
      }
      return { base: withApiPath(value), addressMissing: false };
    } catch {
      return { base: null, addressMissing: true };
    }
  }

  return { base: value ? withApiPath(value) : '/api', addressMissing: false };
}

async function readJson<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    payload = undefined;
  }

  if (!response.ok) {
    const parsed = isApiError(payload) ? payload : undefined;
    throw new ApiClientError(response.status, parsed, response.headers.get('Retry-After'));
  }
  return payload as T;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function requestJson<T>(url: string, init: RequestInit, deadlineMs: number): Promise<T> {
  const externalSignal = init.signal ?? undefined;
  if (externalSignal?.aborted) throw abortError(externalSignal);

  const { signal: _signal, ...fetchOptions } = init;
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let timedOut = false;
  const timeoutError = new ApiRequestTimeoutError();

  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort(timeoutError);
      reject(timeoutError);
    }, deadlineMs);
  });

  const externalAbort = externalSignal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => {
          controller.abort(externalSignal.reason);
          reject(abortError(externalSignal));
        };
        externalSignal.addEventListener('abort', abortListener, { once: true });
        if (externalSignal.aborted) abortListener();
      })
    : new Promise<never>(() => undefined);

  const operation = Promise.resolve()
    .then(() => {
      if (externalSignal?.aborted) throw abortError(externalSignal);
      return fetch(url, { ...fetchOptions, signal: controller.signal });
    })
    .then(readJson<T>);

  try {
    return await Promise.race([operation, deadline, externalAbort]);
  } catch (error) {
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (externalSignal && abortListener) externalSignal.removeEventListener('abort', abortListener);
  }
}

function isApiError(value: unknown): value is ApiError {
  if (!value || typeof value !== 'object') return false;
  const error = (value as { error?: unknown }).error;
  return !!error && typeof error === 'object' &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string' &&
    typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly deadlineMs = API_REQUEST_DEADLINE_MS,
  ) {}

  async health(signal?: AbortSignal): Promise<HealthResponse> {
    return requestJson<HealthResponse>(`${this.base}/health`, { signal }, this.deadlineMs);
  }

  async puzzles(signal?: AbortSignal): Promise<PuzzlesResponse> {
    return requestJson<PuzzlesResponse>(`${this.base}/puzzles`, { signal }, this.deadlineMs);
  }

  async createSession(puzzleId: string, signal?: AbortSignal): Promise<CreateSessionResponse> {
    return requestJson<CreateSessionResponse>(`${this.base}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ puzzleId }),
      signal,
    }, this.deadlineMs);
  }

  async session(id: string, token: string, signal?: AbortSignal): Promise<SessionResponse> {
    return requestJson<SessionResponse>(`${this.base}/sessions/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
      signal,
    }, this.deadlineMs);
  }

  async action(
    kind: ActionKind,
    id: string,
    token: string,
    requestId: string,
    expectedRevision: number,
    text?: string,
    signal?: AbortSignal,
  ): Promise<ActionResponse> {
    const suffix = kind === 'question' ? 'questions' :
      kind === 'hint' ? 'hints' :
      kind === 'reveal' ? 'reveal' :
      kind === 'give-up' ? 'give-up' : 'leave';
    const body = kind === 'question'
      ? { requestId, expectedRevision, text: text ?? '' }
      : { requestId, expectedRevision };

    return requestJson<ActionResponse>(
      `${this.base}/sessions/${encodeURIComponent(id)}/${suffix}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      },
      this.deadlineMs,
    );
  }
}
