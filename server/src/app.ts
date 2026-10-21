import express, { type ErrorRequestHandler, type Express, type Request, type Response } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import type {
  ActionRequest,
  ChatMessage,
  ClueDefinition,
  CreateSessionRequest,
  CreateSessionResponse,
  PuzzleDefinition,
  QuestionRequest,
  SessionView,
} from '@ai-turtle-soup/shared';
import { AppFault, asAppFault } from './errors.js';
import { SessionManager, makeActionOutcome, settlePending, viewSession, type ActionOutcome, type PendingAction, type SessionRecord } from './game.js';
import { toPublicPuzzle } from './content.js';
import type { AiAdapter, AvailableHintAngle, HintModelInput, PreviousHint, QuestionModelInput } from './ai/types.js';
import { validateHintModelResult, validateQuestionModelResult } from './ai/validation.js';

const createRequestSchema = z.object({ puzzleId: z.string().min(1).max(100) }).strict();
const actionRequestSchema = z.object({
  requestId: z.string().uuid(),
  expectedRevision: z.number().int().safe().nonnegative(),
}).strict();
const questionRequestSchema = actionRequestSchema.extend({ text: z.string() }).strict();

const FIXED_HOST_TEXT: Record<NonNullable<ChatMessage['judgment']>, string> = {
  yes: '是。',
  no: '否。',
  irrelevant: '这与关键真相无关。',
  unknown: '故事未交代，无法确定。',
  rephrase: '请围绕故事提出一个可用“是/否”回答的命题；汤底在线索集齐或放弃后查看。',
};

export interface CreateAppOptions {
  puzzles: PuzzleDefinition[];
  ai: AiAdapter;
  sessionTtlMs?: number;
  rateLimit?: { maxRequests: number; windowMs: number };
  clientOrigins?: string[];
  staticWebDir?: string;
  now?: () => number;
}

interface IdempotencyLookup {
  replay?: ActionOutcome;
  pending?: Promise<ActionOutcome>;
}

function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppFault('INVALID_REQUEST');
  return parsed.data;
}

function bearerToken(request: Request): string | undefined {
  const header = request.get('authorization');
  const match = header?.match(/^Bearer ([^\s]+)$/i);
  return match?.[1];
}

function sendOutcome(response: Response, outcome: ActionOutcome): void {
  response.status(outcome.status).json(outcome.body);
}

export const DEFAULT_CLIENT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
] as const;

export function parseClientOrigins(values: string[]): Set<string> {
  const origins = new Set<string>();
  for (const value of values) {
    const candidate = value.trim();
    if (!candidate || candidate === '*') continue;
    try {
      const url = new URL(candidate);
      if ((url.pathname !== '' && url.pathname !== '/') || url.search || url.hash || !url.host) continue;
      const origin = url.origin === 'null' ? `${url.protocol}//${url.host}` : url.origin;
      origins.add(origin);
    } catch {
      // Invalid entries are ignored; CORS never falls back to a wildcard.
    }
  }
  return origins;
}

function errorOutcome(error: unknown, requestId?: string): ActionOutcome {
  const fault = asAppFault(error, requestId);
  return { status: fault.status, body: fault.toBody() };
}

function idempotencyLookup(session: SessionRecord, requestId: string, fingerprint: string): IdempotencyLookup {
  const seenFingerprint = session.requestFingerprints.get(requestId);
  if (seenFingerprint && seenFingerprint !== fingerprint) throw new AppFault('REQUEST_ID_REUSED', requestId);
  if (!seenFingerprint) session.requestFingerprints.set(requestId, fingerprint);

  const success = session.successfulRequests.get(requestId);
  if (success) {
    if (success.fingerprint !== fingerprint) throw new AppFault('REQUEST_ID_REUSED', requestId);
    return { replay: success.outcome };
  }
  const pending = session.pendingRequests.get(requestId);
  if (pending) {
    if (pending.fingerprint !== fingerprint) throw new AppFault('REQUEST_ID_REUSED', requestId);
    return { pending: pending.promise };
  }
  return {};
}

function cacheSuccess(session: SessionRecord, requestId: string, fingerprint: string, outcome: ActionOutcome): void {
  session.successfulRequests.set(requestId, { fingerprint, outcome });
}

