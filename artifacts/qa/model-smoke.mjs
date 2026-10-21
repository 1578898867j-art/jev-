import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadPuzzles } from '../../server/src/content.ts';
import { createOpenAiCompatibleAdapterFromEnv } from '../../server/src/ai/openai-compatible.ts';
import { executeCase, validateCaseFile } from '../../eval/run.ts';

const CASE_IDS = ['BOD-P01', 'BOD-P03', 'BOD-H01'];
const GLM_MODEL = 'ZHIPU/GLM-5.3-Flash';
const QWEN_MODEL = 'qwen3.8-flash';
const ALLOWED_MODELS = new Set([GLM_MODEL, QWEN_MODEL]);
const MAX_CALLS = 3;
const ALLOWED_REQUEST_PARAMETERS = [
  'model',
  'max_tokens',
  'max_completion_tokens',
  'enable_thinking',
  'reasoning_effort',
];

function assertTargetConfiguration(env) {
  if (!env.AI_API_KEY?.trim() || !env.AI_BASE_URL?.trim() || !env.AI_MODEL?.trim()) {
    throw new Error('CONFIG_MISSING');
  }

  const model = env.AI_MODEL.trim();
  if (!ALLOWED_MODELS.has(model)) {
    throw new Error('CONFIG_MODEL_NOT_ALLOWED');
  }

  let endpoint;
  try {
    endpoint = new URL(env.AI_BASE_URL.trim());
  } catch {
    throw new Error('CONFIG_ENDPOINT_INVALID');
  }

  const path = endpoint.pathname.replace(/\/+$/, '');
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || !endpoint.hostname.toLowerCase().endsWith('.cn-beijing.maas.aliyuncs.com')
    || endpoint.hostname.length <= '.cn-beijing.maas.aliyuncs.com'.length
    || path !== '/compatible-mode/v1'
  ) {
    throw new Error('CONFIG_ENDPOINT_NOT_ALLOWED');
  }
  return model;
}

function historicalReportPathFor(model, startedAt, suffix) {
  const stem = model === GLM_MODEL ? 'glm-smoke' : 'qwen-smoke';
  const timestamp = startedAt.replace(/[-:.]/g, '');
  const suffixText = suffix ? '-' + String(suffix).padStart(2, '0') : '';
  return fileURLToPath(new URL('./' + stem + '-' + timestamp + suffixText + '.json', import.meta.url));
}

