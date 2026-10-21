import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionResponse,
  ApiError,
  CreateSessionResponse,
  HintModelOutput,
  PuzzleDefinition,
  QuestionModelOutput,
  SessionView,
} from '@ai-turtle-soup/shared';
import { createApp } from '../../server/src/app.js';
import { createOpenAiCompatibleAdapter, createOpenAiCompatibleAdapterFromEnv } from '../../server/src/ai/openai-compatible.js';
import type { AiAdapter, HintModelInput, QuestionModelInput } from '../../server/src/ai/types.js';
import { loadPuzzles } from '../../server/src/content.js';
import { AppFault } from '../../server/src/errors.js';
import { WEB_DIST_DIRECTORY } from '../../server/src/paths.js';

const puzzle: PuzzleDefinition = {
  id: 'test-story',
  version: '1.0.0',
  title: '测试题',
  surface: '讲解员关掉灯，游客安静等待。',
  solution: '完整隐藏汤底。',
  clues: [
    {
      id: 'projector-source',
      kind: 'fact',
      required: true,
      meaning: '星图来自投影仪。',
      publicText: '星图来自投影仪。',
      positiveExamples: ['星图是投影的吗？', '星星由投影仪显示吗？'],
      negativeExamples: ['星图不是投影的？', '房间里有星星吗？'],
      hintAngles: [
        { id: 'source-a', direction: '考虑室内星点从哪里来。' },
        { id: 'source-b', direction: '区分真实天体和室内显示。' },
        { id: 'source-c', direction: '留意讲解员能控制什么。' },
      ],
    },
    {
      id: 'switch-for-viewing',
      kind: 'cause',
      required: true,
      meaning: '关闭投影是为了观看真实星空。',
      publicText: '关闭投影是为了观看真实星空。',
      positiveExamples: ['为了看真星星才关投影吗？', '关投影的目的是看真实夜空吗？'],
      negativeExamples: ['先看到星星所以关投影吗？', '投影关了，游客很安静。'],
      cause: { fromFactIds: ['projector-source'], toFactIds: ['real-sky-seen'] },
      hintAngles: [
        { id: 'purpose-a', direction: '思考讲解员操作的目的。' },
        { id: 'purpose-b', direction: '把关灯和游客要看的内容联系起来。' },
        { id: 'purpose-c', direction: '区分先后和因果。' },
      ],
    },
    {
      id: 'real-sky-seen',
      kind: 'fact',
      required: true,
      meaning: '游客最后看到了真实星空。',
      publicText: '游客最后看到了真实星空。',
      positiveExamples: ['游客看到了真正的星星吗？', '他们最后看见了真实夜空吗？'],
      negativeExamples: ['他们只看了投影吗？', '外面有星星吗？'],
      hintAngles: [
        { id: 'result-a', direction: '关注游客等待结束后实际看到的景象。' },
        { id: 'result-b', direction: '区分室内显示和外部景象。' },
        { id: 'result-c', direction: '考虑故事最后发生的观察结果。' },
      ],
    },
  ],
  source: { kind: 'original', note: '测试专用内容。' },
};

function responseForCandidate(input: QuestionModelInput, clueId: string, quote = input.currentMessage.text): QuestionModelOutput {
  return {
    judgment: 'yes',
    clueCandidates: [{ clueId, evidence: [{ messageId: input.currentMessage.id, quote }] }],
  };
}

