// Temperature comparison:
// node --env-file-if-exists=.env --import tsx artifacts/qa/sampling-comparison.mjs
// Thinking comparison:
// node --env-file-if-exists=.env --import tsx artifacts/qa/sampling-comparison.mjs --thinking
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { loadPuzzles } from '../../server/src/content.ts';
import { createOpenAiCompatibleAdapterFromEnv } from '../../server/src/ai/openai-compatible.ts';
import { QA_PROMPT_VERSION } from '../../server/src/ai/prompts.ts';
import { executeCase, validateCaseFile } from '../../eval/run.ts';

const CASE_IDS = ['BOD-C01', 'BOD-C02', 'BOD-C07'];
const MODEL = 'qwen3.8-flash';
const PROMPT_VERSION = 'qa-v5';
const BUDGET = 2_048;
const TIMEOUT_MS = 30_000;
const ROUNDS = 2;
const MAX_CALLS = CASE_IDS.length * 2 * ROUNDS;
const MODE_TEMPERATURE = 'temperature';
const MODE_THINKING = 'thinking';
const OMITTED = 'temperature_omitted';
const ZERO = 'temperature_0';
const THINKING_DISABLED = 'thinking_disabled';
const THINKING_ENABLED_LOW = 'thinking_enabled_low';
const OFFICIAL_SOURCE = 'https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions';

const MODE_CONFIG = {
  [MODE_TEMPERATURE]: {
    experiment: 'temperature-omitted-vs-zero',
    reportPrefix: 'sampling-comparison',
    conditions: [
      { id: OMITTED, temperature: 'omitted', thinking: 'disabled' },
      { id: ZERO, temperature: 0, thinking: 'disabled' },
    ],
    limitations: [
      'The omitted-temperature condition delegates to the provider default, which may change over time.',
      'This two-round comparison over three fixed regression cases does not establish absolute reproducibility or general model quality.',
    ],
  },
  [MODE_THINKING]: {
    experiment: 'thinking-disabled-vs-enabled-low',
    reportPrefix: 'thinking-comparison',
    conditions: [
      { id: THINKING_DISABLED, envThinking: 'disabled', enableThinking: false, temperature: 'omitted' },
      { id: THINKING_ENABLED_LOW, envThinking: 'enabled', enableThinking: true, reasoningEffort: 'low', temperature: 'omitted' },
    ],
    limitations: [
      'Both conditions omit temperature and top_p, so the provider default remains unpinned.',
      'The enabled condition requests reasoning_effort=low with the same 2048 completion budget; truncation, empty output, invalid output, and timeout remain failures.',
      'This two-round comparison over three fixed regression cases does not establish absolute reproducibility or general model quality.',
    ],
  },
};

function parseMode(args) {
  if (args.length === 0) return MODE_TEMPERATURE;
  if (args.length === 1 && args[0] === '--thinking') return MODE_THINKING;
  throw new Error('USAGE');
}

function assertTargetConfiguration(env, mode) {
  if (!env.AI_API_KEY?.trim() || !env.AI_BASE_URL?.trim() || !env.AI_MODEL?.trim()) {
    throw new Error('CONFIG_MISSING');
  }
  if (env.AI_MODEL.trim() !== MODEL) throw new Error('CONFIG_MODEL_NOT_ALLOWED');

  if (mode === MODE_TEMPERATURE) {
    const thinking = env.AI_THINKING?.trim();
    if (thinking && thinking !== 'disabled') throw new Error('CONFIG_THINKING_NOT_DISABLED');
  }

  let baseUrl;
  try {
    baseUrl = new URL(env.AI_BASE_URL.trim());
  } catch {
    throw new Error('CONFIG_ENDPOINT_INVALID');
  }

  const path = baseUrl.pathname.replace(/\/+$/, '');
  const host = baseUrl.hostname.toLowerCase();
  const suffix = '.cn-beijing.maas.aliyuncs.com';
  if (
    baseUrl.protocol !== 'https:'
    || baseUrl.username
    || baseUrl.password
    || baseUrl.port
    || baseUrl.search
    || baseUrl.hash
    || !host.endsWith(suffix)
    || host.length <= suffix.length
    || path !== '/compatible-mode/v1'
  ) {
    throw new Error('CONFIG_ENDPOINT_NOT_ALLOWED');
  }

  return { model: MODEL, baseUrl };
}

function assertRequestTarget(input, target) {
  let requestUrl;
  try {
    if (input instanceof URL) requestUrl = new URL(input.href);
    else if (input && typeof input === 'object' && typeof input.url === 'string') {
      requestUrl = new URL(input.url);
    } else requestUrl = new URL(input);
  } catch {
    throw new Error('REQUEST_TARGET_INVALID');
  }

  const expected = new URL('/compatible-mode/v1/chat/completions', target.baseUrl.origin);
  if (requestUrl.href !== expected.href) throw new Error('REQUEST_TARGET_NOT_ALLOWED');
}

