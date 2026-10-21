import { createRequire } from 'node:module';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Required non-secret metadata at run time:
// PUBLIC_QA_MODEL_NAME (for example qwen3.8-flash)
// PUBLIC_QA_PROMPT_VERSION=qa-v5
// Optional: PUBLIC_QA_HINT_PROMPT_VERSION (for example hint-v1)
// Optional local URL: PUBLIC_QA_URL (defaults to http://127.0.0.1:8790/)
// This script never reads .env, request bodies, authorization headers, or session tokens.
const require = createRequire('C:/Users/15788/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');

const qaDirectory = dirname(fileURLToPath(import.meta.url));
const runTimestamp = new Date().toISOString().replace(/[-:]/g, '');
const reportPath = resolve(qaDirectory, `real-model-browser-run-${runTimestamp}.json`);
const latestReportPath = resolve(qaDirectory, 'real-model-browser-latest.json');
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const viewport = { width: 390, height: 900 };
const maxModelCalls = 7;
const questions = [
  { caseId: 'BOD-P01', category: 'projection', text: '天幕上的星点是室内投影仪打出来的吗？' },
  { caseId: 'BOD-R01', category: 'roof', text: '观测站的屋顶可以打开吗？' },
  { caseId: 'BOD-V01', category: 'final-view', text: '游客最后看到的是真正的室外星空吗？' },
  { caseId: 'ui-standard-cause', category: 'cause', text: '讲解员关掉投影并打开屋顶，是为了让游客看真实夜空吗？' },
];