function fakeAdapter(overrides: Partial<{
  configured: boolean;
  answerQuestion: (input: QuestionModelInput, options: { signal: AbortSignal }) => Promise<QuestionModelOutput>;
  createHint: (input: HintModelInput, options: { signal: AbortSignal }) => Promise<HintModelOutput>;
}> = {}): AiAdapter & { questionCalls: QuestionModelInput[]; hintCalls: HintModelInput[] } {
  const questionCalls: QuestionModelInput[] = [];
  const hintCalls: HintModelInput[] = [];
  return {
    configured: overrides.configured ?? true,
    questionCalls,
    hintCalls,
    async answerQuestion(input, callOptions) {
      questionCalls.push(input);
      if (overrides.answerQuestion) return overrides.answerQuestion(input, callOptions);
      return { judgment: 'no', clueCandidates: [] };
    },
    async createHint(input, callOptions) {
      hintCalls.push(input);
      if (overrides.createHint) return overrides.createHint(input, callOptions);
      const angle = input.availableAngles[0];
      return { targetClueId: angle.clueId, angleId: angle.angleId, text: `提示${input.hintsUsed + 1}` };
    },
  };
}

interface Harness {
  server: Server;
  baseUrl: string;
}

type SessionResponse = { session: SessionView };
type HealthResponse = { status: 'ok'; ai: { configured: boolean } };