function inspectRequestBody(init, condition, mode) {
  if (!init || typeof init.body !== 'string') throw new Error('REQUEST_BODY_INVALID');

  let body;
  try {
    body = JSON.parse(init.body);
  } catch {
    throw new Error('REQUEST_BODY_INVALID');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('REQUEST_BODY_INVALID');
  }

  const enabledLow = mode === MODE_THINKING && condition === THINKING_ENABLED_LOW;
  const expectedKeys = ['enable_thinking', 'max_completion_tokens', 'messages', 'model', 'response_format'];
  if (enabledLow) expectedKeys.push('reasoning_effort');
  expectedKeys.sort();
  if (Object.keys(body).sort().join('|') !== expectedKeys.join('|')) {
    throw new Error('REQUEST_PARAMETERS_NOT_ALLOWED');
  }
  if (
    body.model !== MODEL
    || body.max_completion_tokens !== BUDGET
    || body.enable_thinking !== (mode === MODE_THINKING ? enabledLow : false)
    || !Array.isArray(body.messages)
    || body.messages.length !== 2
    || body.messages[0]?.role !== 'system'
    || body.messages[1]?.role !== 'user'
    || body.response_format?.type !== 'json_object'
    || (enabledLow && body.reasoning_effort !== 'low')
  ) {
    throw new Error('REQUEST_CONFIGURATION_MISMATCH');
  }

  const requestParameters = {
    model: body.model,
    max_completion_tokens: body.max_completion_tokens,
    enable_thinking: body.enable_thinking,
  };
  if (mode === MODE_TEMPERATURE && condition === ZERO) {
    if (Object.hasOwn(body, 'temperature')) throw new Error('REQUEST_TEMPERATURE_ALREADY_SET');
    requestParameters.temperature = 0;
  }
  if (enabledLow) requestParameters.reasoning_effort = body.reasoning_effort;
  return { body, requestParameters, injectTemperature: mode === MODE_TEMPERATURE && condition === ZERO };
}

function safeUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const captured = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (Number.isSafeInteger(value[field]) && value[field] >= 0) captured[field] = value[field];
  }
  return Object.keys(captured).length ? captured : null;
}

function extractResponseDiagnostics(payload) {
  if (!payload || typeof payload !== 'object') {
    return { usage: null, truncated: null, emptyContent: null };
  }
  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = choice?.message?.content;
  return {
    usage: safeUsage(payload.usage),
    truncated: choice?.finish_reason === 'length',
    emptyContent: typeof content === 'string' ? content.trim().length === 0 : null,
  };
}

function buildSchedule(cases, conditions) {
  const schedule = [];
  for (const item of cases) {
    schedule.push({ item, round: 1, condition: conditions[0].id });
    schedule.push({ item, round: 1, condition: conditions[1].id });
    schedule.push({ item, round: 2, condition: conditions[1].id });
    schedule.push({ item, round: 2, condition: conditions[0].id });
  }
  if (schedule.length > MAX_CALLS) throw new Error('SCHEDULE_EXCEEDS_CALL_LIMIT');
  return schedule;
}

function publicResult(record, observation, condition, round) {
  const actual = record.actual;
  const expected = record.expected;
  const errorCode = record.errorCode ?? null;
  return {
    caseId: record.caseId,
    condition,
    round,
    outcome: record.outcome,
    strictOutputValidated: Boolean(actual),
    expected: {
      judgment: expected.judgment ?? null,
      addedClueIds: [...expected.addedClueIds],
      status: expected.status,
    },
    judgment: actual?.judgment ?? null,
    addedClueIds: actual ? [...actual.addedClueIds] : [],
    status: actual?.status ?? null,
    errorCode: typeof errorCode === 'string' && /^[A-Z0-9_]+$/.test(errorCode) ? errorCode : null,
    elapsedMs: record.elapsedMs,
    httpStatus: observation?.httpStatus ?? null,
    requestElapsedMs: observation?.requestElapsedMs ?? null,
    requestParameters: observation?.requestParameters ?? null,
    truncated: observation?.truncated ?? null,
    emptyContent: observation?.emptyContent ?? null,
    usage: safeUsage(record.usage),
  };
}

function sumUsage(records) {
  const totals = {};
  for (const field of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    const values = records.map((record) => record.usage?.[field]).filter(Number.isSafeInteger);
    totals[field] = {
      total: values.length === records.length ? values.reduce((sum, value) => sum + value, 0) : null,
      observations: values.length,
    };
  }
  return totals;
}

