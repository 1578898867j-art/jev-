const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('C:/Users/15788/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');

const baseURL = 'http://127.0.0.1:5173';
const outputPath = path.join(__dirname, 'network-smoke.json');
const browserPath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const puzzle = {
  id: 'fixture-observatory',
  version: 'fixture-v1',
  title: '受控回归题',
  surface: '夜空中出现了一束短暂的光。',
  requiredClueCount: 1,
};

function makeSession(id, overrides = {}) {
  return {
    id,
    puzzle,
    status: 'playing',
    revision: 0,
    discoveredClues: [],
    hintsUsed: 0,
    messages: [],
    ...overrides,
  };
}

function actionResponse(requestId, session) {
  return { requestId, session };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function writeReport(report) {
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function newFixturePage(browser, scenario, opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  if (opts.clock) await page.clock.install({ time: new Date('2026-10-20T06:00:00.000Z') });

  const state = {
    sessionCount: 0,
    sessions: new Map(),
    requests: [],
    questionCount: 0,
    questionSeen: deferred(),
    oldQuestionGate: deferred(),
    lateFixtureReleased: false,
    lateFixtureFulfilled: false,
    rateLimitResponseAt: null,
    questionMode: opts.questionMode ?? 'timeout',
  };

  page.on('requestfailed', (request) => {
    if (request.url().includes('/api/sessions/') && request.url().includes('/questions')) {
      state.requests.push({ kind: 'question-requestfailed', url: request.url(), error: request.failure()?.errorText ?? null });
    }
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const pathname = url.pathname;
    const body = method === 'POST' ? request.postDataJSON() : undefined;
    const log = { method, path: pathname };
    if (body?.requestId) log.requestId = body.requestId;
    if (body?.expectedRevision !== undefined) log.expectedRevision = body.expectedRevision;
    state.requests.push(log);

    if (pathname === '/api/health' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', ai: { configured: true } }) });
    }
    if (pathname === '/api/puzzles' && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ puzzles: [puzzle] }) });
    }
    if (pathname === '/api/sessions' && method === 'POST') {
      state.sessionCount += 1;
      const id = `${scenario}-session-${state.sessionCount}`;
      const session = makeSession(id);
      state.sessions.set(id, session);
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ sessionToken: `local-fixture-token-${state.sessionCount}`, session }) });
    }

    const match = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(questions|hints|give-up|leave|reveal))?$/);
    if (!match) return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SESSION_NOT_FOUND', message: 'fixture route not found', retryable: false } }) });
    const id = decodeURIComponent(match[1]);
    const suffix = match[2];
    const current = state.sessions.get(id) ?? makeSession(id);
    if (!suffix && method === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: current }) });
    }
    if (method !== 'POST' || !suffix) {
      return route.fulfill({ status: 405, contentType: 'application/json', body: JSON.stringify({ error: { code: 'INVALID_REQUEST', message: 'unsupported fixture request', retryable: false } }) });
    }

    const requestId = body?.requestId ?? 'missing-request-id';
    if (suffix === 'questions') {
      state.questionCount += 1;
      if (state.questionCount === 1) state.questionSeen.resolve();

      if (state.questionMode === 'timeout' && state.questionCount === 1) {
        await state.oldQuestionGate.promise;
        state.lateFixtureReleased = true;
        try {
          const late = makeSession(id, {
            revision: 1,
            messages: [{ id: 'old-late-message', role: 'host', text: 'OLD FIXTURE RESPONSE MUST NOT APPEAR', createdAt: '2026-10-20T06:00:01.000Z', judgment: 'yes' }],
          });
          await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, late)) });
          state.lateFixtureFulfilled = true;
        } catch {
          state.lateFixtureFulfilled = false;
        }
        return;
      }

      if (state.questionMode === 'rate-limit' && state.questionCount === 1) {
        state.rateLimitResponseAt = Date.now();
        return route.fulfill({
          status: 429,
          headers: { 'Retry-After': '2' },
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'Controlled fixture rate limit', retryable: true }, requestId }),
        });
      }

      if (state.questionMode === 'unlock') {
        const unlocked = makeSession(id, {
          status: 'unlocked',
          revision: current.revision + 1,
          discoveredClues: [{ id: 'fixture-clue', kind: 'fact', publicText: '夹具公开线索内容' }],
          messages: [{ id: 'fixture-player-message', role: 'player', text: body?.text ?? '受控问题', createdAt: '2026-10-20T06:00:02.000Z' }],
        });
        state.sessions.set(id, unlocked);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, unlocked)) });
      }

      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Controlled fixture response; no model output', retryable: true }, requestId }),
      });
    }

    if (suffix === 'leave') {
      const left = { ...current, status: 'left', revision: current.revision + 1 };
      state.sessions.set(id, left);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, left)) });
    }
    if (suffix === 'reveal') {
      const completed = {
        ...current,
        status: 'completed',
        revision: current.revision + 1,
        solution: { text: '受控夹具汤底，仅用于验证展示协议，不是真实答案。' },
      };
      state.sessions.set(id, completed);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, completed)) });
    }
    if (suffix === 'give-up') {
      const givenUp = {
        ...current,
        status: 'given_up',
        revision: current.revision + 1,
        solution: { text: '受控夹具放弃结果，不是真实答案。' },
      };
      state.sessions.set(id, givenUp);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, givenUp)) });
    }
    if (suffix === 'hints') {
      const hinted = { ...current, revision: current.revision + 1, hintsUsed: current.hintsUsed + 1 };
      state.sessions.set(id, hinted);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(actionResponse(requestId, hinted)) });
    }
  });

  page.on('request', (request) => {
    if (!request.url().includes('/api/')) return;
    try {
      const url = new URL(request.url());
      if (url.pathname !== '/api/health' && url.pathname !== '/api/puzzles') return;
      // The route handler already logs API requests; this is intentionally left empty.
    } catch {}
  });

  await page.goto(baseURL, { waitUntil: 'networkidle', timeout: 15000 });
  await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: '开始谜题：受控回归题' }).waitFor({ timeout: 10000 });
  return { context, page, state };
}