async function writeRunReports(model, startedAt, report) {
  const serialized = JSON.stringify(report, null, 2) + '\n';
  let suffix = 0;
  while (true) {
    const uniquePath = historicalReportPathFor(model, startedAt, suffix);
    try {
      await writeFile(uniquePath, serialized, { encoding: 'utf8', flag: 'wx' });
      break;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }

  if (model === QWEN_MODEL) {
    const latestPath = fileURLToPath(new URL('./qwen-smoke.json', import.meta.url));
    await writeFile(latestPath, serialized, 'utf8');
  }
}

function extractRequestParameters(init) {
  if (!init || typeof init.body !== 'string') return null;

  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

  const parameters = {};
  for (const key of ALLOWED_REQUEST_PARAMETERS) {
    const value = body[key];
    if (key === 'model' && typeof value === 'string') parameters[key] = value;
    else if ((key === 'max_tokens' || key === 'max_completion_tokens')
      && typeof value === 'number' && Number.isFinite(value)) parameters[key] = value;
    else if (key === 'enable_thinking' && typeof value === 'boolean') parameters[key] = value;
    else if (key === 'reasoning_effort' && typeof value === 'string') parameters[key] = value;
  }
  return parameters;
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const usage = value;
  const fields = ['prompt_tokens', 'completion_tokens', 'total_tokens'];
  const captured = {};
  for (const field of fields) {
    if (typeof usage[field] === 'number' && Number.isFinite(usage[field])) {
      captured[field] = usage[field];
    }
  }
  return Object.keys(captured).length ? captured : null;
}

function extractMetadata(payload) {
  if (!payload || typeof payload !== 'object') {
    return { finishReason: null, usage: null };
  }
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const finishReason = choices[0]?.finish_reason;
  return {
    finishReason: typeof finishReason === 'string' ? finishReason : null,
    usage: safeUsage(payload.usage),
  };
}

async function main() {
  const model = assertTargetConfiguration(process.env);

  const puzzles = await loadPuzzles();
  const puzzle = puzzles.find((entry) => entry.id === 'beyond-the-dome');
  if (!puzzle) throw new Error('PUZZLE_NOT_FOUND');

  const rawCaseFile = JSON.parse(await readFile(
    new URL('../../eval/cases/beyond-the-dome.json', import.meta.url),
    'utf8',
  ));
  const caseFile = validateCaseFile(rawCaseFile, puzzle);
  const casesById = new Map(caseFile.cases.map((entry) => [entry.id, entry]));
  const cases = CASE_IDS.map((id) => casesById.get(id));
  if (cases.some((entry) => !entry || entry.split !== 'regression')) {
    throw new Error('CASE_SET_INVALID');
  }
  if (cases[0].action.type !== 'question' || cases[1].action.type !== 'question' || cases[2].action.type !== 'hint') {
    throw new Error('CASE_ACTIONS_INVALID');
  }

  const observations = [];
  let requestCount = 0;
  const fetchImpl = async (input, init) => {
    requestCount += 1;
    if (requestCount > MAX_CALLS) throw new Error('CALL_LIMIT_EXCEEDED');
    const startedAt = performance.now();
    const requestParameters = extractRequestParameters(init);
    try {
      if (!requestParameters || requestParameters.model !== model) {
        throw new Error('REQUEST_MODEL_MISMATCH');
      }
      const response = await fetch(input, init);
      let metadata = { finishReason: null, usage: null };
      try {
        const payload = await response.clone().json();
        metadata = extractMetadata(payload);
      } catch {
        // Metadata is optional; the original response remains available to the adapter.
      }
      observations.push({
        httpStatus: response.status,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
        finishReason: metadata.finishReason,
        usage: metadata.usage,
        requestParameters,
      });
      return response;
    } catch (error) {
      observations.push({
        httpStatus: null,
        elapsedMs: Number((performance.now() - startedAt).toFixed(2)),
        finishReason: null,
        usage: null,
        requestParameters,
      });
      throw error;
    }
  };

  const adapter = createOpenAiCompatibleAdapterFromEnv(process.env, {
    timeoutMs: 30_000,
    fetchImpl,
  });
  if (!adapter.configured) throw new Error('ADAPTER_NOT_CONFIGURED');

  const startedAt = new Date().toISOString();
  const results = [];
  for (const item of cases) {
    const callsBeforeCase = requestCount;
    const record = await executeCase(
      puzzle,
      item,
      adapter,
      1,
      model,
    );
    const observation = observations[observations.length - 1] ?? null;
    const callsForCase = requestCount - callsBeforeCase;
    results.push({
      caseId: record.caseId,
      split: record.split,
      category: record.category,
      promptVersion: record.promptVersion,
      contentVersion: record.contentVersion,
      action: record.action,
      history: record.history,
      expected: record.expected,
      actual: record.actual ?? null,
      outcome: record.outcome,
      errorCode: record.errorCode ?? null,
      elapsedMs: record.elapsedMs,
      requestCount: callsForCase,
      httpStatus: observation?.httpStatus ?? null,
      requestElapsedMs: observation?.elapsedMs ?? null,
      requestParameters: observation?.requestParameters ?? null,
      finishReason: observation?.finishReason ?? null,
      usage: observation?.usage ?? null,
      manualLeakageReviewRequired: record.manualLeakageReviewRequired,
      forbiddenTextFindings: record.forbiddenTextFindings ?? [],
    });

    const errorCode = record.errorCode ?? 'none';
    process.stdout.write(record.caseId + ' ' + record.outcome + ' ' + record.elapsedMs + 'ms ' + errorCode + '\n');
  }

  if (requestCount !== MAX_CALLS) throw new Error('CALL_COUNT_MISMATCH');

  const counts = results.reduce((summary, result) => {
    summary[result.outcome] += 1;
    return summary;
  }, { matched: 0, mismatch: 0, error: 0 });
  const status = results.length === CASE_IDS.length && counts.matched === CASE_IDS.length
    ? 'passed'
    : 'failed';

  const qaPromptVersion = results.find((result) => result.action.type === 'question')?.promptVersion ?? null;
  const hintPromptVersion = results.find((result) => result.action.type === 'hint')?.promptVersion ?? null;
  const report = {
    model,
    qaPromptVersion,
    hintPromptVersion,
    createdAt: new Date().toISOString(),
    startedAt,
    finishedAt: new Date().toISOString(),
    requestCount,
    timeoutMs: 30_000,
    status,
    counts,
    cases: results,
  };
  await mkdir(new URL('.', import.meta.url), { recursive: true });
  await writeRunReports(model, startedAt, report);
  if (status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'SMOKE_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});

