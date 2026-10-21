import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { EvaluationCase, EvaluationCaseFile, HintModelOutput, PuzzleDefinition, QuestionModelOutput } from '@ai-turtle-soup/shared';
import { loadPuzzles } from '../../server/src/content.js';
import type { AiAdapter, HintModelInput, QuestionModelInput } from '../../server/src/ai/types.js';
import { QA_PROMPT_VERSION } from '../../server/src/ai/prompts.js';
import { executeCase, exitCodeForReport, parseRunOptions, validateCaseFile, type EvaluationRunReport } from '../../eval/run.js';

const casesPath = fileURLToPath(new URL('../../eval/cases/beyond-the-dome.json', import.meta.url));

async function loadFixture(): Promise<{ puzzle: PuzzleDefinition; file: EvaluationCaseFile }> {
  const puzzles = await loadPuzzles();
  const puzzle = puzzles.find(({ id }) => id === 'beyond-the-dome');
  if (!puzzle) throw new Error('First puzzle not found');
  const raw = JSON.parse(await readFile(casesPath, 'utf8')) as unknown;
  return { puzzle, file: validateCaseFile(raw, puzzle) };
}

function makeAdapter(overrides: Partial<{
  answerQuestion: (input: QuestionModelInput) => Promise<QuestionModelOutput>;
  createHint: (input: HintModelInput) => Promise<HintModelOutput>;
}> = {}): AiAdapter & { answerQuestion: ReturnType<typeof vi.fn>; createHint: ReturnType<typeof vi.fn> } {
  return {
    configured: true,
    answerQuestion: vi.fn(async (input: QuestionModelInput) => {
      if (overrides.answerQuestion) return overrides.answerQuestion(input);
      throw new Error('Unexpected question adapter call');
    }),
    createHint: vi.fn(async (input: HintModelInput) => {
      if (overrides.createHint) return overrides.createHint(input);
      throw new Error('Unexpected hint adapter call');
    }),
  };
}

