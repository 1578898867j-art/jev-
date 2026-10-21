import { z } from 'zod';
import type { ChatMessage, HintModelOutput, PlayerEvidence, PuzzleDefinition, QuestionModelOutput } from '@ai-turtle-soup/shared';
import { AppFault } from '../errors.js';
import type { AvailableHintAngle } from './types.js';

const judgmentSchema = z.enum(['yes', 'no', 'irrelevant', 'unknown', 'rephrase']);

export const questionModelOutputSchema = z.object({
  judgment: judgmentSchema,
  clueCandidates: z.array(z.object({
    clueId: z.string().min(1),
    evidence: z.array(z.object({
      messageId: z.string().min(1),
      quote: z.string().min(1),
    }).strict()).min(1),
  }).strict()),
}).strict();

export const hintModelOutputSchema = z.object({
  targetClueId: z.string().min(1),
  angleId: z.string().min(1),
  text: z.string(),
}).strict();

export function parseQuestionModelOutput(value: unknown): QuestionModelOutput {
  return questionModelOutputSchema.parse(value);
}

export function parseHintModelOutput(value: unknown): HintModelOutput {
  return hintModelOutputSchema.parse(value);
}

function evidenceUsesPlayerText(
  evidence: PlayerEvidence[],
  current: { id: string; text: string },
  history: ChatMessage[],
): boolean {
  let includesCurrent = false;
  for (const item of evidence) {
    if (!item.quote.trim()) return false;
    let source: string | undefined;
    if (item.messageId === current.id) {
      source = current.text;
      includesCurrent = true;
    } else {
      source = history.find((message) => message.id === item.messageId && message.role === 'player')?.text;
    }
    if (source === undefined || !source.includes(item.quote)) return false;
  }
  return includesCurrent;
}

/** Validate structure, known clue IDs, unique candidates, and exact player-source evidence. */
export function validateQuestionModelResult(
  value: unknown,
  puzzle: PuzzleDefinition,
  current: { id: string; text: string },
  history: ChatMessage[],
): QuestionModelOutput {
  let output: QuestionModelOutput;
  try {
    output = parseQuestionModelOutput(value);
  } catch {
    throw new AppFault('INVALID_MODEL_OUTPUT');
  }
  if (output.judgment !== 'yes' && output.clueCandidates.length > 0) {
    throw new AppFault('INVALID_MODEL_OUTPUT');
  }
  const clueIds = new Set<string>();
  for (const candidate of output.clueCandidates) {
    if (clueIds.has(candidate.clueId) || !puzzle.clues.some((clue) => clue.id === candidate.clueId)) {
      throw new AppFault('INVALID_MODEL_OUTPUT');
    }
    clueIds.add(candidate.clueId);
    if (!evidenceUsesPlayerText(candidate.evidence, current, history)) throw new AppFault('INVALID_MODEL_OUTPUT');
  }
  return output;
}

export interface ValidatedHintModelResult {
  output: HintModelOutput;
  text: string;
  selected: AvailableHintAngle;
}

/** Validate that a hint selects an available angle for an undiscovered clue and fits the UI limit. */
export function validateHintModelResult(
  value: unknown,
  availableAngles: AvailableHintAngle[],
  discoveredClueIds: ReadonlySet<string>,
): ValidatedHintModelResult {
  let output: HintModelOutput;
  try {
    output = parseHintModelOutput(value);
  } catch {
    throw new AppFault('INVALID_MODEL_OUTPUT');
  }
  const selected = availableAngles.find((angle) => angle.clueId === output.targetClueId && angle.angleId === output.angleId);
  const text = output.text.trim();
  const textLength = Array.from(text).length;
  if (!selected || discoveredClueIds.has(output.targetClueId) || textLength < 1 || textLength > 120) {
    throw new AppFault('INVALID_MODEL_OUTPUT');
  }
  return { output, text, selected };
}
