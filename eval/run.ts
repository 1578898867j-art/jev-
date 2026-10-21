import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type {
  EvaluationCase,
  EvaluationCaseFile,
  HintModelOutput,
  PuzzleDefinition,
  QuestionModelOutput,
} from '@ai-turtle-soup/shared';
import { loadPuzzles } from '../server/src/content.js';
import { createOpenAiCompatibleAdapterFromEnv } from '../server/src/ai/openai-compatible.js';
import { HINT_PROMPT_VERSION, QA_PROMPT_VERSION } from '../server/src/ai/prompts.js';
import type { AiAdapter, HintModelInput, QuestionModelInput } from '../server/src/ai/types.js';
import { validateHintModelResult, validateQuestionModelResult } from '../server/src/ai/validation.js';
import { AppFault } from '../server/src/errors.js';

const historyMessageSchema = z.object({
  role: z.enum(['player', 'host', 'hint']),
  text: z.string().min(1),
  judgment: z.enum(['yes', 'no', 'irrelevant', 'unknown', 'rephrase']).optional(),
}).strict();

const evaluationCaseSchema: z.ZodType<EvaluationCase> = z.object({
  id: z.string().min(1),
  split: z.enum(['regression', 'holdout']),
  category: z.enum(['qa', 'clue-positive', 'clue-negative', 'causality', 'safety', 'hint']),
  history: z.array(historyMessageSchema),
  initialDiscoveredClueIds: z.array(z.string().min(1)),
  initialHintsUsed: z.number().int().min(0).max(3),
  action: z.union([
    z.object({ type: z.literal('question'), text: z.string().min(1) }).strict(),
    z.object({ type: z.literal('hint') }).strict(),
  ]),
  expected: z.object({
    judgment: z.enum(['yes', 'no', 'irrelevant', 'unknown', 'rephrase']).optional(),
    addedClueIds: z.array(z.string().min(1)),
    status: z.enum(['playing', 'unlocked']),
    hintsUsedDelta: z.union([z.literal(0), z.literal(1)]),
    forbiddenTexts: z.array(z.string().min(1)).optional(),
  }).strict(),
  notes: z.string(),
}).strict();

const evaluationCaseFileSchema: z.ZodType<EvaluationCaseFile> = z.object({
  schemaVersion: z.literal(1),
  puzzleId: z.string().min(1),
  puzzleVersion: z.string().min(1),
  cases: z.array(evaluationCaseSchema).min(20),
}).strict();

export interface RunOptions {
  puzzleId?: string;
  split?: 'all' | 'regression' | 'holdout';
  rounds?: number;
  live?: boolean;
}

interface ActualOutcome {
  judgment?: QuestionModelOutput['judgment'];
  addedClueIds: string[];
  status: 'playing' | 'unlocked';
  hintsUsedDelta: 0 | 1;
  hint?: HintModelOutput;
  userVisibleText: string;
}

export interface CaseRunRecord {
  caseId: string;
  split: EvaluationCase['split'];
  category: EvaluationCase['category'];
  round: number;
  model: string;
  contentVersion: string;
  promptVersion: typeof QA_PROMPT_VERSION | typeof HINT_PROMPT_VERSION;
  action: EvaluationCase['action'];
  history: EvaluationCase['history'];
  expected: EvaluationCase['expected'];
  actual?: ActualOutcome;
  elapsedMs: number;
  outcome: 'matched' | 'mismatch' | 'error';
  errorCode?: string;
  usage: ProviderUsage | null;
  usageNote: string;
  forbiddenTextFindings: string[];
  manualLeakageReviewRequired: boolean;
}

export interface ProviderUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface UsageCapture {
  read(): ProviderUsage | null;
  clear(): void;
}