async function startGame(page) {
  await page.getByRole('button', { name: '开始谜题：受控回归题' }).click();
  await page.getByRole('heading', { name: '受控回归题' }).waitFor({ timeout: 8000 });
}

async function question(page, text = '测试问题') {
  await page.getByLabel('提出你的问题').fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function run() {
  const report = {
    status: 'running',
    generatedAt: new Date().toISOString(),
    browser: 'System Edge via Playwright 1.62.1',
    browserExecutable: browserPath,
    baseURL,
    pageClock: 'page.clock.install/fastForward used to trigger the 40s deadline; Retry-After uses measured real elapsed time.',
    apiMode: 'Every /api/** request is intercepted by in-process local fixtures. No API call reaches the server and no real AI/model call or model answer is made.',
    liveHealthObservedSeparately: { status: 'ok', aiConfigured: false },
    scenarios: [],
  };
  writeReport(report);
  const browser = await chromium.launch({ headless: true, executablePath: browserPath, args: ['--disable-gpu'] });

  try {
    // 1. 40-second deadline, unchanged calibration, and same-ID retry.
    {
      const { context, page, state } = await newFixturePage(browser, 'deadline', { clock: true, questionMode: 'timeout' });
      await startGame(page);
      await question(page, '客户端超时后保留的原问题');
      await state.questionSeen.promise;
      await page.clock.fastForward(40_001);
      await page.getByRole('button', { name: '用同一请求重试问题' }).waitFor({ timeout: 10000 });
      await page.getByText(/请求等待超时，服务端结果尚未确认/).waitFor({ timeout: 8000 });
      const timeoutQuestion = state.requests.find((r) => r.path?.endsWith('/questions'));
      const calibrated = state.requests.some((r) => r.method === 'GET' && r.path?.endsWith('/deadline-session-1'));
      const inputRetained = await page.getByLabel('提出你的问题').inputValue() === '客户端超时后保留的原问题';
      const progressUnchanged = await page.getByText('0 / 1 条必要线索').count() === 1;
      await state.oldQuestionGate.resolve();
      await waitFor(() => state.lateFixtureReleased, 'delayed timeout fixture release');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const oldTextAbsentAfterTimeout = await page.getByText('OLD FIXTURE RESPONSE MUST NOT APPEAR', { exact: true }).count() === 0;
      const progressStillUnchangedAfterLateFixture = await page.getByText('0 / 1 条必要线索').count() === 1;
      await page.getByRole('button', { name: '用同一请求重试问题' }).click();
      await waitFor(() => state.questionCount >= 2, 'same-ID retry request');
      const retryQuestion = state.requests.filter((r) => r.path?.endsWith('/questions'))[1];
      const sameRequestId = Boolean(timeoutQuestion?.requestId) && timeoutQuestion.requestId === retryQuestion?.requestId;
      await page.getByText(/当前进度与提示次数未在本页更新/).waitFor({ timeout: 8000 });
      await page.getByRole('button', { name: '返回题库并离开本局' }).click();
      await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ timeout: 8000 });
      report.scenarios.push({
        name: '40s deadline → calibration → same requestId retry',
        status: calibrated && sameRequestId && inputRetained && progressUnchanged && oldTextAbsentAfterTimeout && progressStillUnchangedAfterLateFixture ? 'passed' : 'failed',
        evidence: {
          clientDeadlineMs: 40000,
          clockAdvancedMs: 40001,
          timeoutQuestionRequestId: timeoutQuestion?.requestId ?? null,
          retryQuestionRequestId: retryQuestion?.requestId ?? null,
          calibrationGetObserved: calibrated,
          inputRetained,
          localProgressUnchangedAtTimeout: progressUnchanged,
          oldTextAbsentAfterDelayedFixture: oldTextAbsentAfterTimeout,
          localProgressUnchangedAfterDelayedFixture: progressStillUnchangedAfterLateFixture,
          retryUsedSameRequestId: sameRequestId,
          delayedInitialFixtureReleasedAfterTimeout: state.lateFixtureReleased,
          delayedInitialFixtureFulfilledAfterAbort: state.lateFixtureFulfilled,
          requestLog: state.requests,
        },
        note: 'The fixture returned no question result before the client deadline. A controlled 503 ended the retry; it is not a model result.',
      });
      await context.close();
      writeReport(report);
    }

    // 2. Retry-After blocks before expiry and allows the same ID after two seconds.
    {
      const { context, page, state } = await newFixturePage(browser, 'retry-after', { questionMode: 'rate-limit' });
      await startGame(page);
      await question(page, '触发受控限流');
      await waitFor(() => state.questionCount === 1, 'initial rate-limited question');
      await page.getByRole('button', { name: '等待后再重试' }).waitFor({ timeout: 8000 });
      const first = state.requests.find((r) => r.path?.endsWith('/questions'));
      const disabledImmediatelyAfter429 = await page.getByRole('button', { name: '等待后再重试' }).isDisabled();
      const beforeExpiryWaitMs = 1200;
      await new Promise((resolve) => setTimeout(resolve, beforeExpiryWaitMs));
      const beforeExpiryDisabled = await page.getByRole('button', { name: '等待后再重试' }).isDisabled().catch(() => false);
      const noPrematureRetry = state.questionCount === 1;
      const remainingUntilExpiryMs = Math.max(0, (state.rateLimitResponseAt ?? Date.now()) + 2200 - Date.now());
      await new Promise((resolve) => setTimeout(resolve, remainingUntilExpiryMs));
      await page.getByRole('button', { name: '用同一请求重试问题' }).waitFor({ timeout: 8000 });
      await page.getByRole('button', { name: '用同一请求重试问题' }).click();
      await waitFor(() => state.questionCount === 2, 'retry after Retry-After expiry');
      const retry = state.requests.filter((r) => r.path?.endsWith('/questions'))[1];
      const sameRequestId = Boolean(first?.requestId) && first.requestId === retry?.requestId;
      await page.getByText(/当前进度与提示次数未在本页更新/).waitFor({ timeout: 8000 });
      report.scenarios.push({
        name: 'Retry-After 2s blocks retries until expiry and then reuses requestId',
        status: beforeExpiryDisabled && noPrematureRetry && sameRequestId ? 'passed' : 'failed',
        evidence: {
          retryAfterSeconds: 2,
          disabledImmediatelyAfter429,
          method: 'real elapsed time with 200ms expiry margin',
          observedWaitBeforeExpiryMs: beforeExpiryWaitMs,
          waitAfterResponseUntilExpiryMs: remainingUntilExpiryMs,
          retryDisabledBeforeExpiry: beforeExpiryDisabled,
          noRequestBeforeExpiry: noPrematureRetry,
          firstRequestId: first?.requestId ?? null,
          retryRequestId: retry?.requestId ?? null,
          sameRequestIdAfterExpiry: sameRequestId,
          requestLog: state.requests,
        },
        note: 'Retry-After was a local fixture header. The post-expiry response was a controlled 503, not a model result.',
      });
      await context.close();
      writeReport(report);
    }

    // 3. A pending old request is aborted on leave; a released late fixture cannot alter the new session.
    {
      const { context, page, state } = await newFixturePage(browser, 'stale-response', { questionMode: 'timeout' });
      await startGame(page);
      await question(page, '旧局延迟问题');
      await state.questionSeen.promise;
      const oldQuestion = state.requests.find((r) => r.path?.endsWith('/questions'));
      await page.getByRole('button', { name: '返回题库并离开本局' }).click();
      await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ timeout: 8000 });
      await page.getByRole('button', { name: '开始谜题：受控回归题' }).click();
      await page.getByRole('heading', { name: '受控回归题' }).waitFor({ timeout: 8000 });
      await state.oldQuestionGate.resolve();
      await page.waitForTimeout(300);
      const oldTextAbsent = await page.getByText('OLD FIXTURE RESPONSE MUST NOT APPEAR', { exact: true }).count() === 0;
      const newSessionVisible = await page.getByRole('heading', { name: '受控回归题' }).count() === 1;
      report.scenarios.push({
        name: 'Old pending action after leave does not pollute the next session',
        status: oldTextAbsent && newSessionVisible ? 'passed' : 'failed',
        evidence: {
          oldRequestId: oldQuestion?.requestId ?? null,
          oldRequestWasPendingAtLeave: Boolean(oldQuestion),
          oldFixtureReleaseAttemptedAfterNewSession: state.lateFixtureReleased,
          oldFixtureFulfilledByPlaywright: state.lateFixtureFulfilled,
          oldTextAbsentFromNewSession: oldTextAbsent,
          newSessionVisible,
          requestLog: state.requests,
        },
        note: 'Leave aborts the pending browser request. The delayed fixture response was released only after the next session opened; Playwright may report it unfulfillable because the browser already aborted the request.',
      });
      await context.close();
      writeReport(report);
    }

    // 4. Cooldown is local to the ended session; leaving clears it before a new game.
    {
      const { context, page, state } = await newFixturePage(browser, 'clear-cooldown', { clock: true, questionMode: 'rate-limit' });
      await startGame(page);
      await question(page, '触发旧局限流');
      await waitFor(() => state.questionCount === 1, 'rate-limited action before leave');
      await page.getByRole('button', { name: '等待后再重试' }).waitFor({ timeout: 8000 });
      const oldRequest = state.requests.find((r) => r.path?.endsWith('/questions'));
      await page.getByRole('button', { name: '返回题库并离开本局' }).click();
      await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ timeout: 8000 });
      const libraryCooldownNotice = await page.getByText('服务端要求稍后再试，等待期结束后可开始新局或重试读取。', { exact: true }).count() > 0;
      const startButtonEnabledBeforeExpiry = await page.getByRole('button', { name: '开始谜题：受控回归题' }).isEnabled();
      await page.getByRole('button', { name: '开始谜题：受控回归题' }).click();
      await page.getByRole('heading', { name: '受控回归题' }).waitFor({ timeout: 8000 });
      const createCalls = state.requests.filter((r) => r.method === 'POST' && r.path === '/api/sessions').length;
      report.scenarios.push({
        name: '429 → leave → new game clears the prior local cooldown',
        status: !libraryCooldownNotice && startButtonEnabledBeforeExpiry && createCalls === 2 ? 'passed' : 'failed',
        evidence: {
          oldRequestId: oldRequest?.requestId ?? null,
          libraryHadOldCooldownNotice: libraryCooldownNotice,
          newGameEntryEnabledBeforeOriginalExpiry: startButtonEnabledBeforeExpiry,
          createSessionCalls: createCalls,
          newSessionVisible: await page.getByRole('heading', { name: '受控回归题' }).count() === 1,
          requestLog: state.requests,
        },
        note: 'The fixture allowed session creation; a real server can still return a new 429 for its own current rate limit.',
      });
      await context.close();
      writeReport(report);
    }

    // 5. Unlocked state does not include a solution until an explicit reveal action.
    {
      const { context, page, state } = await newFixturePage(browser, 'reveal-flow', { questionMode: 'unlock' });
      await startGame(page);
      await question(page, '受控解锁状态问题');
      await page.getByRole('button', { name: '查看汤底' }).waitFor({ timeout: 8000 });
      const solutionHiddenBeforeReveal = await page.getByText('受控夹具汤底，仅用于验证展示协议，不是真实答案。', { exact: true }).count() === 0;
      const unlockedVisible = await page.getByText('必要线索已经集齐', { exact: true }).count() === 1;
      const clueVisible = await page.getByText('夹具公开线索内容', { exact: true }).count() === 1;
      await page.getByRole('button', { name: '查看汤底' }).click();
      await page.getByRole('heading', { name: '线索已拼合' }).waitFor({ timeout: 8000 });
      const solutionVisibleAfterReveal = await page.getByText('受控夹具汤底，仅用于验证展示协议，不是真实答案。', { exact: true }).count() === 1;
      const revealRequest = state.requests.find((r) => r.path?.endsWith('/reveal'));
      report.scenarios.push({
        name: 'Playing → unlocked without solution → user reveal → completed UI',
        status: solutionHiddenBeforeReveal && unlockedVisible && clueVisible && solutionVisibleAfterReveal ? 'passed' : 'failed',
        evidence: {
          unlockedStatusVisible: unlockedVisible,
          discoveredClueVisible: clueVisible,
          solutionHiddenBeforeReveal,
          solutionShownAfterReveal: solutionVisibleAfterReveal,
          revealRequestId: revealRequest?.requestId ?? null,
          requestLog: state.requests,
        },
        note: 'All puzzle and solution text in this scenario came from local fixtures. This validates UI/protocol transitions only; it does not validate AI output or a real answer.',
      });
      await context.close();
      writeReport(report);
    }

    report.status = report.scenarios.every((scenario) => scenario.status === 'passed') ? 'passed' : 'failed';
    report.completedAt = new Date().toISOString();
    writeReport(report);
    console.log(JSON.stringify({ status: report.status, scenarios: report.scenarios.map(({ name, status, evidence }) => ({ name, status, requestIds: [evidence.timeoutQuestionRequestId, evidence.retryQuestionRequestId, evidence.firstRequestId, evidence.retryRequestId, evidence.oldRequestId, evidence.revealRequestId].filter(Boolean), facts: { calibrationGetObserved: evidence.calibrationGetObserved, retryDisabledBeforeExpiry: evidence.retryDisabledBeforeExpiry, noRequestBeforeExpiry: evidence.noRequestBeforeExpiry, oldTextAbsentFromNewSession: evidence.oldTextAbsentFromNewSession, libraryHadOldCooldownNotice: evidence.libraryHadOldCooldownNotice, newGameEntryEnabledBeforeOriginalExpiry: evidence.newGameEntryEnabledBeforeOriginalExpiry, solutionHiddenBeforeReveal: evidence.solutionHiddenBeforeReveal, solutionShownAfterReveal: evidence.solutionShownAfterReveal } })), artifact: outputPath }, null, 2));
  } catch (error) {
    report.status = 'failed';
    report.error = String(error?.stack ?? error);
    report.completedAt = new Date().toISOString();
    writeReport(report);
    console.error(JSON.stringify({ status: report.status, scenarios: report.scenarios.map(({ name, status }) => ({ name, status })), error: report.error }, null, 2));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();