async function startHarness(ai: AiAdapter = fakeAdapter(), staticWebDir?: string): Promise<Harness> {
  const server = createServer(createApp({ puzzles: [puzzle], ai, ...(staticWebDir ? { staticWebDir } : {}) }));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopHarness(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function callJson<T>(
  harness: Harness,
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  return { status: response.status, body: await response.json() as T };
}

async function createGame(harness: Harness): Promise<{ id: string; token: string }> {
  const result = await callJson<CreateSessionResponse>(harness, '/api/sessions', {
    method: 'POST',
    body: { puzzleId: puzzle.id },
  });
  expect(result.status).toBe(201);
  return { id: result.body.session.id, token: result.body.sessionToken };
}

function questionBody(requestId: string, expectedRevision: number, text: string) {
  return { requestId, expectedRevision, text };
}

describe('server API and state transitions', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopHarness));
  });

  async function harnessWith(ai: AiAdapter = fakeAdapter(), staticWebDir?: string): Promise<Harness> {
    const harness = await startHarness(ai, staticWebDir);
    servers.push(harness.server);
    return harness;
  }

  it('loads all puzzle JSON and only exposes explicit public projections', async () => {
    const loaded = await loadPuzzles();
    expect(loaded.length).toBeGreaterThan(0);
    const harness = await harnessWith();
    const listed = await callJson<{ puzzles: unknown[] }>(harness, '/api/puzzles');
    const listedJson = JSON.stringify(listed.body);
    expect(listedJson).not.toContain('solution');
    expect(listedJson).not.toContain('clues');
    expect(listedJson).not.toContain('projector-source');
    expect(listedJson).not.toContain('meaning');
    expect(listedJson).not.toContain('hintAngles');

    const preflight = await fetch(`${harness.baseUrl}/api/sessions/example`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBe('https://localhost');
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(preflight.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    const rejectedPreflight = await fetch(`${harness.baseUrl}/api/sessions/example`, {
      method: 'OPTIONS', headers: { Origin: 'https://unlisted.example', 'Access-Control-Request-Method': 'POST' },
    });
    expect(rejectedPreflight.status).toBe(403);
    expect(rejectedPreflight.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const game = await createGame(harness);
    const created = await callJson<{ session: { puzzle: object; solution?: unknown } }>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(created.status).toBe(200);
    expect(JSON.stringify(created.body)).not.toContain('solution');
    expect(JSON.stringify(created.body)).not.toContain('projector-source');
    expect(created.body.session.puzzle).toEqual({
      id: puzzle.id,
      version: puzzle.version,
      title: puzzle.title,
      surface: puzzle.surface,
      requiredClueCount: 3,
    });
  });

  it('serves only the configured Web build directory after the API routes', async () => {
    expect(basename(resolve(WEB_DIST_DIRECTORY))).toBe('dist');
    expect(basename(dirname(resolve(WEB_DIST_DIRECTORY)))).toBe('web');
    const webDist = await mkdtemp(join(tmpdir(), 'turtle-soup-web-dist-'));
    await mkdir(join(webDist, 'assets'));
    await mkdir(join(webDist, 'api'));
    await writeFile(join(webDist, 'index.html'), '<main>built client</main>');
    await writeFile(join(webDist, 'assets', 'app.js'), 'window.clientReady = true;');
    await writeFile(join(webDist, 'api', 'health'), 'must not shadow the API');
    try {
      const harness = await harnessWith(fakeAdapter(), webDist);
      const page = await fetch(`${harness.baseUrl}/`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('built client');
      const asset = await fetch(`${harness.baseUrl}/assets/app.js`);
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain('clientReady');

      const health = await callJson<HealthResponse>(harness, '/api/health');
      expect(health.body.status).toBe('ok');
      expect(JSON.stringify(health.body)).not.toContain('shadow');
      for (const privatePath of [
        '/content/puzzles/beyond-the-dome.json',
        '/eval/cases/first-puzzle-cases-draft.md',
        '/server/src/index.ts',
        '/README.md',
      ]) {
        const response = await fetch(`${harness.baseUrl}${privatePath}`);
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('完整隐藏汤底');
      }
    } finally {
      await rm(webDist, { recursive: true, force: true });
    }
  });

  it('keeps incomplete progress playing, unlocks only after all clues, and completes only on reveal', async () => {
    let questionIndex = 0;
    const ai = fakeAdapter({ answerQuestion: async (input) => {
      questionIndex += 1;
      const clues = ['projector-source', 'real-sky-seen', 'switch-for-viewing'];
      return responseForCandidate(input, clues[questionIndex - 1]);
    } });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const firstRequest = crypto.randomUUID();
    const first = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(firstRequest, 0, '星图是投影的吗？'),
    });
    expect(first.status).toBe(200);
    expect(first.body.session.status).toBe('playing');
    expect(first.body.session.discoveredClues).toHaveLength(1);
    expect(first.body.session.solution).toBeUndefined();

    const replay = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(firstRequest, 0, '星图是投影的吗？'),
    });
    expect(replay.body).toEqual(first.body);
    expect(ai.questionCalls).toHaveLength(1);

    const conflictingReplay = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(firstRequest, 0, '不同问题'),
    });
    expect(conflictingReplay.status).toBe(409);
    expect(conflictingReplay.body.error.code).toBe('REQUEST_ID_REUSED');

    const secondRequest = crypto.randomUUID();
    const second = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(secondRequest, 1, '为了看真的星星关了灯吗？'),
    });
    expect(second.body.session.status).toBe('playing');
    expect(second.body.session.solution).toBeUndefined();
    expect(second.body.session.discoveredClues).toHaveLength(2);

    const thirdRequest = crypto.randomUUID();
    const third = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(thirdRequest, 2, '为了看真的星星关了灯吗？'),
    });
    expect(third.body.session.status).toBe('unlocked');
    expect(third.body.session.solution).toBeUndefined();
    expect(third.body.session.discoveredClues).toHaveLength(3);

    const blockedQuestion = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(crypto.randomUUID(), 3, '还有问题'),
    });
    expect(blockedQuestion.status).toBe(409);
    expect(blockedQuestion.body.error.code).toBe('ACTION_NOT_ALLOWED');
    expect(ai.questionCalls).toHaveLength(3);

    const reveal = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/reveal`, {
      method: 'POST', token: game.token, body: { requestId: crypto.randomUUID(), expectedRevision: 3 },
    });
    expect(reveal.body.session.status).toBe('completed');
    expect(reveal.body.session.solution?.text).toBe(puzzle.solution);
  });

  it('deduplicates repeated clue hits without adding a second progress item', async () => {
    const ai = fakeAdapter({ answerQuestion: async (input) => responseForCandidate(input, 'projector-source') });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    for (const revision of [0, 1]) {
      const result = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
        method: 'POST', token: game.token,
        body: questionBody(crypto.randomUUID(), revision, '投影仪显示了星星吗？'),
      });
      expect(result.body.session.status).toBe('playing');
      expect(result.body.session.discoveredClues).toHaveLength(1);
    }
  });

  it('rolls back every candidate and message when any candidate evidence is invalid', async () => {
    const ai = fakeAdapter({ answerQuestion: async (input) => ({
      judgment: 'yes',
      clueCandidates: [
        { clueId: 'projector-source', evidence: [{ messageId: input.currentMessage.id, quote: input.currentMessage.text }] },
        { clueId: 'switch-for-viewing', evidence: [{ messageId: input.currentMessage.id, quote: 'not in the player message' }] },
      ],
    }) });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const result = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(crypto.randomUUID(), 0, '星图来自投影吗？'),
    });
    expect(result.status).toBe(502);
    expect(result.body.error.code).toBe('INVALID_MODEL_OUTPUT');
    const current = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(current.body.session.revision).toBe(0);
    expect(current.body.session.messages).toEqual([]);
    expect(current.body.session.discoveredClues).toEqual([]);
  });

  it('rejects hint messages as player evidence and leaves the attempted question uncommitted', async () => {
    const ai = fakeAdapter({ answerQuestion: async (input) => ({
      judgment: 'yes',
      clueCandidates: [{ clueId: 'projector-source', evidence: [{ messageId: input.history.at(-1)!.id, quote: input.history.at(-1)!.text }] }],
    }) });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const hint = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/hints`, {
      method: 'POST', token: game.token, body: { requestId: crypto.randomUUID(), expectedRevision: 0 },
    });
    expect(hint.body.session.hintsUsed).toBe(1);
    expect(hint.body.session.messages.at(-1)?.role).toBe('hint');
    const result = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(crypto.randomUUID(), 1, '我自己的问题'),
    });
    expect(result.status).toBe(502);
    const current = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(current.body.session.revision).toBe(1);
    expect(current.body.session.hintsUsed).toBe(1);
    expect(current.body.session.messages).toHaveLength(1);
    expect(current.body.session.discoveredClues).toEqual([]);
  });

  it('does not consume hints on failure and allows a retry with the same request ID', async () => {
    let shouldFail = true;
    const ai = fakeAdapter({ createHint: async (input) => {
      if (shouldFail) throw new AppFault('AI_UNAVAILABLE');
      const angle = input.availableAngles[0];
      return { targetClueId: angle.clueId, angleId: angle.angleId, text: '試着想想室內星點的來源。' };
    } });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const requestId = crypto.randomUUID();
    const body = { requestId, expectedRevision: 0 };
    const failed = await callJson<ApiError>(harness, `/api/sessions/${game.id}/hints`, { method: 'POST', token: game.token, body });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('AI_UNAVAILABLE');
    expect(failed.body.error.retryable).toBe(true);
    expect(JSON.stringify(failed.body)).not.toContain('vendor details');
    const unchanged = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(unchanged.body.session.revision).toBe(0);
    expect(unchanged.body.session.hintsUsed).toBe(0);
    expect(unchanged.body.session.messages).toEqual([]);

    shouldFail = false;
    const retried = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/hints`, { method: 'POST', token: game.token, body });
    expect(retried.status).toBe(200);
    expect(retried.body.session.revision).toBe(1);
    expect(retried.body.session.hintsUsed).toBe(1);
    expect(ai.hintCalls).toHaveLength(2);
  });

  it('keeps the original fingerprint after an AI failure, rejects changed input, and allows an exact retry', async () => {
    let shouldFail = true;
    const ai = fakeAdapter({ answerQuestion: async () => {
      if (shouldFail) throw new AppFault('AI_UNAVAILABLE');
      return { judgment: 'no', clueCandidates: [] };
    } });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const requestId = crypto.randomUUID();
    const original = questionBody(requestId, 0, '原始问题');
    const failed = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: original,
    });
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('AI_UNAVAILABLE');

    const changed = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(requestId, 0, '更换后的问题'),
    });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('REQUEST_ID_REUSED');
    expect(ai.questionCalls).toHaveLength(1);

    shouldFail = false;
    const retried = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: original,
    });
    expect(retried.status).toBe(200);
    expect(retried.body.session.revision).toBe(1);
    expect(ai.questionCalls).toHaveLength(2);
  });

  it('uses only three hints and rejects a fourth before calling the adapter', async () => {
    const ai = fakeAdapter();
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    let revision = 0;
    for (let index = 0; index < 3; index += 1) {
      const result = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/hints`, {
        method: 'POST', token: game.token,
        body: { requestId: crypto.randomUUID(), expectedRevision: revision },
      });
      expect(result.status).toBe(200);
      revision = result.body.session.revision;
    }
    expect(ai.hintCalls).toHaveLength(3);
    const fourth = await callJson<ApiError>(harness, `/api/sessions/${game.id}/hints`, {
      method: 'POST', token: game.token,
      body: { requestId: crypto.randomUUID(), expectedRevision: revision },
    });
    expect(fourth.status).toBe(409);
    expect(fourth.body.error.code).toBe('HINT_LIMIT_REACHED');
    expect(ai.hintCalls).toHaveLength(3);
  });

  it('shares an in-flight result for the same request and rejects a different concurrent action', async () => {
    let started!: () => void;
    let resolveQuestion!: (value: QuestionModelOutput) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const ai = fakeAdapter({ answerQuestion: (input) => {
      started();
      return new Promise((resolve) => { resolveQuestion = resolve; });
    } });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const requestId = crypto.randomUUID();
    const body = questionBody(requestId, 0, '我想问这个问题');
    const firstPromise = callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, { method: 'POST', token: game.token, body });
    await startedPromise;
    const replayPromise = callJson<ActionResponse>(harness, `/api/sessions/${game.id}/questions`, { method: 'POST', token: game.token, body });
    const other = await callJson<ApiError>(harness, `/api/sessions/${game.id}/hints`, {
      method: 'POST', token: game.token, body: { requestId: crypto.randomUUID(), expectedRevision: 0 },
    });
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe('SESSION_BUSY');
    expect(ai.hintCalls).toHaveLength(0);
    resolveQuestion({ judgment: 'no', clueCandidates: [] });
    const [first, replay] = await Promise.all([firstPromise, replayPromise]);
    expect(first.body).toEqual(replay.body);
    expect(first.body.session.revision).toBe(1);
    expect(ai.questionCalls).toHaveLength(1);
  });

  it.each([
    { action: 'give-up', status: 'given_up', expectsSolution: true },
    { action: 'leave', status: 'left', expectsSolution: false },
  ] as const)('cancels a late question result when the player uses $action', async ({ action, status, expectsSolution }) => {
    let started!: () => void;
    let resolveQuestion!: (value: QuestionModelOutput) => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const ai = fakeAdapter({ answerQuestion: () => {
      started();
      return new Promise((resolve) => { resolveQuestion = resolve; });
    } });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const questionPromise = callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(crypto.randomUUID(), 0, '一个迟到的问题'),
    });
    await startedPromise;
    const ended = await callJson<ActionResponse>(harness, `/api/sessions/${game.id}/${action}`, {
      method: 'POST', token: game.token, body: { requestId: crypto.randomUUID(), expectedRevision: 0 },
    });
    expect(ended.body.session.status).toBe(status);
    expect(Boolean(ended.body.session.solution)).toBe(expectsSolution);
    const cancelled = await questionPromise;
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe('OPERATION_CANCELLED');
    resolveQuestion({
      judgment: 'yes',
      clueCandidates: [{ clueId: 'projector-source', evidence: [{ messageId: ai.questionCalls[0].currentMessage.id, quote: '一个迟到的问题' }] }],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(current.body.session.status).toBe(status);
    expect(current.body.session.revision).toBe(1);
    expect(current.body.session.messages).toEqual([]);
    expect(Boolean(current.body.session.solution)).toBe(expectsSolution);
  });

  it('reports missing AI configuration as a hard state without changing progress', async () => {
    const ai = fakeAdapter({ configured: false });
    const harness = await harnessWith(ai);
    const health = await callJson<HealthResponse>(harness, '/api/health');
    expect(health.body).toEqual({ status: 'ok', ai: { configured: false } });
    const game = await createGame(harness);
    const question = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token, body: questionBody(crypto.randomUUID(), 0, '问题'),
    });
    expect(question.status).toBe(503);
    expect(question.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(ai.questionCalls).toHaveLength(0);
    const current = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(current.body.session.revision).toBe(0);
    expect(current.body.session.hintsUsed).toBe(0);
  });

  it('does not commit progress when a GLM response misses its request deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      const delayedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error('response body aborted')), { once: true });
        },
      });
      return new Response(delayedBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const ai = createOpenAiCompatibleAdapter({
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'ZHIPU/GLM-5.3-Flash',
      apiKey: 'test-key',
    }, { fetchImpl, timeoutMs: 25 });
    const harness = await harnessWith(ai);
    const game = await createGame(harness);
    const failed = await callJson<ApiError>(harness, `/api/sessions/${game.id}/questions`, {
      method: 'POST', token: game.token,
      body: questionBody(crypto.randomUUID(), 0, '一个超时问题'),
    });
    expect(failed.status).toBe(504);
    expect(failed.body.error.code).toBe('AI_TIMEOUT');

    const current = await callJson<SessionResponse>(harness, `/api/sessions/${game.id}`, { token: game.token });
    expect(current.body.session.revision).toBe(0);
    expect(current.body.session.messages).toEqual([]);
    expect(current.body.session.discoveredClues).toEqual([]);
  });
});

