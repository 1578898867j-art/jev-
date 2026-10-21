import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  ActionResponse,
  ApiError,
  ChatMessage,
  PlayerEvidence,
  PuzzleDefinition,
  PublicPuzzle,
  SessionStatus,
  SessionView,
} from '@ai-turtle-soup/shared';
import { AppFault } from './errors.js';
import { toPublicPuzzle } from './content.js';
import type { PreviousHint } from './ai/types.js';

export interface ActionOutcome {
  status: number;
  body: ActionResponse | ApiError;
}

export interface PendingAction {
  requestId: string;
  fingerprint: string;
  kind: 'question' | 'hint';
  controller: AbortController;
  promise: Promise<ActionOutcome>;
  resolve: (outcome: ActionOutcome) => void;
  settled: boolean;
}

export interface SessionRecord {
  id: string;
  tokenDigest: Buffer;
  puzzle: PuzzleDefinition;
  publicPuzzle: PublicPuzzle;
  status: SessionStatus;
  revision: number;
  discoveredClueIds: Set<string>;
  hintsUsed: number;
  usedHintAngleIds: Set<string>;
  hintSelections: PreviousHint[];
  messages: ChatMessage[];
  solutionVisible: boolean;
  acceptedEvidence: Array<{ clueId: string; evidence: PlayerEvidence[] }>;
  requestFingerprints: Map<string, string>;
  successfulRequests: Map<string, { fingerprint: string; outcome: ActionOutcome }>;
  pendingRequests: Map<string, PendingAction>;
  activeOperation?: PendingAction;
  lastTouchedAt: number;
}

export interface CreatedSession {
  sessionToken: string;
  session: SessionView;
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function viewSession(session: SessionRecord): SessionView {
  const discovered = session.puzzle.clues
    .filter((clue) => session.discoveredClueIds.has(clue.id))
    .map((clue) => ({ id: clue.id, kind: clue.kind, publicText: clue.publicText }));
  const view: SessionView = {
    id: session.id,
    puzzle: session.publicPuzzle,
    status: session.status,
    revision: session.revision,
    discoveredClues: discovered,
    hintsUsed: session.hintsUsed,
    messages: session.messages.map((message) => ({ ...message })),
  };
  if (session.solutionVisible && (session.status === 'completed' || session.status === 'given_up')) {
    view.solution = { text: session.puzzle.solution };
  }
  return view;
}

export class SessionManager {
  readonly sessions = new Map<string, SessionRecord>();
  private readonly puzzlesById = new Map<string, PuzzleDefinition>();

  constructor(
    puzzles: PuzzleDefinition[],
    readonly ttlMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {
    for (const puzzle of puzzles) this.puzzlesById.set(puzzle.id, puzzle);
  }

  create(puzzleId: string): CreatedSession {
    const puzzle = this.puzzlesById.get(puzzleId);
    if (!puzzle) throw new AppFault('PUZZLE_NOT_FOUND');
    const sessionToken = randomBytes(32).toString('base64url');
    const session: SessionRecord = {
      id: randomUUID(),
      tokenDigest: tokenDigest(sessionToken),
      puzzle: structuredClone(puzzle),
      publicPuzzle: toPublicPuzzle(puzzle),
      status: 'playing',
      revision: 0,
      discoveredClueIds: new Set(),
      hintsUsed: 0,
      usedHintAngleIds: new Set(),
      hintSelections: [],
      messages: [],
      solutionVisible: false,
      acceptedEvidence: [],
      requestFingerprints: new Map(),
      successfulRequests: new Map(),
      pendingRequests: new Map(),
      lastTouchedAt: this.now(),
    };
    this.sessions.set(session.id, session);
    return { sessionToken, session: viewSession(session) };
  }

  authorize(sessionId: string, token: string | undefined): SessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) throw new AppFault('SESSION_NOT_FOUND');
    if (this.now() - session.lastTouchedAt >= this.ttlMs) {
      this.expire(session);
      throw new AppFault('SESSION_EXPIRED');
    }
    if (!token) throw new AppFault('UNAUTHORIZED');
    const incomingDigest = tokenDigest(token);
    if (!timingSafeEqual(session.tokenDigest, incomingDigest)) throw new AppFault('UNAUTHORIZED');
    session.lastTouchedAt = this.now();
    return session;
  }

  sweepExpired(): void {
    const now = this.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastTouchedAt >= this.ttlMs) this.expire(session);
    }
  }

  private expire(session: SessionRecord): void {
    if (session.activeOperation) {
      session.activeOperation.controller.abort();
      const cancellation: ActionOutcome = {
        status: 409,
        body: new AppFault('OPERATION_CANCELLED', session.activeOperation.requestId).toBody(),
      };
      settlePending(session, session.activeOperation, cancellation);
    }
    this.sessions.delete(session.id);
  }
}

export function makeActionOutcome(requestId: string, session: SessionRecord): ActionOutcome {
  return { status: 200, body: { requestId, session: viewSession(session) } };
}

export function settlePending(session: SessionRecord, pending: PendingAction, outcome: ActionOutcome): void {
  if (pending.settled) return;
  pending.settled = true;
  session.pendingRequests.delete(pending.requestId);
  if (session.activeOperation === pending) session.activeOperation = undefined;
  pending.resolve(outcome);
}
