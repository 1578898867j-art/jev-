import { createRequire } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire('C:/Users/15788/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const qaDirectory = dirname(fileURLToPath(import.meta.url));
const runTimestamp = new Date().toISOString().replace(/[-:]/g, '');
const reportPath = resolve(qaDirectory, `real-hints-browser-run-${runTimestamp}.json`);
const latestReportPath = resolve(qaDirectory, 'real-hints-browser-latest.json');
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const targetRaw = process.env.PUBLIC_QA_URL?.trim() || 'http://127.0.0.1:8791/';
const modelName = process.env.PUBLIC_QA_MODEL_NAME?.trim();
const promptVersion = process.env.PUBLIC_QA_PROMPT_VERSION?.trim();
const hintPromptVersion = process.env.PUBLIC_QA_HINT_PROMPT_VERSION?.trim() || null;
const maxHintCalls = 3;

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function shanghaiTimestamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date()) + ' Asia/Shanghai (UTC+08:00)';
}

function safeApiPath(pathname) {
  return pathname.replace(/\/sessions\/[^/]+(?=\/|$)/, '/sessions/:session');
}

function resolveTargetUrl() {
  const url = new URL(targetRaw);
  ensure(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname), 'PUBLIC_QA_URL must use local HTTP');
  ensure(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'PUBLIC_QA_URL must be the plain application root');
  return url.origin + '/';
}

const report = {
  startedAtUtc: new Date().toISOString(),
  startedAtShanghai: shanghaiTimestamp(),
  browser: { name: 'Microsoft Edge', executablePath: edgePath, version: null, engineVersion: null, userAgent: null, headless: true, disableGpu: true },
  targetUrl: null,
  modelMetadata: { modelName: modelName || null, qaPromptVersion: promptVersion || null, hintPromptVersion },
  runScope: 'Focused real-model hints-only UI run: exactly three hint calls at most; no question-model calls.',
  cumulativeCallAccounting: { priorReportedCalls: 12, maxCallsThisRun: maxHintCalls, totalIfAllThreeUsed: 15 },
  api: { configured: null, requests: [] },
  aiCalls: { maxAllowed: maxHintCalls, hintRequests: 0, total: 0 },
  assertions: {},
  hintFindings: [],
  sessionResetChecks: [],
  userVisibleTexts: { puzzleTitle: null, hints: [] },
  screenshots: [],
  pageErrors: [],
  manualHintReview: { status: 'pending', reviewItems: ['direction', 'semantic repetition', 'hidden-answer leakage'] },
  failureUiSnapshot: null,
  errors: [],
};

const targetUrl = resolveTargetUrl();
const targetOrigin = new URL(targetUrl).origin;
report.targetUrl = targetUrl;
const apiRequests = [];
const requestRecords = new Map();
let browser;
let context;
let page;
let currentStage = 'metadata';

function hintRequestCount() {
  return apiRequests.filter(({ method, path }) => method === 'POST' && path.endsWith('/hints')).length;
}

async function waitForLibrary() {
  await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.puzzle-row').first().waitFor({ state: 'visible', timeout: 20000 });
}

async function waitForPost(suffix) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === targetOrigin && url.pathname.endsWith(suffix) && response.request().method() === 'POST';
  }, { timeout: 50000 });
}

async function startGameFromLibrary() {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === targetOrigin && url.pathname === '/api/sessions' && response.request().method() === 'POST';
  }, { timeout: 20000 });
  await page.locator('.puzzle-row').first().locator('button.puzzle-start').click();
  const response = await responsePromise;
  ensure(response.status() === 201, `Session creation returned HTTP ${response.status()}`);
  await page.getByRole('region', { name: '提问与本局操作' }).waitFor({ state: 'visible', timeout: 20000 });
  return response.status();
}

async function freshGameSnapshot() {
  const progressText = (await page.locator('.progress-copy p').innerText()).trim();
  const conversationCount = await page.locator('.message-row').count();
  const hintButton = page.locator('.secondary-actions button.button-secondary');
  const hintCounter = (await hintButton.innerText()).trim().replace(/\s+/g, ' ');
  const hintDisabled = await hintButton.isDisabled();
  return { progressText, conversationCount, hintCounter, hintDisabled };
}