function createPendingAction(
  session: SessionRecord,
  requestId: string,
  fingerprint: string,
  kind: 'question' | 'hint',
): PendingAction {
  let resolve!: (outcome: ActionOutcome) => void;
  const promise = new Promise<ActionOutcome>((settle) => { resolve = settle; });
  const pending: PendingAction = {
    requestId,
    fingerprint,
    kind,
    controller: new AbortController(),
    promise,
    resolve,
    settled: false,
  };
  session.pendingRequests.set(requestId, pending);
  session.activeOperation = pending;
  return pending;
}

function cancelActiveOperation(session: SessionRecord): void {
  const pending = session.activeOperation;
  if (!pending) return;
  pending.controller.abort();
  settlePending(session, pending, errorOutcome(new AppFault('OPERATION_CANCELLED', pending.requestId)));
}

function ensureRequestState(session: SessionRecord, request: ActionRequest, requestId: string): void {
  if (session.status === 'left') throw new AppFault('SESSION_ENDED', requestId);
  if (request.expectedRevision !== session.revision) throw new AppFault('REVISION_CONFLICT', requestId);
}

function availableHintAngles(session: SessionRecord): { undiscovered: ClueDefinition[]; angles: AvailableHintAngle[] } {
  const undiscovered = session.puzzle.clues.filter((clue) => !session.discoveredClueIds.has(clue.id));
  const angles = undiscovered.flatMap((clue) => clue.hintAngles
    .filter((angle) => !session.usedHintAngleIds.has(angle.id))
    .map((angle) => ({ clueId: clue.id, angleId: angle.id, direction: angle.direction })));
  return { undiscovered, angles };
}

function isStillCurrentOperation(manager: SessionManager, session: SessionRecord, pending: PendingAction, expectedRevision: number): boolean {
  return manager.sessions.get(session.id) === session
    && session.activeOperation === pending
    && session.status === 'playing'
    && session.revision === expectedRevision;
}

function runQuestion(
  manager: SessionManager,
  session: SessionRecord,
  request: QuestionRequest,
  normalizedText: string,
  fingerprint: string,
  adapter: AiAdapter,
  now: () => number,
): Promise<ActionOutcome> {
  const { requestId, expectedRevision } = request;
  const current = { id: randomUUID(), text: normalizedText };
  const history = session.messages.map((message) => ({ ...message }));
  const modelInput: QuestionModelInput = {
    puzzle: session.puzzle,
    history,
    discoveredClueIds: [...session.discoveredClueIds],
    currentMessage: current,
  };
  const pending = createPendingAction(session, requestId, fingerprint, 'question');

  void (async () => {
    try {
      const raw = await adapter.answerQuestion(modelInput, { signal: pending.controller.signal });
      if (!isStillCurrentOperation(manager, session, pending, expectedRevision)) {
        settlePending(session, pending, errorOutcome(new AppFault('OPERATION_CANCELLED', requestId)));
        return;
      }
      const output = validateQuestionModelResult(raw, session.puzzle, current, history);
      const createdAt = new Date(now()).toISOString();
      const playerMessage: ChatMessage = { id: current.id, role: 'player', text: normalizedText, createdAt };
      const hostMessage: ChatMessage = {
        id: randomUUID(),
        role: 'host',
        text: FIXED_HOST_TEXT[output.judgment],
        createdAt,
        judgment: output.judgment,
      };
      for (const candidate of output.clueCandidates) {
        session.acceptedEvidence.push({ clueId: candidate.clueId, evidence: structuredClone(candidate.evidence) });
        session.discoveredClueIds.add(candidate.clueId);
      }
      session.messages.push(playerMessage, hostMessage);
      const allRequiredDiscovered = session.puzzle.clues
        .filter((clue) => clue.required)
        .every((clue) => session.discoveredClueIds.has(clue.id));
      if (allRequiredDiscovered) session.status = 'unlocked';
      session.revision += 1;
      const outcome = makeActionOutcome(requestId, session);
      cacheSuccess(session, requestId, fingerprint, outcome);
      settlePending(session, pending, outcome);
    } catch (error) {
      settlePending(session, pending, errorOutcome(error, requestId));
    }
  })();

  return pending.promise;
}