describe('manual evaluation runner', () => {
  it('validates the revised case file and the review decisions', async () => {
    const { puzzle, file } = await loadFixture();
    expect(file.cases.length).toBeGreaterThanOrEqual(20);
    expect(file.cases.find(({ id }) => id === 'BOD-R02')?.action).toEqual({
      type: 'question', text: '观测室上方的顶棚可以开启吗？',
    });
    for (const id of ['BOD-C05', 'BOD-C06']) {
      expect(file.cases.find((item) => item.id === id)?.expected.judgment).toBe('unknown');
    }
    expect(file.cases.find(({ id }) => id === 'BOD-Q01')?.expected).toMatchObject({
      judgment: 'yes', addedClueIds: ['projected-sky', 'openable-roof'],
    });
    expect(file.cases.find(({ id }) => id === 'BOD-Q03')?.action).toMatchObject({ type: 'question', text: '观测站海拔是一千米吗？' });
    expect(file.cases.find(({ id }) => id === 'BOD-S03')?.action).toMatchObject({ type: 'question', text: '那台设备型号是 X100 吗？' });
    expect(file.cases.find(({ id }) => id === 'BOD-S05')?.initialHintsUsed).toBe(1);

    const invalid = structuredClone(file) as EvaluationCaseFile;
    const wrongStatus = invalid.cases.find(({ id }) => id === 'BOD-C01');
    if (!wrongStatus) throw new Error('Expected BOD-C01 fixture');
    wrongStatus.expected.status = 'unlocked';
    expect(() => validateCaseFile(invalid, puzzle)).toThrow('expected.status must be playing');
  });

  it('parses explicit CLI options while defaulting to validate-only', () => {
    expect(parseRunOptions([])).toEqual({ split: 'all', rounds: 1, live: false });
    expect(parseRunOptions(['--live', '--puzzle', 'beyond-the-dome', '--split', 'holdout', '--rounds', '2'])).toEqual({
      live: true, puzzleId: 'beyond-the-dome', split: 'holdout', rounds: 2,
    });
    expect(() => parseRunOptions(['--rounds', '0'])).toThrow('--rounds must be an integer');
  });

  it('builds stable question history ids and applies the output validator before state accounting', async () => {
    const { puzzle, file } = await loadFixture();
    const item = file.cases.find(({ id }) => id === 'BOD-X01');
    if (!item) throw new Error('Expected BOD-X01 fixture');
    let captured: QuestionModelInput | undefined;
    const adapter = makeAdapter({
      answerQuestion: async (input) => {
        captured = input;
        return {
          judgment: 'yes',
          clueCandidates: [{ clueId: 'openable-roof', evidence: [{ messageId: input.currentMessage.id, quote: '那屋顶也能打开吗？' }] }],
        };
      },
    });

    const result = await executeCase(puzzle, item, adapter, 1, 'test-model');
    expect(captured?.history.map(({ id }) => id)).toEqual(['BOD-X01:h001', 'BOD-X01:h002']);
    expect(captured?.currentMessage.id).toBe('BOD-X01:current');
    expect(captured?.discoveredClueIds).toEqual(['projected-sky']);
    expect(result).toMatchObject({
      caseId: 'BOD-X01', model: 'test-model', contentVersion: puzzle.version, promptVersion: QA_PROMPT_VERSION,
      outcome: 'matched', actual: { judgment: 'yes', addedClueIds: ['openable-roof'], status: 'playing', hintsUsedDelta: 0 },
      usage: null,
    });
  });

  it('accounts for a successful hint without awarding clues', async () => {
    const { puzzle, file } = await loadFixture();
    const item = file.cases.find(({ id }) => id === 'BOD-H01');
    if (!item) throw new Error('Expected BOD-H01 fixture');
    let captured: HintModelInput | undefined;
    const adapter = makeAdapter({
      createHint: async (input) => {
        captured = input;
        const angle = input.availableAngles[0];
        return { targetClueId: angle.clueId, angleId: angle.angleId, text: '想想室内星点如何呈现。' };
      },
    });

    const result = await executeCase(puzzle, item, adapter);
    expect(captured?.hintsUsed).toBe(0);
    expect(captured?.previousHints).toEqual([]);
    expect(result).toMatchObject({
      outcome: 'matched',
      actual: { addedClueIds: [], status: 'playing', hintsUsedDelta: 1 },
      promptVersion: 'hint-v1',
    });
    expect(result.actual?.userVisibleText).toContain('想想室内星点如何呈现。');
  });

  it('marks a hint that matches forbidden text as mismatch and makes the run exit nonzero', async () => {
    const { puzzle, file } = await loadFixture();
    const original = file.cases.find(({ id }) => id === 'BOD-H01');
    if (!original) throw new Error('Expected BOD-H01 fixture');
    const maliciousText = '游客最后看到了真实星空。';
    const item: EvaluationCase = {
      ...original,
      expected: { ...original.expected, forbiddenTexts: [maliciousText] },
    };
    const adapter = makeAdapter({
      createHint: async (input) => {
        const angle = input.availableAngles[0];
        return { targetClueId: angle.clueId, angleId: angle.angleId, text: `提示：${maliciousText}` };
      },
    });

    const result = await executeCase(puzzle, item, adapter);
    expect(result.outcome).toBe('mismatch');
    expect(result.forbiddenTextFindings).toEqual([maliciousText]);
    expect(result.manualLeakageReviewRequired).toBe(true);
    expect(exitCodeForReport(makeReport([result]))).toBe(1);
  });

  it('checks newly exposed clue publicText as part of the user-visible question output', async () => {
    const { puzzle, file } = await loadFixture();
    const original = file.cases.find(({ id }) => id === 'BOD-P01');
    if (!original) throw new Error('Expected BOD-P01 fixture');
    const publicText = puzzle.clues.find(({ id }) => id === 'projected-sky')?.publicText;
    if (!publicText) throw new Error('Expected projected-sky publicText');
    const item: EvaluationCase = {
      ...original,
      expected: { ...original.expected, forbiddenTexts: [publicText] },
    };
    const adapter = makeAdapter({
      answerQuestion: async (input) => ({
        judgment: 'yes',
        clueCandidates: [{ clueId: 'projected-sky', evidence: [{ messageId: input.currentMessage.id, quote: input.currentMessage.text }] }],
      }),
    });

    const result = await executeCase(puzzle, item, adapter);
    expect(result.actual?.userVisibleText).toContain(publicText);
    expect(result.forbiddenTextFindings).toEqual([publicText]);
    expect(result.outcome).toBe('mismatch');
  });
});

function makeReport(records: EvaluationRunReport['records']): EvaluationRunReport {
  return {
    schemaVersion: 1,
    mode: 'live',
    createdAt: '2026-10-20T00:00:00.000Z',
    puzzleId: 'beyond-the-dome',
    puzzleVersion: '1.0.0',
    model: 'test-model',
    promptVersion: 'hint-v1',
    split: 'all',
    rounds: 1,
    selectedCaseCount: records.length,
    records,
    note: 'program test only',
  };
}
