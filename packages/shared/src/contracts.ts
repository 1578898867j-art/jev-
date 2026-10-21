export type ClueKind = 'fact' | 'cause';
export type Judgment = 'yes' | 'no' | 'irrelevant' | 'unknown' | 'rephrase';
export type SessionStatus = 'playing' | 'unlocked' | 'completed' | 'given_up' | 'left';

// Server-side content type. Hidden data must never enter the Web build.
export interface ClueDefinition {
  id: string;
  kind: ClueKind;
  required: true;
  meaning: string;
  publicText: string;
  positiveExamples: string[];
  negativeExamples: string[];
  cause?: { fromFactIds: string[]; toFactIds: string[] };
  hintAngles: Array<{ id: string; direction: string }>;
}

export interface PuzzleDefinition {
  id: string;
  version: string;
  title: string;
  surface: string;
  solution: string;
  clues: ClueDefinition[];
  source: { kind: 'original' | 'adapted'; note: string; url?: string; license?: string };
}

export interface PublicPuzzle {
  id: string;
  version: string;
  title: string;
  surface: string;
  requiredClueCount: number;
}

export interface DiscoveredClueView {
  id: string;
  kind: ClueKind;
  publicText: string;
}

export interface ChatMessage {
  id: string;
  role: 'player' | 'host' | 'hint';
  text: string;
  createdAt: string; // UTC ISO 8601
  judgment?: Judgment; // Only host messages may carry this field.
}

export interface SessionView {
  id: string;
  puzzle: PublicPuzzle;
  status: SessionStatus;
  revision: number;
  discoveredClues: DiscoveredClueView[];
  hintsUsed: number;
  messages: ChatMessage[];
  solution?: { text: string }; // Only for completed / given_up.
}

export interface ActionRequest { requestId: string; expectedRevision: number }
export interface QuestionRequest extends ActionRequest { text: string }
export interface ActionResponse { requestId: string; session: SessionView }
export interface CreateSessionRequest { puzzleId: string }
export interface CreateSessionResponse { sessionToken: string; session: SessionView }

export interface ApiError {
  error: { code: ErrorCode; message: string; retryable: boolean };
  requestId?: string;
}

export type ErrorCode =
  | 'INVALID_REQUEST' | 'UNAUTHORIZED' | 'PUZZLE_NOT_FOUND'
  | 'SESSION_NOT_FOUND' | 'SESSION_EXPIRED' | 'SESSION_ENDED'
  | 'REVISION_CONFLICT' | 'REQUEST_ID_REUSED' | 'SESSION_BUSY'
  | 'ACTION_NOT_ALLOWED' | 'HINT_LIMIT_REACHED' | 'HINT_UNAVAILABLE'
  | 'AI_NOT_CONFIGURED' | 'AI_UNAVAILABLE' | 'AI_TIMEOUT'
  | 'INVALID_MODEL_OUTPUT' | 'OPERATION_CANCELLED' | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export interface PlayerEvidence { messageId: string; quote: string }
export interface QuestionModelOutput {
  judgment: Judgment;
  clueCandidates: Array<{ clueId: string; evidence: PlayerEvidence[] }>;
}
export interface HintModelOutput {
  targetClueId: string;
  angleId: string;
  text: string;
}

export interface EvaluationCaseFile {
  schemaVersion: 1;
  puzzleId: string;
  puzzleVersion: string;
  cases: EvaluationCase[];
}
export interface EvaluationCase {
  id: string;
  split: 'regression' | 'holdout';
  category: 'qa' | 'clue-positive' | 'clue-negative' | 'causality' | 'safety' | 'hint';
  history: Array<{
    role: 'player' | 'host' | 'hint';
    text: string;
    judgment?: Judgment;
  }>;
  initialDiscoveredClueIds: string[];
  initialHintsUsed: number;
  action: { type: 'question'; text: string } | { type: 'hint' };
  expected: {
    judgment?: Judgment;
    addedClueIds: string[];
    status: 'playing' | 'unlocked';
    hintsUsedDelta: 0 | 1;
    forbiddenTexts?: string[];
  };
  notes: string;
}