describe('OpenAI-compatible adapter', () => {
  it.each([undefined, 'disabled'] as const)('uses Qwen non-thinking mode when AI_THINKING is %s', async (thinking) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
      apiKey: 'test-key',
      ...(thinking ? { thinking } : {}),
    }, { fetchImpl, ...(thinking ? { maxTokens: 1_536 } : {}) });
    await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '检查非推理参数。' },
    }, { signal: new AbortController().signal });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody.max_completion_tokens).toBe(thinking ? 1_536 : 2_048);
    expect(requestBody).not.toHaveProperty('max_tokens');
    expect(requestBody.enable_thinking).toBe(false);
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody).not.toHaveProperty('thinking_budget');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('enables Qwen thinking at low effort only when explicitly requested', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
      apiKey: 'test-key',
      thinking: 'enabled',
    }, { fetchImpl, maxTokens: 1_024 });
    await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '检查推理参数。' },
    }, { signal: new AbortController().signal });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody.max_completion_tokens).toBe(1_024);
    expect(requestBody).not.toHaveProperty('max_tokens');
    expect(requestBody.enable_thinking).toBe(true);
    expect(requestBody.reasoning_effort).toBe('low');
    expect(requestBody).not.toHaveProperty('thinking_budget');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it.each([
    {
      baseUrl: 'https://fixture.us-east-1.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
    },
    {
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/not-compatible/v1',
      model: 'qwen3.8-flash',
    },
    {
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash-preview',
    },
    {
      baseUrl: 'http://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
    },
  ])('does not apply Qwen profile settings when host, path, or model differs', async ({ baseUrl, model }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl, model, apiKey: 'test-key', thinking: 'enabled' }, { fetchImpl });
    await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '检查 profile 边界。' },
    }, { signal: new AbortController().signal });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody.max_tokens).toBe(2_048);
    expect(requestBody).not.toHaveProperty('max_completion_tokens');
    expect(requestBody).not.toHaveProperty('enable_thinking');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody).not.toHaveProperty('thinking_budget');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('uses only the confirmed Beijing GLM profile settings for its exact host and model', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'ZHIPU/GLM-5.3-Flash',
      apiKey: 'test-key',
      thinking: 'enabled',
    }, { fetchImpl });
    const output = await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '這是百炼兼容接口的测试问题吗？' },
    }, { signal: new AbortController().signal });
    expect(output).toEqual({ judgment: 'no', clueCandidates: [] });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions');
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody).toMatchObject({
      model: 'ZHIPU/GLM-5.3-Flash',
      max_tokens: 8_192,
      enable_thinking: true,
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    });
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('rejects disabled thinking locally for the confirmed GLM profile', () => {
    expect(() => createOpenAiCompatibleAdapterFromEnv({
      AI_BASE_URL: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      AI_MODEL: 'ZHIPU/GLM-5.3-Flash',
      AI_API_KEY: 'test-key',
      AI_THINKING: 'disabled',
    })).toThrow('AI_THINKING=disabled');
  });

  it.each([
    {
      baseUrl: 'https://fixture.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'glm-5.3-flash',
    },
    {
      baseUrl: 'https://api.example.test/v1',
      model: 'ZHIPU/GLM-5.3-Flash',
    },
  ])('does not apply GLM-only settings unless both the confirmed profile and exact model match', async ({ baseUrl, model }) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({ baseUrl, model, apiKey: 'test-key' }, { fetchImpl });
    await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '普通兼容端点的测试问题。' },
    }, { signal: new AbortController().signal });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody.max_tokens).toBe(2_048);
    expect(requestBody).not.toHaveProperty('enable_thinking');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(requestBody).not.toHaveProperty('thinking');
  });

  it('joins a /v1 base URL correctly and requests a JSON object response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.deepseek.com/v1/', model: 'test-model', apiKey: 'test-key',
    }, { fetchImpl });
    const output = await adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '這是一個測試問題嗎？' },
    }, { signal: new AbortController().signal });
    expect(output).toEqual({ judgment: 'no', clueCandidates: [] });
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.deepseek.com/v1/chat/completions');
    const init = fetchImpl.mock.calls[0][1];
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    expect(JSON.parse(String(init?.body)).response_format).toEqual({ type: 'json_object' });
    const requestBody = JSON.parse(String(init?.body));
    expect(requestBody.max_tokens).toBe(2_048);
    expect(requestBody.thinking).toEqual({ type: 'disabled' });
    expect(requestBody).not.toHaveProperty('enable_thinking');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
  });

  it('fails on empty model content and never invents a response', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.test', model: 'test-model', apiKey: 'test-key',
    }, { fetchImpl });
    await expect(adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '问题' },
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
  });

  it('classifies a timeout while reading the response body as AI_TIMEOUT', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      const delayedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          signal.addEventListener('abort', () => controller.error(new Error('response body aborted')), { once: true });
        },
      });
      return new Response(delayedBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.test', model: 'test-model', apiKey: 'test-key',
    }, { fetchImpl, timeoutMs: 25 });
    await expect(adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '问题' },
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'AI_TIMEOUT' });
  });

  it('sends DeepSeek thinking overrides only to the DeepSeek origin and rejects truncated output', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ judgment: 'no', clueCandidates: [] }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: 'https://api.example.test/v1', model: 'test-model', apiKey: 'test-key', thinking: 'enabled',
    }, { fetchImpl });
    await expect(adapter.answerQuestion({
      puzzle,
      history: [],
      discoveredClueIds: [],
      currentMessage: { id: crypto.randomUUID(), text: '問題' },
    }, { signal: new AbortController().signal })).rejects.toMatchObject({ code: 'INVALID_MODEL_OUTPUT' });
    const requestBody = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body));
    expect(requestBody).not.toHaveProperty('thinking');
    expect(requestBody).not.toHaveProperty('enable_thinking');
    expect(requestBody).not.toHaveProperty('reasoning_effort');
    expect(() => createOpenAiCompatibleAdapter({ thinking: 'sometimes' })).toThrow('AI_THINKING');
  });
});
