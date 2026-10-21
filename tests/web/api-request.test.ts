import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_REQUEST_DEADLINE_MS,
  ApiClient,
  ApiClientError,
  ApiRequestTimeoutError,
} from '../../web/src/api.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ApiClient request deadline', () => {
  it('allows the backend model deadline and response handling to finish first', () => {
    expect(API_REQUEST_DEADLINE_MS).toBe(40_000);
  });

  it('bounds a fetch that never receives response headers', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
    vi.stubGlobal('fetch', fetchMock);

    const request = new ApiClient('/api', 25).health();
    const rejection = expect(request).rejects.toBeInstanceOf(ApiRequestTimeoutError);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('keeps the same deadline active while reading the response body', async () => {
    vi.useFakeTimers();
    const response = {
      ok: true,
      headers: new Headers(),
      json: () => new Promise<never>(() => undefined),
    } as unknown as Response;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);

    const request = new ApiClient('/api', 25).health();
    const rejection = expect(request).rejects.toBeInstanceOf(ApiRequestTimeoutError);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(true);
  });

  it('preserves an explicit leave abort as an abort rather than a timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined)));
    const controller = new AbortController();
    const request = new ApiClient('/api', 25).action(
      'leave', 'session-a', 'token', 'request-a', 0, undefined, controller.signal,
    );

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries Retry-After from an HTTP 429 response as a client deadline', async () => {
    const now = Date.now();
    const response = {
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '7' }),
      json: async () => ({
        error: { code: 'RATE_LIMITED', message: '稍后再试', retryable: true },
      }),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));

    const error = await new ApiClient('/api').health().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).retryAfterAt).toBeGreaterThanOrEqual(now + 6_900);
    expect((error as ApiClientError).retryAfterAt).toBeLessThanOrEqual(now + 7_100);
  });

  it('keeps malformed HTTP error JSON separate from a client timeout', async () => {
    const response = {
      ok: false,
      status: 503,
      headers: new Headers(),
      json: async () => { throw new SyntaxError('invalid JSON'); },
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(response));

    const error = await new ApiClient('/api').health().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).not.toBeInstanceOf(ApiRequestTimeoutError);
    expect((error as ApiClientError).status).toBe(503);
  });
});