async function saveScreenshot(stem, options = {}) {
  const filename = `real-hints-browser-${stem}-${runTimestamp}.png`;
  await page.screenshot({ path: resolve(qaDirectory, filename), fullPage: true, ...options });
  report.screenshots.push(filename);
}

async function captureFailureUiSnapshot() {
  if (!page) return;
  const hints = await page.locator('.message-hint').evaluateAll((rows) => rows.map((row) => ({
    role: row.querySelector('.message-author')?.textContent?.trim() ?? '',
    text: row.querySelector('.message-content p')?.textContent?.trim() ?? '',
  })));
  report.failureUiSnapshot = {
    stage: currentStage,
    visibleHintRows: hints.length,
    visibleHints: hints,
    counterLabel: await page.locator('.secondary-actions button.button-secondary').innerText().catch(() => null),
    progress: await page.locator('.progress-copy p').innerText().catch(() => null),
  };
  const hasSolution = await page.locator('.solution-text').count().catch(() => 0);
  await saveScreenshot(`failure-${currentStage}`, hasSolution > 0 ? {
    mask: [page.locator('.solution-text')], maskColor: '#17221f',
  } : {}).catch(() => undefined);
}

try {
  ensure(Boolean(modelName) && /qwen/i.test(modelName), 'PUBLIC_QA_MODEL_NAME must identify the configured Qwen model');
  ensure(Boolean(promptVersion) && /^qa-v\d+$/.test(promptVersion), 'PUBLIC_QA_PROMPT_VERSION must use qa-vN format');
  currentStage = 'launch-browser';
  browser = await chromium.launch({ executablePath: edgePath, headless: true, args: ['--disable-gpu'] });
  report.browser.version = browser.version();
  context = await browser.newContext({ viewport: { width: 390, height: 900 }, deviceScaleFactor: 1 });
  page = await context.newPage();
  report.browser.userAgent = await page.evaluate(() => navigator.userAgent);
  report.browser.engineVersion = report.browser.userAgent.match(/(?:Chrome|Chromium|HeadlessChrome)\/([\d.]+)/)?.[1] ?? null;
  page.on('pageerror', (error) => report.pageErrors.push(error.name || 'Error'));
  page.on('request', (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== targetOrigin || !url.pathname.startsWith('/api/')) return;
    const record = { method: request.method(), path: safeApiPath(url.pathname), status: null, failed: false };
    apiRequests.push(record);
    requestRecords.set(request, record);
  });
  page.on('response', (response) => {
    const record = requestRecords.get(response.request());
    if (record) record.status = response.status();
  });
  page.on('requestfailed', (request) => {
    const record = requestRecords.get(request);
    if (record) record.failed = true;
  });

  currentStage = 'load-real-app';
  const healthPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/health', { timeout: 20000 });
  const puzzlesPromise = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/puzzles', { timeout: 20000 });
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  const [healthResponse, puzzlesResponse] = await Promise.all([healthPromise, puzzlesPromise]);
  ensure(healthResponse.ok() && puzzlesResponse.ok(), 'Health or puzzle-list request failed');
  report.api.configured = (await healthResponse.json())?.ai?.configured ?? null;
  ensure(report.api.configured === true, 'The live backend did not report configured AI');
  await waitForLibrary();
  ensure(await page.getByText('AI 海龟汤', { exact: true }).isVisible(), 'Library brand was not visible');
  report.userVisibleTexts.puzzleTitle = (await page.locator('.puzzle-row h3').first().innerText()).trim();
  report.assertions.libraryLoaded = true;
  await saveScreenshot('library-390');

  currentStage = 'start-hint-session';
  const createStatus = await startGameFromLibrary();
  report.assertions.hintSessionCreated = createStatus === 201;
  const initial = await freshGameSnapshot();
  report.sessionResetChecks.push({ after: 'library', ...initial });
  report.assertions.initialHintSessionClean = initial.progressText === '0 / 4 条必要线索'
    && initial.conversationCount === 0 && initial.hintCounter === '提示 0 / 3' && !initial.hintDisabled;
  ensure(report.assertions.initialHintSessionClean, 'Hint session did not start clean at 0/4 and 0/3');

  for (let index = 0; index < maxHintCalls; index += 1) {
    currentStage = `hint-${index + 1}-request`;
    ensure(hintRequestCount() === index, 'Unexpected hint request count before this action');
    ensure(hintRequestCount() < maxHintCalls, 'Three-call hint budget reached');
    const actionButton = page.locator('.secondary-actions button.button-secondary');
    ensure(!(await actionButton.isDisabled()), `Hint ${index + 1} action button was disabled before its request`);
    const responsePromise = waitForPost('/hints');
    await actionButton.click();
    const response = await responsePromise;
    ensure(response.ok(), `Hint ${index + 1} returned HTTP ${response.status()}`);
    ensure(hintRequestCount() === index + 1, `Hint ${index + 1} generated an unexpected request count`);

    const hintRows = page.locator('.message-hint');
    const counterButton = page.locator('.secondary-actions button.button-secondary');
    const expectedCounterLabel = index === 2 ? '提示已用完 3 / 3' : `提示 ${index + 1} / 3`;
    const finding = {
      index: index + 1,
      expectedCounterLabel,
      afterResponseSnapshot: {
        visibleHintRows: await hintRows.count(),
        counterLabel: (await counterButton.innerText()).trim().replace(/\s+/g, ' '),
        progress: (await page.locator('.progress-copy p').innerText()).trim(),
      },
      hintRowVisible: false,
      hintTextCaptured: false,
      counterLabelAfterRow: null,
      counterVerified: false,
    };
    report.hintFindings.push(finding);

    currentStage = `hint-${index + 1}-row`;
    const hintRow = hintRows.nth(index);
    await hintRow.waitFor({ state: 'visible', timeout: 20000 });
    finding.hintRowVisible = true;
    const hintText = (await hintRow.locator('.message-content p').innerText()).trim();
    const progressAfter = (await page.locator('.progress-copy p').innerText()).trim();
    finding.hintTextCaptured = hintText.length > 0;
    finding.hintText = hintText;
    finding.progressAfter = progressAfter;
    const visibleHint = {
      index: index + 1,
      text: hintText,
      characterCount: Array.from(hintText).length,
      httpStatus: response.status(),
      progressAfter,
    };
    report.userVisibleTexts.hints.push(visibleHint);
    ensure(hintText.length > 0, `Hint ${index + 1} was empty`);
    ensure(progressAfter === '0 / 4 条必要线索', `Hint ${index + 1} unexpectedly changed clue progress`);
    if (index === 2) await saveScreenshot('hint-3-before-counter-390');

    currentStage = `hint-${index + 1}-counter`;
    const hintCounter = page.getByRole('button', { name: expectedCounterLabel, exact: true });
    await hintCounter.waitFor({ state: 'visible', timeout: 10000 });
    finding.counterLabelAfterRow = (await hintCounter.innerText()).trim().replace(/\s+/g, ' ');
    finding.counterVerified = finding.counterLabelAfterRow === expectedCounterLabel;
    visibleHint.hintCounter = finding.counterLabelAfterRow;
    ensure(finding.counterVerified, `Hint ${index + 1} counter did not match its actual UI label`);
  }

  currentStage = 'fourth-hint-blocked';
  ensure(hintRequestCount() === 3, 'Expected exactly three hint requests before checking the exhausted state');
  const exhaustedButton = page.getByRole('button', { name: '提示已用完 3 / 3', exact: true });
  report.assertions.fourthHintDisabled = await exhaustedButton.isDisabled();
  report.assertions.noFourthHintRequest = hintRequestCount() === 3;
  report.assertions.allHintsLeaveProgressAtZero = (await page.locator('.progress-copy p').innerText()).trim() === '0 / 4 条必要线索';
  ensure(report.assertions.fourthHintDisabled && report.assertions.noFourthHintRequest && report.assertions.allHintsLeaveProgressAtZero,
    'Hint exhaustion or progress behavior was incorrect');
  report.assertions.allThreeHintRowsVisible = await page.locator('.message-hint').count() === 3;
  await saveScreenshot('all-three-hints-390');

  currentStage = 'leave-hint-session';
  ensure(hintRequestCount() === 3, 'Unexpected hint request before leaving the hint session');
  const leavePromise = waitForPost('/leave');
  await page.getByRole('button', { name: '返回题库并离开本局' }).click();
  const leaveResponse = await leavePromise;
  ensure(leaveResponse.ok(), `Leave returned HTTP ${leaveResponse.status()}`);
  await waitForLibrary();
  report.assertions.leaveHintSessionReturnsToLibrary = true;

  currentStage = 'new-game-clear';
  const freshStatus = await startGameFromLibrary();
  const afterHintsFresh = await freshGameSnapshot();
  report.sessionResetChecks.push({ after: 'left-hint-session', ...afterHintsFresh });
  report.assertions.newGameAfterHintsIsClear = freshStatus === 201
    && afterHintsFresh.progressText === '0 / 4 条必要线索'
    && afterHintsFresh.conversationCount === 0
    && afterHintsFresh.hintCounter === '提示 0 / 3'
    && !afterHintsFresh.hintDisabled;
  ensure(report.assertions.newGameAfterHintsIsClear, 'New game retained hint-session state');
  await saveScreenshot('fresh-game-after-hints-390');

  currentStage = 'give-up';
  ensure(hintRequestCount() === 3, 'Unexpected hint request before separate give-up');
  const giveUpPromise = waitForPost('/give-up');
  await page.getByRole('button', { name: '放弃并看汤底' }).click();
  const giveUpResponse = await giveUpPromise;
  ensure(giveUpResponse.ok(), `Give-up returned HTTP ${giveUpResponse.status()}`);
  await page.getByRole('heading', { name: '汤底揭晓' }).waitFor({ state: 'visible', timeout: 20000 });
  report.assertions.giveUpSeparateTerminal = await page.getByText('已放弃', { exact: true }).isVisible()
    && await page.locator('.solution-text').evaluate((element) => (element.textContent || '').trim().length > 0);
  ensure(report.assertions.giveUpSeparateTerminal, 'Give-up did not reach its separate terminal state');
  await saveScreenshot('give-up-390', { mask: [page.locator('.solution-text')], maskColor: '#17221f' });
  report.assertions.noPageErrors = report.pageErrors.length === 0;
  ensure(report.assertions.noPageErrors, 'Browser emitted a pageerror');
} catch (error) {
  report.errors.push({ stage: currentStage, name: error instanceof Error ? error.name : 'Error' });
  await captureFailureUiSnapshot().catch(() => undefined);
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  report.api.requests = apiRequests;
  report.aiCalls.hintRequests = hintRequestCount();
  report.aiCalls.total = report.aiCalls.hintRequests;
  report.finishedAtUtc = new Date().toISOString();
  report.finishedAtShanghai = shanghaiTimestamp();
  const requiredChecksPassed = report.errors.length === 0
    && report.aiCalls.hintRequests === 3
    && report.aiCalls.total <= maxHintCalls
    && report.pageErrors.length === 0
    && report.assertions.allThreeHintRowsVisible === true
    && report.assertions.fourthHintDisabled === true
    && report.assertions.noFourthHintRequest === true
    && report.assertions.allHintsLeaveProgressAtZero === true
    && report.assertions.newGameAfterHintsIsClear === true
    && report.assertions.giveUpSeparateTerminal === true;
  report.status = requiredChecksPassed ? 'pending-manual-hint-review' : 'failed';
  await mkdir(qaDirectory, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await copyFile(reportPath, latestReportPath);
  console.log(JSON.stringify({
    status: report.status,
    startedAtUtc: report.startedAtUtc,
    finishedAtUtc: report.finishedAtUtc,
    finishedAtShanghai: report.finishedAtShanghai,
    browser: report.browser,
    targetUrl: report.targetUrl,
    modelMetadata: report.modelMetadata,
    apiConfigured: report.api.configured,
    aiCalls: report.aiCalls,
    assertions: report.assertions,
    apiRequests: report.api.requests,
    reportPath,
    latestReportPath,
    errors: report.errors,
  }, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
}
