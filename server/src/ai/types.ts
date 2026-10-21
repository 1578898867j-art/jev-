import type {
  ChatMessage,
  ClueDefinition,
  HintModelOutput,
  PlayerEvidence,
  PuzzleDefinition,
  QuestionModelOutput,
} from '@ai-turtle-soup/shared';

export interface QuestionModelInput {
  puzzle: PuzzleDefinition;
  history: ChatMessage[];
  discoveredClueIds: string[];
  currentMessage: { id: string; text: string };
}

export interface AvailableHintAngle {
  clueId: string;
  angleId: string;
  direction: string;
}

export interface PreviousHint {
  clueId: string;
  angleId: string;
  text: string;
}

export interface HintModelInput {
  puzzle: PuzzleDefinition;
  history: ChatMessage[];
  undiscoveredClues: ClueDefinition[];
  availableAngles: AvailableHintAngle[];
  previousHints: PreviousHint[];
  hintsUsed: number;
}

export interface AiAdapter {
  readonly configured: boolean;
  answerQuestion(
    input: QuestionModelInput,
    options: { signal: AbortSignal },
  ): Promise<QuestionModelOutput>;
  createHint(input: HintModelInput, options: { signal: AbortSignal }): Promise<HintModelOutput>;
}

export interface QuestionCandidate {
  clueId: string;
  evidence: PlayerEvidence[];
}