function summarize(results, modeConfig) {
  const conditions = {};
  for (const condition of modeConfig.conditions) {
    const records = results.filter((record) => record.condition === condition.id);
    const counts = { matched: 0, mismatch: 0, error: 0 };
    for (const record of records) counts[record.outcome] += 1;
    const judgmentRecords = records.filter((record) => record.expected.judgment !== null);
    conditions[condition.id] = {
      executions: records.length,
      counts,
      matchRate: records.length ? counts.matched / records.length : null,
      judgmentCorrect: judgmentRecords.filter((record) => record.judgment === record.expected.judgment).length,
      judgmentTotal: judgmentRecords.length,
      errorCounts: {
        timeouts: records.filter((record) => record.errorCode === 'AI_TIMEOUT').length,
        invalidModelOutput: records.filter((record) => record.errorCode === 'INVALID_MODEL_OUTPUT').length,
        truncatedOutputs: records.filter((record) => record.truncated === true && record.outcome === 'error').length,
        emptyOutputs: records.filter((record) => record.emptyContent === true && record.outcome === 'error').length,
        other: records.filter((record) => record.outcome === 'error'
          && record.errorCode !== 'AI_TIMEOUT'
          && record.errorCode !== 'INVALID_MODEL_OUTPUT').length,
      },
      usageTotals: sumUsage(records),
    };
  }

  const paired = [];
  for (const caseId of CASE_IDS) {
    for (let round = 1; round <= ROUNDS; round += 1) {
      const left = results.find((record) => record.caseId === caseId && record.round === round
        && record.condition === modeConfig.conditions[0].id);
      const right = results.find((record) => record.caseId === caseId && record.round === round
        && record.condition === modeConfig.conditions[1].id);
      if (!left || !right) continue;
      const semanticOutput = (record) => JSON.stringify({
        outcome: record.outcome,
        judgment: record.judgment,
        addedClueIds: [...record.addedClueIds].sort(),
        status: record.status,
        errorCode: record.errorCode,
      });
      paired.push({
        caseId,
        round,
        equivalentResult: semanticOutput(left) === semanticOutput(right),
      });
    }
  }

  const counts = { matched: 0, mismatch: 0, error: 0 };
  for (const record of results) counts[record.outcome] += 1;
  return { executions: results.length, counts, conditions, paired };
}

function reportPathFor(startedAt, suffix, prefix) {
  const timestamp = startedAt.replace(/[-:.]/g, '');
  const disambiguator = suffix ? `-${String(suffix).padStart(2, '0')}` : '';
  return fileURLToPath(new URL(`./${prefix}-${timestamp}${disambiguator}.json`, import.meta.url));
}