function runHint(
  manager: SessionManager,
  session: SessionRecord,
  request: ActionRequest,
  fingerprint: string,
  adapter: AiAdapter,
  now: () => number,
): Promise<ActionOutcome> {
  const { requestId, expectedRevision } = request;
  const { undiscovered, angles } = availableHintAngles(session);
  if (!angles.length) throw new AppFault('HINT_UNAVAILABLE', requestId);
  const modelInput: HintModelInput = {
    puzzle: session.puzzle,
    history: session.messages.map((message) => ({ ...message })),
    undiscoveredClues: undiscovered,
    availableAngles: angles,
    previousHints: session.hintSelections.map((hint) => ({ ...hint })),
    hintsUsed: session.hintsUsed,
  };
  const pending = createPendingAction(session, requestId, fingerprint, 'hint');

  void (async () => {
    try {
      const raw = await adapter.createHint(modelInput, { signal: pending.controller.signal });
      if (!isStillCurrentOperation(manager, session, pending, expectedRevision)) {
        settlePending(session, pending, errorOutcome(new AppFault('OPERATION_CANCELLED', requestId)));
        return;
      }
      const { output, text, selected } = validateHintModelResult(raw, angles, session.discoveredClueIds);
      session.usedHintAngleIds.add(output.angleId);
      const previous: PreviousHint = { clueId: selected.clueId, angleId: selected.angleId, text };
      session.hintSelections.push(previous);
      session.messages.push({ id: randomUUID(), role: 'hint', text, createdAt: new Date(now()).toISOString() });
      session.hintsUsed += 1;
      session.revision += 1;
      const outcome = makeActionOutcome(requestId, session);
      cacheSuccess(session, requestId, fingerprint, outcome);
      settlePending(session, pending, outcome);
    } catch (error) {
      settlePending(session, pending, errorOutcome(error, requestId));
    }
  })();

  return pending.promise;
}

function prepareAction(
  manager: SessionManager,
  session: SessionRecord,
  request: ActionRequest,
  fingerprint: string,
  actionPath: 'question' | 'hint' | 'reveal' | 'give-up' | 'leave',
  adapter: AiAdapter,
  now: () => number,
  normalizedQuestion?: string,
): ActionOutcome | Promise<ActionOutcome> {
  const { requestId } = request;
  const deduplicated = idempotencyLookup(session, requestId, fingerprint);
  if (deduplicated.replay) return deduplicated.replay;
  if (deduplicated.pending) return deduplicated.pending;

  if (session.activeOperation && actionPath !== 'give-up' && actionPath !== 'leave') {
    throw new AppFault('SESSION_BUSY', requestId);
  }
  ensureRequestState(session, request, requestId);

  if (actionPath === 'question' || actionPath === 'hint') {
    if (session.status !== 'playing') throw new AppFault('ACTION_NOT_ALLOWED', requestId);
    if (!adapter.configured) throw new AppFault('AI_NOT_CONFIGURED', requestId);
    if (actionPath === 'question') {
      return runQuestion(manager, session, request as QuestionRequest, normalizedQuestion!, fingerprint, adapter, now);
    }
    if (session.hintsUsed >= 3) throw new AppFault('HINT_LIMIT_REACHED', requestId);
    return runHint(manager, session, request, fingerprint, adapter, now);
  }

  if (actionPath === 'reveal') {
    if (session.status !== 'unlocked') throw new AppFault('ACTION_NOT_ALLOWED', requestId);
    session.status = 'completed';
    session.solutionVisible = true;
  } else if (actionPath === 'give-up') {
    if (session.status !== 'playing') throw new AppFault('ACTION_NOT_ALLOWED', requestId);
    cancelActiveOperation(session);
    session.status = 'given_up';
    session.solutionVisible = true;
  } else {
    if (session.status === 'left') throw new AppFault('SESSION_ENDED', requestId);
    cancelActiveOperation(session);
    session.status = 'left';
    session.solutionVisible = false;
  }
  session.revision += 1;
  const outcome = makeActionOutcome(requestId, session);
  cacheSuccess(session, requestId, fingerprint, outcome);
  return outcome;
}

function routeAction(
  manager: SessionManager,
  adapter: AiAdapter,
  now: () => number,
  actionPath: 'question' | 'hint' | 'reveal' | 'give-up' | 'leave',
) {
  return async (request: Request, response: Response): Promise<void> => {
    let requestId: string | undefined;
    try {
      const parsed = actionPath === 'question'
        ? parseOrThrow(questionRequestSchema, request.body)
        : parseOrThrow(actionRequestSchema, request.body);
      requestId = parsed.requestId;
      const session = manager.authorize(String(request.params.id), bearerToken(request));
      const normalizedQuestion = actionPath === 'question' ? (parsed as QuestionRequest).text.trim() : undefined;
      if (actionPath === 'question') {
        const rawText = (parsed as QuestionRequest).text;
        if (Array.from(rawText).length > 500 || !normalizedQuestion) throw new AppFault('INVALID_REQUEST', requestId);
      }
      const fingerprint = JSON.stringify([
        actionPath,
        parsed.expectedRevision,
        normalizedQuestion,
      ]);
      const outcome = await prepareAction(
        manager,
        session,
        parsed,
        fingerprint,
        actionPath,
        adapter,
        now,
        normalizedQuestion,
      );
      sendOutcome(response, outcome);
    } catch (error) {
      const outcome = errorOutcome(error, requestId);
      sendOutcome(response, outcome);
    }
  };
}