export interface EvaluationRunReport {
  schemaVersion: 1;
  mode: 'validate-only' | 'live';
  createdAt: string;
  puzzleId: string;
  puzzleVersion: string;
  model: string | null;
  promptVersion: string | null;
  split: 'all' | 'regression' | 'holdout';
  rounds: number;
  selectedCaseCount: number;
  validatedOnly?: true;
  blocked?: string;
  records: CaseRunRecord[];
  note: string;
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CASE_DIRECTORY = join(ROOT, 'eval', 'cases');
const RESULT_DIRECTORY = join(ROOT, 'eval', 'results');
const HOST_TEXT: Record<QuestionModelOutput['judgment'], string> = {
  yes: '是。',
  no: '否。',
  irrelevant: '这与关键真相无关。',
  unknown: '故事未交代，无法确定。',
  rephrase: '请围绕故事提出一个可用“是/否”回答的命题；汤底在线索集齐或放弃后查看。',
};

export function parseRunOptions(args: string[]): RunOptions {
  const options: RunOptions = { split: 'all', rounds: 1, live: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--live') {
      options.live = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new HelpRequested();
    }
    if (arg === '--puzzle') {
      const value = args[++i];
      if (!value) throw new Error('--puzzle requires an id or "all"');
      options.puzzleId = value === 'all' ? undefined : value;
      continue;
    }
    if (arg === '--split') {
      const value = args[++i];
      if (value !== 'all' && value !== 'regression' && value !== 'holdout') {
        throw new Error('--split must be all, regression, or holdout');
      }
      options.split = value;
      continue;
    }
    if (arg === '--rounds') {
      const value = args[++i];
      const rounds = Number(value);
      if (!value || !Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) {
        throw new Error('--rounds must be an integer from 1 to 100');
      }
      options.rounds = rounds;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

class HelpRequested extends Error {}

export function validateCaseFile(value: unknown, puzzle: PuzzleDefinition): EvaluationCaseFile {
  let file: EvaluationCaseFile;
  try {
    file = evaluationCaseFileSchema.parse(value);
  } catch (error) {
    const detail = error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ') : 'invalid shape';
    throw new Error(`Invalid evaluation case file: ${detail}`);
  }

  if (file.puzzleId !== puzzle.id) throw new Error(`Case file puzzleId ${file.puzzleId} does not match ${puzzle.id}`);
  if (file.puzzleVersion !== puzzle.version) throw new Error(`Case file version ${file.puzzleVersion} does not match content ${puzzle.version}`);

  const clueIds = new Set(puzzle.clues.map((clue) => clue.id));
  const allRequiredClueIds = new Set(puzzle.clues.filter((clue) => clue.required).map((clue) => clue.id));
  const caseIds = new Set<string>();
  for (const item of file.cases) {
    if (caseIds.has(item.id)) throw new Error(`Duplicate evaluation case id: ${item.id}`);
    caseIds.add(item.id);

    if (item.history.some((message) => message.role !== 'host' && message.judgment !== undefined)) {
      throw new Error(`${item.id}: only host history messages may carry judgment`);
    }
    if (item.history.filter((message) => message.role === 'hint').length !== item.initialHintsUsed) {
      throw new Error(`${item.id}: initialHintsUsed must match the number of hint messages in history`);
    }

    const initial = new Set(item.initialDiscoveredClueIds);
    if (initial.size !== item.initialDiscoveredClueIds.length) throw new Error(`${item.id}: duplicate initial clue id`);
    if ([...initial].some((clueId) => !clueIds.has(clueId))) throw new Error(`${item.id}: unknown initial clue id`);
    if ([...allRequiredClueIds].every((clueId) => initial.has(clueId))) throw new Error(`${item.id}: initial clue set is already unlocked`);

    const added = new Set(item.expected.addedClueIds);
    if (added.size !== item.expected.addedClueIds.length) throw new Error(`${item.id}: duplicate expected added clue id`);
    if ([...added].some((clueId) => !clueIds.has(clueId))) throw new Error(`${item.id}: unknown expected added clue id`);
    if ([...added].some((clueId) => initial.has(clueId))) throw new Error(`${item.id}: expected added clue is already discovered`);

    if (item.action.type === 'question') {
      if (!item.action.text.trim() || Array.from(item.action.text).length > 500) throw new Error(`${item.id}: question text must be 1-500 characters`);
      if (!item.expected.judgment) throw new Error(`${item.id}: question case must declare expected.judgment`);
      if (item.expected.hintsUsedDelta !== 0) throw new Error(`${item.id}: question case hintsUsedDelta must be 0`);
    } else {
      if (item.expected.judgment !== undefined) throw new Error(`${item.id}: hint case must omit expected.judgment`);
      if (added.size !== 0 || item.expected.hintsUsedDelta !== 1) throw new Error(`${item.id}: hint case must add no clues and increment hints by 1`);
      if (item.initialHintsUsed >= 3) throw new Error(`${item.id}: hint case starts after the three-use limit`);
      if (item.history.some((message) => message.role === 'hint')) {
        throw new Error(`${item.id}: hint action cannot be reconstructed because case schema omits prior hint selections`);
      }
    }

    const finalIds = new Set([...initial, ...added]);
    const expectedStatus = [...allRequiredClueIds].every((clueId) => finalIds.has(clueId)) ? 'unlocked' : 'playing';
    if (item.expected.status !== expectedStatus) {
      throw new Error(`${item.id}: expected.status must be ${expectedStatus} for its final clue set`);
    }
  }
  return file;
}

export function materializeHistory(item: EvaluationCase): QuestionModelInput['history'] {
  const epoch = Date.UTC(2026, 0, 1);
  return item.history.map((message, index) => ({
    id: `${item.id}:h${String(index + 1).padStart(3, '0')}`,
    role: message.role,
    text: message.text,
    createdAt: new Date(epoch + index * 1_000).toISOString(),
    ...(message.role === 'host' && message.judgment ? { judgment: message.judgment } : {}),
  }));
}

function actualMatchesExpected(actual: ActualOutcome, item: EvaluationCase): boolean {
  if (actual.status !== item.expected.status || actual.hintsUsedDelta !== item.expected.hintsUsedDelta) return false;
  if (item.action.type === 'question' && actual.judgment !== item.expected.judgment) return false;
  const expectedIds = [...item.expected.addedClueIds].sort();
  const actualIds = [...actual.addedClueIds].sort();
  return expectedIds.length === actualIds.length && expectedIds.every((id, index) => id === actualIds[index]);
}

function findForbiddenTextFindings(outputText: string, forbiddenTexts: string[] | undefined): string[] {
  if (!forbiddenTexts?.length) return [];
  const normalizedOutput = outputText.toLocaleLowerCase();
  return forbiddenTexts.filter((text) => normalizedOutput.includes(text.toLocaleLowerCase()));
}

function composeUserVisibleOutput(
  puzzle: PuzzleDefinition,
  item: EvaluationCase,
  discoveredClueIds: ReadonlySet<string>,
  generatedMessage: string,
): string {
  const disclosedClues = puzzle.clues
    .filter((clue) => discoveredClueIds.has(clue.id))
    .map((clue) => clue.publicText);
  const priorHostAndHintMessages = item.history
    .filter((message) => message.role === 'host' || message.role === 'hint')
    .map((message) => message.text);
  return [
    puzzle.title,
    puzzle.surface,
    ...disclosedClues,
    ...priorHostAndHintMessages,
    generatedMessage,
  ].join('\n');
}

export async function executeCase(
  puzzle: PuzzleDefinition,
  item: EvaluationCase,
  adapter: AiAdapter,
  round = 1,
  modelName = process.env.AI_MODEL?.trim() || 'unknown',
  usageCapture?: UsageCapture,
): Promise<CaseRunRecord> {
  usageCapture?.clear();
  const history = materializeHistory(item);
  const startedAt = performance.now();
  const base: Omit<CaseRunRecord, 'outcome' | 'elapsedMs' | 'actual' | 'errorCode' | 'forbiddenTextFindings'> = {
    caseId: item.id,
    split: item.split,
    category: item.category,
    round,
    model: modelName,
    contentVersion: puzzle.version,
    promptVersion: item.action.type === 'question' ? QA_PROMPT_VERSION : HINT_PROMPT_VERSION,
    action: item.action,
    history: item.history,
    expected: item.expected,
    usage: null,
    usageNote: usageCapture
      ? 'Token counts are recorded only when the provider includes standard usage fields in its completion response.'
      : 'No provider usage capture was supplied; the AiAdapter exposes typed outputs only.',
    manualLeakageReviewRequired: Boolean(item.expected.forbiddenTexts?.length),
  };

  try {
    let actual: ActualOutcome;
    if (item.action.type === 'question') {
      const current = { id: `${item.id}:current`, text: item.action.text.trim() };
      const input: QuestionModelInput = {
        puzzle,
        history,
        discoveredClueIds: [...item.initialDiscoveredClueIds],
        currentMessage: current,
      };
      const raw = await adapter.answerQuestion(input, { signal: new AbortController().signal });
      const output = validateQuestionModelResult(raw, puzzle, current, history);
      const discovered = new Set(item.initialDiscoveredClueIds);
      const addedClueIds = output.clueCandidates.map(({ clueId }) => clueId).filter((clueId) => !discovered.has(clueId));
      const finalClues = new Set([...discovered, ...addedClueIds]);
      const allRequired = puzzle.clues.filter((clue) => clue.required).every((clue) => finalClues.has(clue.id));
      const allDiscoveredClues = new Set([...discovered, ...addedClueIds]);
      actual = {
        judgment: output.judgment,
        addedClueIds,
        status: allRequired ? 'unlocked' : 'playing',
        hintsUsedDelta: 0,
        userVisibleText: composeUserVisibleOutput(puzzle, item, allDiscoveredClues, HOST_TEXT[output.judgment]),
      };
    } else {
      const discovered = new Set(item.initialDiscoveredClueIds);
      const undiscoveredClues = puzzle.clues.filter((clue) => !discovered.has(clue.id));
      const availableAngles = undiscoveredClues.flatMap((clue) => clue.hintAngles.map((angle) => ({
        clueId: clue.id,
        angleId: angle.id,
        direction: angle.direction,
      })));
      const input: HintModelInput = {
        puzzle,
        history,
        undiscoveredClues,
        availableAngles,
        previousHints: [],
        hintsUsed: item.initialHintsUsed,
      };
      const raw = await adapter.createHint(input, { signal: new AbortController().signal });
      const validated = validateHintModelResult(raw, availableAngles, discovered);
      actual = {
        addedClueIds: [],
        status: 'playing',
        hintsUsedDelta: 1,
        hint: { ...validated.output, text: validated.text },
        userVisibleText: composeUserVisibleOutput(puzzle, item, discovered, validated.text),
      };
    }

    const forbiddenTextFindings = findForbiddenTextFindings(actual.userVisibleText, item.expected.forbiddenTexts);
    return {
      ...base,
      actual,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      outcome: actualMatchesExpected(actual, item) && forbiddenTextFindings.length === 0 ? 'matched' : 'mismatch',
      forbiddenTextFindings,
      usage: usageCapture?.read() ?? null,
    };
  } catch (error) {
    const errorCode = error instanceof AppFault ? error.code : 'EVALUATION_ERROR';
    return {
      ...base,
      elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
      outcome: 'error',
      errorCode,
      forbiddenTextFindings: [],
      usage: usageCapture?.read() ?? null,
    };
  }
}

function resultTimestamp(date = new Date()): string {
  return date.toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
}

async function saveReport(report: EvaluationRunReport): Promise<string> {
  await mkdir(RESULT_DIRECTORY, { recursive: true });
  const path = join(RESULT_DIRECTORY, `${report.puzzleId}-${report.mode}-${resultTimestamp(new Date(report.createdAt))}.json`);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return path;
}

async function readCaseFile(puzzleId: string): Promise<unknown> {
  const path = join(CASE_DIRECTORY, `${puzzleId}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`No evaluation case file found at ${path}`);
    }
    throw new Error(`Unable to read evaluation case file ${path}: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

export async function runEvaluation(options: RunOptions): Promise<EvaluationRunReport> {
  const split = options.split ?? 'all';
  const rounds = options.rounds ?? 1;
  const puzzles = await loadPuzzles();
  const selectedPuzzles = options.puzzleId ? puzzles.filter((puzzle) => puzzle.id === options.puzzleId) : puzzles;
  if (!selectedPuzzles.length) throw new Error(`No puzzle found for ${options.puzzleId ?? '(all)'}`);

  const selections = await Promise.all(selectedPuzzles.map(async (puzzle) => {
    const file = validateCaseFile(await readCaseFile(puzzle.id), puzzle);
    const cases = split === 'all' ? file.cases : file.cases.filter((item) => item.split === split);
    if (!cases.length) throw new Error(`No ${split} cases for puzzle ${puzzle.id}`);
    return { puzzle, cases };
  }));

  let providerUsage: ProviderUsage | null = null;
  const usageCapture: UsageCapture = {
    read: () => providerUsage,
    clear: () => { providerUsage = null; },
  };
  const fetchWithUsage: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    try {
      const payload = await response.clone().json() as { usage?: unknown };
      const usage = payload.usage;
      if (usage && typeof usage === 'object') {
        const source = usage as Record<string, unknown>;
        const counts: ProviderUsage = {};
        for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens'] as const) {
          const value = source[key];
          if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) counts[key] = value;
        }
        if (Object.keys(counts).length) providerUsage = counts;
      }
    } catch {
      // Usage is optional metadata; leave it null when a provider omits or malforms it.
    }
    return response;
  };
  const adapter = options.live
    ? createOpenAiCompatibleAdapterFromEnv(process.env, { fetchImpl: fetchWithUsage })
    : undefined;
  const model = process.env.AI_MODEL?.trim() || null;
  const promptVersion = selections.length === 1
    ? (selections[0].cases.some((item) => item.action.type === 'hint') ? `${QA_PROMPT_VERSION}+${HINT_PROMPT_VERSION}` : QA_PROMPT_VERSION)
    : null;
  const createdAt = new Date().toISOString();
  const report: EvaluationRunReport = {
    schemaVersion: 1,
    mode: options.live ? 'live' : 'validate-only',
    createdAt,
    puzzleId: selections.length === 1 ? selections[0].puzzle.id : 'all',
    puzzleVersion: selections.length === 1 ? selections[0].puzzle.version : 'mixed',
    model: options.live ? model : null,
    promptVersion: options.live ? promptVersion : null,
    split,
    rounds,
    selectedCaseCount: selections.reduce((total, selection) => total + selection.cases.length, 0),
    records: [],
    note: options.live
      ? 'Live adapter calls are real model calls. Forbidden-text checks are supplemental only and require human leakage review.'
      : 'Validate-only checks fixture schema and state consistency; it does not call a model and is not an accuracy result.',
  };

  if (!options.live) {
    report.validatedOnly = true;
    return report;
  }
  if (!adapter?.configured) {
    report.blocked = 'AI_NOT_CONFIGURED: set AI_BASE_URL, AI_MODEL, and AI_API_KEY before using --live.';
    return report;
  }

  for (const selection of selections) {
    for (let round = 1; round <= rounds; round += 1) {
      for (const item of selection.cases) {
        report.records.push(await executeCase(selection.puzzle, item, adapter, round, model ?? 'unknown', usageCapture));
      }
    }
  }
  return report;
}

export function usageText(): string {
  return [
    'Usage: node --import tsx eval/run.ts [--live] [--puzzle <id|all>] [--split <all|regression|holdout>] [--rounds <1-100>]',
    'Default mode validates fixture files only. --live makes real model calls through the configured OpenAI-compatible adapter.',
  ].join('\n');
}

export function exitCodeForReport(report: EvaluationRunReport): 0 | 1 | 2 {
  if (report.blocked) return 2;
  if (report.records.some((record) => record.outcome !== 'matched')) return 1;
  return 0;
}

async function main(): Promise<void> {
  let options: RunOptions;
  try {
    options = parseRunOptions(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      process.stdout.write(`${usageText()}\n`);
      return;
    }
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${usageText()}\n`);
    process.exitCode = 1;
    return;
  }

  try {
    const report = await runEvaluation(options);
    const outputPath = await saveReport(report);
    process.stdout.write(`${JSON.stringify({
      mode: report.mode,
      puzzleId: report.puzzleId,
      puzzleVersion: report.puzzleVersion,
      selectedCaseCount: report.selectedCaseCount,
      rounds: report.rounds,
      outputPath,
      blocked: report.blocked,
    }, null, 2)}\n`);
    process.exitCode = exitCodeForReport(report);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}