async function writeImmutableReport(startedAt, report, prefix) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  let suffix = 0;
  while (true) {
    const path = reportPathFor(startedAt, suffix, prefix);
    try {
      await writeFile(path, serialized, { encoding: 'utf8', flag: 'wx' });
      return path;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        suffix += 1;
        continue;
      }
      throw error;
    }
  }
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const modeConfig = MODE_CONFIG[mode];
  if (QA_PROMPT_VERSION !== PROMPT_VERSION) throw new Error('PROMPT_VERSION_NOT_FROZEN');
  const target = assertTargetConfiguration(process.env, mode);

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
  if (cases.some((item) => !item || item.split !== 'regression')) {
    throw new Error('CASE_SET_NOT_PROMOTED_TO_REGRESSION');
  }
  if (cases.some((item) => item.action.type !== 'question')) {
    throw new Error('CASE_ACTIONS_NOT_QUESTION');
  }

  const schedule = buildSchedule(cases, modeConfig.conditions);
  const observations = [];
  let requestCount = 0;
  let currentCondition = null;
  let currentUsage = null;

  const usageCapture = {
    read: () => currentUsage,
    clear: () => { currentUsage = null; },
  };

  const fetchImpl = async (input, init) => {
    const started = performance.now();
    const observation = {
      httpStatus: null,
      requestElapsedMs: null,
      requestParameters: null,
      truncated: null,
      emptyContent: null,
    };
    try {
      if (requestCount >= MAX_CALLS) throw new Error('CALL_LIMIT_EXCEEDED');
      assertRequestTarget(input, target);
      const { body, requestParameters, injectTemperature } = inspectRequestBody(init, currentCondition, mode);
      observation.requestParameters = requestParameters;

      let outgoingInit = init;
      if (injectTemperature) {
        outgoingInit = { ...init, body: JSON.stringify({ ...body, temperature: 0 }) };
      }
      // Prevent the approved endpoint from redirecting a request to another destination.
      outgoingInit = { ...outgoingInit, redirect: 'error' };

      requestCount += 1;
      const response = await fetch(input, outgoingInit);
      observation.httpStatus = response.status;
      try {
        const diagnostics = extractResponseDiagnostics(await response.clone().json());
        currentUsage = diagnostics.usage;
        observation.truncated = diagnostics.truncated;
        observation.emptyContent = diagnostics.emptyContent;
      } catch {
        currentUsage = null;
      }
      return response;
    } finally {
      observation.requestElapsedMs = Number((performance.now() - started).toFixed(2));
      observations.push(observation);
    }
  };

  const adapters = new Map();
  if (mode === MODE_TEMPERATURE) {
    const adapter = createOpenAiCompatibleAdapterFromEnv(process.env, {
      timeoutMs: TIMEOUT_MS,
      maxTokens: BUDGET,
      fetchImpl,
    });
    if (!adapter.configured) throw new Error('ADAPTER_NOT_CONFIGURED');
    for (const condition of modeConfig.conditions) adapters.set(condition.id, adapter);
  } else {
    for (const condition of modeConfig.conditions) {
      const adapterEnv = { ...process.env, AI_THINKING: condition.envThinking };
      const adapter = createOpenAiCompatibleAdapterFromEnv(adapterEnv, {
        timeoutMs: TIMEOUT_MS,
        maxTokens: BUDGET,
        fetchImpl,
      });
      if (!adapter.configured) throw new Error('ADAPTER_NOT_CONFIGURED');
      adapters.set(condition.id, adapter);
    }
  }

  const startedAt = new Date().toISOString();
  const results = [];
  for (const run of schedule) {
    currentCondition = run.condition;
    const observationsBefore = observations.length;
    const callsBefore = requestCount;
    const adapter = adapters.get(run.condition);
    if (!adapter) throw new Error('ADAPTER_NOT_CONFIGURED');
    const record = await executeCase(puzzle, run.item, adapter, run.round, target.model, usageCapture);
    const observation = observations[observationsBefore] ?? null;
    if (record.promptVersion !== PROMPT_VERSION) throw new Error('PROMPT_VERSION_NOT_FROZEN');
    results.push(publicResult(record, observation, run.condition, run.round));
    if (requestCount - callsBefore > 1) throw new Error('MULTIPLE_REQUESTS_FOR_CASE');
  }

  const finishedAt = new Date().toISOString();
  const complete = results.length === MAX_CALLS && requestCount === MAX_CALLS;
  const reportedConditions = Object.fromEntries(modeConfig.conditions.map((condition) => [
    condition.id,
    mode === MODE_TEMPERATURE
      ? { temperature: condition.temperature, enable_thinking: false }
      : {
        temperature: 'omitted',
        enable_thinking: condition.enableThinking,
        ...(condition.reasoningEffort ? { reasoning_effort: condition.reasoningEffort } : {}),
      },
  ]));
  const report = {
    schemaVersion: 1,
    mode,
    experiment: modeConfig.experiment,
    executionStatus: complete ? 'completed' : 'incomplete',
    createdAt: finishedAt,
    startedAt,
    finishedAt,
    model: target.model,
    promptVersion: PROMPT_VERSION,
    contentVersion: puzzle.version,
    thinking: mode === MODE_TEMPERATURE ? 'disabled' : 'varies by condition',
    temperature: mode === MODE_TEMPERATURE ? 'varies by condition' : 'omitted in both conditions',
    budget: BUDGET,
    timeoutMs: TIMEOUT_MS,
    rounds: ROUNDS,
    selectedCaseIds: CASE_IDS,
    requestCount,
    maxCalls: MAX_CALLS,
    conditions: reportedConditions,
    officialSource: {
      url: OFFICIAL_SOURCE,
      temperatureRange: '[0, 2)',
      parameterConstraint: mode === MODE_TEMPERATURE
        ? 'temperature and top_p are alternatives; only temperature is explicit in the zero condition.'
        : 'temperature and top_p are alternatives; both thinking conditions omit them.',
    },
    results,
    summary: summarize(results, modeConfig),
    limitations: modeConfig.limitations,
  };

  await mkdir(new URL('.', import.meta.url), { recursive: true });
  const path = await writeImmutableReport(startedAt, report, modeConfig.reportPrefix);
  process.stdout.write(`${modeConfig.experiment} ${report.executionStatus}: ${requestCount}/${MAX_CALLS} requests\n`);
  process.stdout.write(`report ${path}\n`);
  if (!complete) process.exitCode = 1;
}

main().catch((error) => {
  const code = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : 'SAMPLING_COMPARISON_FAILED';
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