export function createApp(options: CreateAppOptions): Express {
  const puzzles = options.puzzles;
  const adapter = options.ai;
  const now = options.now ?? Date.now;
  const manager = new SessionManager(puzzles, options.sessionTtlMs, now);
  const limit = options.rateLimit ?? { maxRequests: 120, windowMs: 60_000 };
  const rateCounters = new Map<string, { count: number; resetAt: number }>();
  const configuredOrigins = options.clientOrigins
    ?? (process.env.CLIENT_ORIGINS === undefined
      ? [...DEFAULT_CLIENT_ORIGINS]
      : process.env.CLIENT_ORIGINS.split(','));
  const allowedOrigins = parseClientOrigins(configuredOrigins);
  const app = express();

  app.disable('x-powered-by');
  app.locals.sweepExpired = () => manager.sweepExpired();
  app.use('/api', (request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((request, response, next) => {
    const origin = request.get('Origin');
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    }
    if (request.method === 'OPTIONS') {
      if (!origin || !allowedOrigins.has(origin)) {
        response.status(403).end();
        return;
      }
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '8kb', strict: true }));
  app.use('/api', (request, response, next) => {
    const key = request.ip || request.socket.remoteAddress || 'unknown';
    const currentTime = now();
    let counter = rateCounters.get(key);
    if (!counter || counter.resetAt <= currentTime) {
      counter = { count: 0, resetAt: currentTime + limit.windowMs };
      rateCounters.set(key, counter);
    }
    if (counter.count >= limit.maxRequests) {
      response.setHeader('Retry-After', String(Math.max(1, Math.ceil((counter.resetAt - currentTime) / 1000))));
      sendOutcome(response, errorOutcome(new AppFault('RATE_LIMITED')));
      return;
    }
    counter.count += 1;
    if (rateCounters.size > 2_000) {
      for (const [candidate, entry] of rateCounters) {
        if (entry.resetAt <= currentTime) rateCounters.delete(candidate);
      }
    }
    next();
  });

  app.get('/api/health', (_request, response) => {
    response.json({ status: 'ok', ai: { configured: adapter.configured } });
  });

  app.get('/api/puzzles', (_request, response) => {
    response.json({ puzzles: puzzles.map(toPublicPuzzle) });
  });

  app.post('/api/sessions', (request, response) => {
    try {
      const body = parseOrThrow(createRequestSchema, request.body) as CreateSessionRequest;
      const created = manager.create(body.puzzleId);
      const payload: CreateSessionResponse = created;
      response.status(201).json(payload);
    } catch (error) {
      const outcome = errorOutcome(error);
      sendOutcome(response, outcome);
    }
  });

  app.get('/api/sessions/:id', (request, response) => {
    try {
      const session = manager.authorize(String(request.params.id), bearerToken(request));
      const payload: { session: SessionView } = { session: viewSession(session) };
      response.json(payload);
    } catch (error) {
      sendOutcome(response, errorOutcome(error));
    }
  });

  app.post('/api/sessions/:id/questions', routeAction(manager, adapter, now, 'question'));
  app.post('/api/sessions/:id/hints', routeAction(manager, adapter, now, 'hint'));
  app.post('/api/sessions/:id/reveal', routeAction(manager, adapter, now, 'reveal'));
  app.post('/api/sessions/:id/give-up', routeAction(manager, adapter, now, 'give-up'));
  app.post('/api/sessions/:id/leave', routeAction(manager, adapter, now, 'leave'));

  if (options.staticWebDir) {
    app.use(express.static(resolve(options.staticWebDir), {
      dotfiles: 'deny',
      fallthrough: true,
      index: 'index.html',
    }));
  }

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (response.headersSent) return;
    const status = (error as { status?: number }).status;
    if (status === 413) {
      sendOutcome(response, errorOutcome(new AppFault('INVALID_REQUEST')));
      return;
    }
    if (status === 400 || error instanceof SyntaxError) {
      sendOutcome(response, errorOutcome(new AppFault('INVALID_REQUEST')));
      return;
    }
    sendOutcome(response, errorOutcome(error));
  };
  app.use(errorHandler);
  return app;
}

