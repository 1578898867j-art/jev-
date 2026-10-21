import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { z } from 'zod';
import type { ClueDefinition, PuzzleDefinition, PublicPuzzle } from '@ai-turtle-soup/shared';

const clueSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['fact', 'cause']),
  required: z.literal(true),
  meaning: z.string().min(1),
  publicText: z.string().min(1),
  positiveExamples: z.array(z.string().min(1)).min(2),
  negativeExamples: z.array(z.string().min(1)).min(2),
  cause: z.object({
    fromFactIds: z.array(z.string().min(1)).min(1),
    toFactIds: z.array(z.string().min(1)).min(1),
  }).strict().optional(),
  hintAngles: z.array(z.object({ id: z.string().min(1), direction: z.string().min(1) }).strict()).min(3),
}).strict();

const puzzleSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: z.string().min(1),
  title: z.string().min(1),
  surface: z.string().min(1),
  solution: z.string().min(1),
  clues: z.array(clueSchema).min(2),
  source: z.object({
    kind: z.enum(['original', 'adapted']),
    note: z.string().min(1),
    url: z.string().url().optional(),
    license: z.string().min(1).optional(),
  }).strict(),
}).strict();

export const DEFAULT_CONTENT_DIRECTORY = fileURLToPath(new URL('../../content/puzzles/', import.meta.url));

export function parsePuzzleDefinition(value: unknown): PuzzleDefinition {
  const puzzle = puzzleSchema.parse(value) as PuzzleDefinition;
  const clueIds = new Set<string>();
  const angleIds = new Set<string>();
  const facts = new Set<string>();

  for (const clue of puzzle.clues) {
    if (clueIds.has(clue.id)) throw new Error(`Duplicate clue id: ${clue.id}`);
    clueIds.add(clue.id);
    if (clue.kind === 'fact') {
      if (clue.cause) throw new Error(`Fact clue ${clue.id} cannot include cause`);
      facts.add(clue.id);
    } else if (!clue.cause) {
      throw new Error(`Cause clue ${clue.id} must include cause references`);
    }
    for (const angle of clue.hintAngles) {
      if (angleIds.has(angle.id)) throw new Error(`Duplicate hint angle id: ${angle.id}`);
      angleIds.add(angle.id);
    }
  }

  const hasFact = puzzle.clues.some((clue) => clue.kind === 'fact');
  const hasCause = puzzle.clues.some((clue) => clue.kind === 'cause');
  if (!hasFact || !hasCause) throw new Error('A puzzle must have at least one fact and one cause clue');

  for (const clue of puzzle.clues) {
    if (clue.kind !== 'cause' || !clue.cause) continue;
    if ([...clue.cause.fromFactIds, ...clue.cause.toFactIds].some((id) => !facts.has(id))) {
      throw new Error(`Cause clue ${clue.id} references an unknown or non-fact clue`);
    }
  }

  return puzzle;
}

export async function loadPuzzles(directory = DEFAULT_CONTENT_DIRECTORY): Promise<PuzzleDefinition[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const puzzles = await Promise.all(entries.map(async (entry) => {
    const source = await readFile(join(directory, entry.name), 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new Error(`Invalid JSON in puzzle file ${entry.name}`);
    }
    return parsePuzzleDefinition(value);
  }));
  const ids = new Set<string>();
  for (const puzzle of puzzles) {
    if (ids.has(puzzle.id)) throw new Error(`Duplicate puzzle id: ${puzzle.id}`);
    ids.add(puzzle.id);
  }
  return puzzles;
}

export function toPublicPuzzle(puzzle: PuzzleDefinition): PublicPuzzle {
  return {
    id: puzzle.id,
    version: puzzle.version,
    title: puzzle.title,
    surface: puzzle.surface,
    requiredClueCount: puzzle.clues.filter((clue: ClueDefinition) => clue.required).length,
  };
}