function requiredPublicMetadata(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing non-secret metadata: ${name}`);
  return value;
}

function resolveTargetUrl() {
  const raw = process.env.PUBLIC_QA_URL?.trim() || 'http://127.0.0.1:8790/';
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) {
    throw new Error('PUBLIC_QA_URL must be a plain local HTTP URL without credentials, query, or fragment');
  }
  if (url.pathname !== '/') throw new Error('PUBLIC_QA_URL must point to the application root');
  return url;
}

function localShanghaiTimestamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date()) + ' Asia/Shanghai (UTC+08:00)';
}

function safeApiPath(pathname) {
  return pathname.replace(/\/sessions\/[^/]+(?=\/|$)/, '/sessions/:session');
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

function modelRequestCount(apiRequests) {
  return apiRequests.filter(({ path, method }) => method === 'POST' && (path.endsWith('/questions') || path.endsWith('/hints'))).length;
}

function requestsFor(apiRequests, suffix) {
  return apiRequests.filter(({ method, path }) => method === 'POST' && path.endsWith(suffix));
}

async function waitForLibrary(page) {
  await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.puzzle-row').first().waitFor({ state: 'visible', timeout: 20000 });
}

async function startGameFromLibrary(page, apiRequests) {
  const before = apiRequests.filter(({ method, path }) => method === 'POST' && path === '/api/sessions').length;
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === '/api/sessions' && response.request().method() === 'POST';
  }, { timeout: 20000 });
  await page.locator('.puzzle-row').first().locator('button.puzzle-start').click();
  const response = await responsePromise;
  ensure(response.ok(), `Session creation returned HTTP ${response.status()}`);
  await page.getByRole('region', { name: '提问与本局操作' }).waitFor({ state: 'visible', timeout: 20000 });
  const after = apiRequests.filter(({ method, path }) => method === 'POST' && path === '/api/sessions').length;
  ensure(after === before + 1, 'Expected exactly one real session creation request');
  return response.status();
}

async function expectFreshGame(page) {
  const progressText = (await page.locator('.progress-copy p').innerText()).trim();
  const conversationCount = await page.locator('.message-row').count();
  const hintsButton = page.getByRole('button', { name: /提示 0 \/ 3/ });
  const hintsDisabled = await hintsButton.isDisabled();
  ensure(progressText === '0 / 4 条必要线索', 'New game did not start at 0/4');
  ensure(conversationCount === 0, 'A new game retained messages from the prior session');
  ensure(await hintsButton.isVisible() && !hintsDisabled, 'A fresh configured session did not enable its first hint');
  return { progressText, conversationCount, hintCounter: '0 / 3' };
}

async function waitForActionResponse(page, suffix) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname.endsWith(suffix) && response.request().method() === 'POST';
  }, { timeout: 50000 });
}

async function readLatestHostMessage(page) {
  return page.locator('.message-row').evaluateAll((rows) => {
    const hostRows = rows.filter((row) => row.querySelector('.message-author')?.textContent?.trim() === '主持人');
    const row = hostRows.at(-1);
    return row ? {
      text: row.querySelector('.message-content p')?.textContent?.trim() ?? '',
      judgment: row.querySelector('.judgment-chip')?.textContent?.trim() ?? null,
    } : { text: '', judgment: null };
  });
}

async function saveScreenshot(page, stem, options = {}) {
  const filename = `real-model-browser-${stem}-${runTimestamp}.png`;
  await page.screenshot({ path: resolve(qaDirectory, filename), fullPage: true, ...options });
  report.screenshots.push(filename);
}

const report = {
  startedAtUtc: new Date().toISOString(),
  startedAtShanghai: localShanghaiTimestamp(),
  browser: {
    name: 'Microsoft Edge', executablePath: edgePath, version: null, engineVersion: null,
    userAgent: null, headless: true, disableGpu: true,
  },
  targetUrl: null,
  runScope: 'Bounded real-model UI integration run. The fourth question is ui-standard-cause wording and is not the frozen BOD-C01 holdout.',
  modelMetadata: { modelName: null, qaPromptVersion: null, hintPromptVersion: null },
  api: { configured: null, requests: [] },
  aiCalls: { maxAllowed: maxModelCalls, questionRequests: 0, hintRequests: 0, total: 0 },
  assertions: {},
  questionFindings: [],
  hintFindings: [],
  sessionResetChecks: [],
  userVisibleTexts: { puzzleTitle: null, questions: [], hints: [] },
  screenshots: [],
  pageErrors: [],
  manualHintReview: {
    status: 'pending',
    reviewItems: ['direction', 'semantic repetition', 'hidden-answer leakage'],
  },
  errors: [],
};

let browser;
let context;
let currentStage = 'metadata';
let apiRequests = [];

try {
  report.modelMetadata.modelName = requiredPublicMetadata('PUBLIC_QA_MODEL_NAME');
  report.modelMetadata.qaPromptVersion = requiredPublicMetadata('PUBLIC_QA_PROMPT_VERSION');
  report.modelMetadata.hintPromptVersion = process.env.PUBLIC_QA_HINT_PROMPT_VERSION?.trim() || null;
  ensure(/qwen/i.test(report.modelMetadata.modelName), 'PUBLIC_QA_MODEL_NAME must identify the configured Qwen model');
  ensure(/^qa-v\d+$/.test(report.modelMetadata.qaPromptVersion), 'PUBLIC_QA_PROMPT_VERSION must use qa-vN format');
  const targetUrl = resolveTargetUrl();
  report.targetUrl = targetUrl.origin + '/';

  currentStage = 'launch-browser';
  browser = await chromium.launch({ executablePath: edgePath, headless: true, args: ['--disable-gpu'] });
  report.browser.version = browser.version();
  context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  report.browser.userAgent = await page.evaluate(() => navigator.userAgent);
  report.browser.engineVersion = report.browser.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] ?? null;
  page.on('pageerror', (error) => report.pageErrors.push(error.name || 'Error'));
  const requestRecords = new Map();
  page.on('request', (request) => {
    let url;
    try { url = new URL(request.url()); } catch { return; }
    if (url.origin !== targetUrl.origin || !url.pathname.startsWith('/api/')) return;
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
  await page.goto(report.targetUrl, { waitUntil: 'domcontentloaded' });
  const [healthResponse, puzzlesResponse] = await Promise.all([healthPromise, puzzlesPromise]);
  ensure(healthResponse.ok(), `Health returned HTTP ${healthResponse.status()}`);
  ensure(puzzlesResponse.ok(), `Puzzle list returned HTTP ${puzzlesResponse.status()}`);
  const healthPayload = await healthResponse.json();
  report.api.configured = healthPayload?.ai?.configured ?? null;
  ensure(report.api.configured === true, 'The live backend did not report configured AI');
  await waitForLibrary(page);
  report.userVisibleTexts.puzzleTitle = (await page.locator('.puzzle-row h3').first().innerText()).trim();
  ensure(await page.getByText('AI 海龟汤', { exact: true }).isVisible(), 'The library brand was not visible');
  report.assertions.libraryAndFirstPuzzleVisible = true;
  await saveScreenshot(page, 'library-390');

  currentStage = 'start-question-session';
  const createStatus = await startGameFromLibrary(page, apiRequests);
  report.assertions.questionSessionCreated = createStatus === 201;
  ensure(report.assertions.questionSessionCreated, 'Question session creation did not return HTTP 201');
  report.assertions.initialProgressZeroOfFour = (await page.locator('.progress-copy p').innerText()).trim() === '0 / 4 条必要线索';
  ensure(report.assertions.initialProgressZeroOfFour, 'Question session did not start at 0/4');

  for (let index = 0; index < questions.length; index += 1) {
    currentStage = `question-${index + 1}`;
    ensure(modelRequestCount(apiRequests) === index, 'Unexpected model request before this question');
    ensure(modelRequestCount(apiRequests) < maxModelCalls, 'AI request cap reached before the next question');
    const question = questions[index];
    const input = page.getByLabel('提出你的问题');
    await input.fill(question.text);
    const responsePromise = waitForActionResponse(page, '/questions');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    const response = await responsePromise;
    const requestCount = requestsFor(apiRequests, '/questions').length;
    ensure(response.ok(), `Question ${index + 1} returned HTTP ${response.status()}`);
    ensure(requestCount === index + 1, `Question ${index + 1} generated an unexpected request count`);
    ensure(modelRequestCount(apiRequests) === index + 1, `Question ${index + 1} exceeded the expected model request count`);
    const expectedProgress = `${index + 1} / 4 条必要线索`;
    const afterResponseHost = await readLatestHostMessage(page);
    const afterResponseProgress = (await page.locator('.progress-copy p').innerText()).trim();
    const finding = {
      caseId: question.caseId,
      expectedProgress,
      afterResponseSnapshot: {
        hostReply: afterResponseHost.text,
        judgment: afterResponseHost.judgment,
        progress: afterResponseProgress,
      },
      hostRowVisible: false,
      observedProgress: null,
      affirmativeJudgment: null,
      foundExpectedClue: false,
    };
    report.questionFindings.push(finding);
    await page.locator('.message-row').nth(index * 2 + 1).waitFor({ state: 'visible', timeout: 20000 });
    finding.hostRowVisible = true;
    const host = await readLatestHostMessage(page);
    const observedProgress = (await page.locator('.progress-copy p').innerText()).trim();
    const foundExpectedClue = observedProgress === expectedProgress && host.judgment === '是';
    report.userVisibleTexts.questions.push({
      caseId: question.caseId,
      category: question.category,
      question: question.text,
      hostReply: host.text,
      judgment: host.judgment,
      progressAfter: observedProgress,
      expectedProgress,
      httpStatus: response.status(),
    });
    report.assertions[`question${index + 1}FoundOneClue`] = foundExpectedClue;
    finding.observedHostReply = host.text;
    finding.observedJudgment = host.judgment;
    finding.observedProgress = observedProgress;
    finding.affirmativeJudgment = host.judgment === '是';
    finding.foundExpectedClue = foundExpectedClue;
  }

  currentStage = 'unlocked-before-reveal';
  const questionSessionProgress = (await page.locator('.progress-copy p').innerText()).trim();
  report.assertions.unlockedAtFourOfFour = questionSessionProgress === '4 / 4 条必要线索';
  report.assertions.solutionStillHiddenBeforeReveal = await page.locator('.solution-text').count() === 0;
  report.assertions.solutionWithheldUntilClick = report.assertions.unlockedAtFourOfFour
    && report.assertions.solutionStillHiddenBeforeReveal
    && await page.getByRole('button', { name: '查看汤底' }).isVisible();

  if (report.assertions.unlockedAtFourOfFour && report.assertions.solutionWithheldUntilClick) {
    currentStage = 'unlocked-before-reveal';
    await saveScreenshot(page, 'unlocked-390', {
      mask: [page.locator('.solution-text')],
      maskColor: '#17221f',
    });

    currentStage = 'reveal';
    ensure(modelRequestCount(apiRequests) === 4, 'Unexpected model request before reveal');
    const revealPromise = waitForActionResponse(page, '/reveal');
    await page.getByRole('button', { name: '查看汤底' }).click();
    const revealResponse = await revealPromise;
    ensure(revealResponse.ok(), `Reveal returned HTTP ${revealResponse.status()}`);
    await page.getByRole('heading', { name: '线索已拼合' }).waitFor({ state: 'visible', timeout: 20000 });
    report.assertions.revealCompleted = await page.getByText('已看汤底', { exact: true }).isVisible()
      && await page.locator('.solution-text').evaluate((element) => (element.textContent || '').trim().length > 0);
    ensure(report.assertions.revealCompleted, 'Reveal did not reach completed state with a visible solution');
    await saveScreenshot(page, 'completed-390', {
      mask: [page.locator('.solution-text')],
      maskColor: '#17221f',
    });

    currentStage = 'leave-completed-session';
    ensure(modelRequestCount(apiRequests) === 4, 'Unexpected model request before leaving the completed game');
    await page.getByRole('button', { name: '返回题库', exact: true }).click();
    await waitForLibrary(page);
    report.assertions.leaveReturnsToLibrary = true;
  } else {
    report.assertions.revealCompleted = false;
    report.assertions.revealSkippedBecauseFourCluesWereNotUnlocked = !report.assertions.unlockedAtFourOfFour;
    await saveScreenshot(page, 'question-session-locked-390', {
      mask: [page.locator('.solution-text')],
      maskColor: '#17221f',
    });
    currentStage = 'leave-question-session';
    ensure(modelRequestCount(apiRequests) === 4, 'Unexpected model request before leaving the question session');
    const leaveQuestionPromise = waitForActionResponse(page, '/leave');
    await page.getByRole('button', { name: '返回题库并离开本局' }).click();
    const leaveQuestionResponse = await leaveQuestionPromise;
    ensure(leaveQuestionResponse.ok(), `Question session leave returned HTTP ${leaveQuestionResponse.status()}`);
    await waitForLibrary(page);
    report.assertions.leaveReturnsToLibrary = true;
  }

  currentStage = 'start-hint-session';
  ensure(modelRequestCount(apiRequests) === 4, 'Unexpected model request before starting the hint session');
  await startGameFromLibrary(page, apiRequests);
  const hintFreshCheck = await expectFreshGame(page);
  report.assertions.hintSessionStartsClean = true;
  report.sessionResetChecks.push({ after: report.assertions.revealCompleted ? 'completed-question-game' : 'left-question-game', ...hintFreshCheck });

  for (let index = 0; index < 3; index += 1) {
    currentStage = `hint-${index + 1}-request`;
    ensure(modelRequestCount(apiRequests) === questions.length + index, 'Unexpected model request before this hint');
    ensure(modelRequestCount(apiRequests) < maxModelCalls, 'AI request cap reached before the next hint');
    const responsePromise = waitForActionResponse(page, '/hints');
    await page.getByRole('button', { name: new RegExp(`^提示 ${index} \/ 3`) }).click();
    const response = await responsePromise;
    const requestCount = requestsFor(apiRequests, '/hints').length;
    ensure(response.ok(), `Hint ${index + 1} returned HTTP ${response.status()}`);
    ensure(requestCount === index + 1, `Hint ${index + 1} generated an unexpected request count`);
    ensure(modelRequestCount(apiRequests) === questions.length + index + 1, `Hint ${index + 1} exceeded the expected model request count`);
    const hintRows = page.locator('.message-hint');
    const counterButton = page.locator('.secondary-actions button.button-secondary');
    const expectedCounterLabel = index === 2 ? '提示已用完 3 / 3' : `提示 ${index + 1} / 3`;
    const finding = {
      index: index + 1,
      expectedCounterLabel,
      afterResponseSnapshot: {
        visibleHintRows: await hintRows.count(),
        counterLabel: (await counterButton.innerText()).trim(),
        progress: (await page.locator('.progress-copy p').innerText()).trim(),
      },
      hintRowVisible: false,
      hintTextCaptured: false,
      counterLabelAfterRow: null,
      counterVerified: false,
    };
    report.hintFindings.push(finding);
    currentStage = `hint-${index + 1}-row`;
    const hintRow = page.locator('.message-hint').nth(index);
    await hintRow.waitFor({ state: 'visible', timeout: 20000 });
    finding.hintRowVisible = true;
    const hintText = (await hintRow.locator('.message-content p').innerText()).trim();
    const progressText = (await page.locator('.progress-copy p').innerText()).trim();
    const hintRecord = { index: index + 1, text: hintText, characterCount: Array.from(hintText).length, httpStatus: response.status(), progressAfter: progressText };
    report.userVisibleTexts.hints.push(hintRecord);
    finding.hintTextCaptured = hintText.length > 0;
    finding.hintText = hintText;
    finding.progressAfter = progressText;
    ensure(hintText.length > 0, `Hint ${index + 1} was empty`);
    ensure(progressText === '0 / 4 条必要线索', `Hint ${index + 1} unexpectedly changed clue progress`);
    if (index === 2) await saveScreenshot(page, 'hint-3-before-counter-390');
    currentStage = `hint-${index + 1}-counter`;
    const hintCounter = page.getByRole('button', { name: expectedCounterLabel, exact: true });
    await hintCounter.waitFor({ state: 'visible', timeout: 10000 });
    finding.counterLabelAfterRow = (await hintCounter.innerText()).trim().replace(/\s+/g, ' ');
    finding.counterVerified = finding.counterLabelAfterRow === expectedCounterLabel;
    hintRecord.hintCounter = finding.counterLabelAfterRow;
    ensure(finding.counterVerified, `Hint ${index + 1} counter label did not match the visible UI`);
  }

  currentStage = 'fourth-hint-blocked';
  ensure(modelRequestCount(apiRequests) === maxModelCalls, 'Expected the seven-call budget to be fully used before checking the blocked fourth hint');
  const fourthHintButton = page.getByRole('button', { name: '提示已用完 3 / 3', exact: true });
  report.assertions.fourthHintDisabled = await fourthHintButton.isDisabled();
  report.assertions.fourthHintMadeNoRequest = requestsFor(apiRequests, '/hints').length === 3;
  ensure(report.assertions.fourthHintDisabled && report.assertions.fourthHintMadeNoRequest, 'The fourth hint was not blocked in the UI');
  const normalizedHints = report.userVisibleTexts.hints.map(({ text }) => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''));
  report.manualHintReview.exactTextDistinct = new Set(normalizedHints).size === 3;
  report.assertions.allThreeHintsVisibleWithoutProgress = report.userVisibleTexts.hints.length === 3
    && (await page.locator('.progress-copy p').innerText()).trim() === '0 / 4 条必要线索';
  ensure(report.assertions.allThreeHintsVisibleWithoutProgress, 'Hint session did not retain 0/4 progress');
  await saveScreenshot(page, 'hints-390');

  currentStage = 'leave-hint-session';
  ensure(modelRequestCount(apiRequests) === maxModelCalls, 'Unexpected model request before leaving the hint session');
  const hintLeavePromise = waitForActionResponse(page, '/leave');
  await page.getByRole('button', { name: '返回题库并离开本局' }).click();
  const hintLeaveResponse = await hintLeavePromise;
  ensure(hintLeaveResponse.ok(), `Hint session leave returned HTTP ${hintLeaveResponse.status()}`);
  await waitForLibrary(page);

  currentStage = 'start-give-up-session';
  ensure(modelRequestCount(apiRequests) === maxModelCalls, 'Unexpected model request before starting the give-up session');
  await startGameFromLibrary(page, apiRequests);
  const giveUpFreshCheck = await expectFreshGame(page);
  report.assertions.giveUpSessionStartsClean = true;
  report.sessionResetChecks.push({ after: 'leave-hint-game', ...giveUpFreshCheck });
  currentStage = 'give-up';
  ensure(modelRequestCount(apiRequests) === maxModelCalls, 'Unexpected model request before give-up');
  const giveUpPromise = waitForActionResponse(page, '/give-up');
  await page.getByRole('button', { name: '放弃并看汤底' }).click();
  const giveUpResponse = await giveUpPromise;
  ensure(giveUpResponse.ok(), `Give-up returned HTTP ${giveUpResponse.status()}`);
  await page.getByRole('heading', { name: '汤底揭晓' }).waitFor({ state: 'visible', timeout: 20000 });
  report.assertions.giveUpIsSeparateTerminalPath = await page.getByText('已放弃', { exact: true }).isVisible()
    && await page.locator('.solution-text').evaluate((element) => (element.textContent || '').trim().length > 0);
  ensure(report.assertions.giveUpIsSeparateTerminalPath, 'Separate give-up session did not show its terminal state and solution');
  await saveScreenshot(page, 'given-up-390', {
    mask: [page.locator('.solution-text')],
    maskColor: '#17221f',
  });

  currentStage = 'final-call-budget';
  report.aiCalls.questionRequests = requestsFor(apiRequests, '/questions').length;
  report.aiCalls.hintRequests = requestsFor(apiRequests, '/hints').length;
  report.aiCalls.total = modelRequestCount(apiRequests);
  report.assertions.exactlyFourQuestions = report.aiCalls.questionRequests === 4;
  report.assertions.exactlyThreeHints = report.aiCalls.hintRequests === 3;
  report.assertions.aiCallsAtOrBelowSeven = report.aiCalls.total <= maxModelCalls;
  report.assertions.allModelActionResponsesSuccessful = apiRequests
    .filter(({ path, method }) => method === 'POST' && (path.endsWith('/questions') || path.endsWith('/hints')))
    .every(({ status }) => status >= 200 && status < 300);
  report.assertions.noPageErrors = report.pageErrors.length === 0;
  ensure(report.assertions.exactlyFourQuestions && report.assertions.exactlyThreeHints, 'Unexpected real model call counts');
  ensure(report.assertions.aiCallsAtOrBelowSeven, 'Real model request cap exceeded');
  ensure(report.assertions.allModelActionResponsesSuccessful, 'A question or hint action did not return success');
  ensure(report.assertions.noPageErrors, 'Browser emitted a pageerror');
} catch (error) {
  report.errors.push({ stage: currentStage, name: error instanceof Error ? error.name : 'Error' });
} finally {
  if (context) await context.close().catch(() => undefined);
  if (browser) await browser.close().catch(() => undefined);
  report.api.requests = apiRequests;
  report.aiCalls.questionRequests = requestsFor(apiRequests, '/questions').length;
  report.aiCalls.hintRequests = requestsFor(apiRequests, '/hints').length;
  report.aiCalls.total = modelRequestCount(apiRequests);
  report.finishedAtUtc = new Date().toISOString();
  report.finishedAtShanghai = localShanghaiTimestamp();
  const requiredChecksPassed = report.errors.length === 0
    && report.aiCalls.questionRequests === 4
    && report.aiCalls.hintRequests === 3
    && report.aiCalls.total <= maxModelCalls
    && report.pageErrors.length === 0
    && report.assertions.unlockedAtFourOfFour === true
    && report.assertions.solutionWithheldUntilClick === true
    && report.assertions.revealCompleted === true
    && report.assertions.fourthHintDisabled === true
    && report.assertions.giveUpIsSeparateTerminalPath === true;
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
    hintReviewPending: report.manualHintReview.status === 'pending',
    errors: report.errors,
    reportPath,
    latestReportPath,
  }, null, 2));
  if (report.status === 'failed') process.exitCode = 1;
}
