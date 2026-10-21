import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire('C:/Users/15788/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/package.json');
const { chromium } = require('playwright');
const projectRoot = 'D:/下载/ai-turtle-soup';
const qaDirectory = resolve(projectRoot, 'artifacts/qa');
const edgePath = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const appUrl = 'http://127.0.0.1:5173/';
const healthUrl = 'http://127.0.0.1:8787/api/health';
const widths = [320, 390, 768];
const height = 900;
const report = {
  startedAtUtc: new Date().toISOString(),
  startedAtShanghai: localShanghaiTimestamp(),
  browser: { name: 'Microsoft Edge', executablePath: edgePath, userAgent: null, version: null, headless: true, disableGpu: true },
  appUrl,
  api: { healthUrl, healthStatus: null, configured: null },
  realBackend: true,
  aiCallsMade: false,
  results: [],
  errors: [],
};

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function checkNoHorizontalOverflow(page) {
  return page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth,
  }));
}

function localShanghaiTimestamp() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).format(new Date()) + ' Asia/Shanghai (UTC+08:00)';
}

await mkdir(qaDirectory, { recursive: true });
try {
  const healthResponse = await fetch(healthUrl);
  report.api.healthStatus = healthResponse.status;
  ensure(healthResponse.ok, `Direct backend health returned HTTP ${healthResponse.status}`);
  const healthPayload = await healthResponse.json();
  report.api.configured = healthPayload?.ai?.configured ?? null;
  ensure(report.api.configured === false, 'Expected the live backend to report AI configured=false');

  const browser = await chromium.launch({ executablePath: edgePath, headless: true, args: ['--disable-gpu'] });
  try {
    report.browser.engineVersion = browser.version();
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const pageErrors = [];
      const apiResponses = [];
      page.on('pageerror', (error) => pageErrors.push(error.name + ': ' + error.message));
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/api/')) {
          const safePath = url.pathname.replace(/\/sessions\/[^/]+(?=\/|$)/, '/sessions/:session');
          apiResponses.push({ method: response.request().method(), path: safePath, status: response.status() });
        }
      });

      const result = { width, height, assertions: {}, apiResponses, pageErrors };
      try {
        await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
        if (!report.browser.userAgent) {
          report.browser.userAgent = await page.evaluate(() => navigator.userAgent);
          report.browser.version = report.browser.userAgent.match(/Edg\/([0-9.]+)/)?.[1] ?? browser.version();
        }
        await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ state: 'visible' });
        await page.locator('.puzzle-row').first().waitFor({ state: 'visible' });
        result.assertions.libraryBrandAndFirstPuzzle = await page.getByText('AI 海龟汤', { exact: true }).isVisible()
          && await page.locator('.puzzle-row h3').count() > 0;
        ensure(result.assertions.libraryBrandAndFirstPuzzle, `${width}px: library brand or first puzzle missing`);

        const libraryOverflow = await checkNoHorizontalOverflow(page);
        result.assertions.libraryNoHorizontalOverflow = libraryOverflow.noHorizontalOverflow;
        ensure(libraryOverflow.noHorizontalOverflow, `${width}px: library has horizontal overflow`);

        if (width === 390) {
          await page.evaluate(() => document.fonts.ready);
          await page.screenshot({ path: resolve(qaDirectory, 'library-390.png'), fullPage: true });
          result.assertions.libraryScreenshotSaved = true;
        }

        await page.locator('.puzzle-row').first().locator('button.puzzle-start').click();
        await page.getByRole('region', { name: '提问与本局操作' }).waitFor({ state: 'visible' });
        await page.getByRole('alert').filter({ hasText: 'AI 未配置，提问和提示尚不可用' }).waitFor({ state: 'visible' });
        result.assertions.gameProgressZeroOfFour = await page.getByText('0 / 4 条必要线索', { exact: true }).isVisible();
        result.assertions.aiNotConfiguredInline = await page.getByRole('alert').filter({ hasText: 'AI 未配置，提问和提示尚不可用' }).isVisible();
        ensure(result.assertions.gameProgressZeroOfFour, `${width}px: game progress did not start at 0/4`);
        ensure(result.assertions.aiNotConfiguredInline, `${width}px: inline AI missing status is not visible`);

        const question = '我想进一步了解这个故事。';
        await page.getByLabel('提出你的问题').fill(question);
        result.assertions.genericQuestionRetained = await page.getByLabel('提出你的问题').inputValue() === question;
        result.assertions.askDisabledWhenUnconfigured = await page.getByRole('button', { name: '发送', exact: true }).isDisabled();
        result.assertions.hintDisabledWhenUnconfigured = await page.getByRole('button', { name: /提示 0 \/ 3/ }).isDisabled();
        ensure(result.assertions.genericQuestionRetained, `${width}px: generic example input was not retained`);
        ensure(result.assertions.askDisabledWhenUnconfigured, `${width}px: ask was enabled without configured AI`);
        ensure(result.assertions.hintDisabledWhenUnconfigured, `${width}px: hint was enabled without configured AI`);

        const gameOverflow = await checkNoHorizontalOverflow(page);
        result.assertions.gameNoHorizontalOverflow = gameOverflow.noHorizontalOverflow;
        ensure(gameOverflow.noHorizontalOverflow, `${width}px: game has horizontal overflow`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: resolve(qaDirectory, `game-unconfigured-${width}.png`), fullPage: true });
        result.assertions.gameScreenshotSaved = true;

        result.assertions.noQuestionOrHintRequestSent = !apiResponses.some(({ path }) => path.endsWith('/questions') || path.endsWith('/hints'));
        ensure(result.assertions.noQuestionOrHintRequestSent, `${width}px: unexpected question or hint request was sent`);

        const giveUpResponsePromise = page.waitForResponse((response) =>
          response.url().includes('/api/sessions/') && response.url().endsWith('/give-up'),
        { timeout: 15000 });
        await page.getByRole('button', { name: '放弃并看汤底' }).click();
        const giveUpResponse = await giveUpResponsePromise;
        result.assertions.realBackendGiveUpSucceeded = giveUpResponse.ok();
        ensure(giveUpResponse.ok(), `${width}px: live backend give-up returned HTTP ${giveUpResponse.status()}`);
        await page.getByRole('heading', { name: '汤底揭晓' }).waitFor({ state: 'visible' });
        result.assertions.givenUpStatusVisible = await page.getByText('已放弃', { exact: true }).isVisible();
        result.assertions.solutionVisible = (await page.locator('.solution-text').innerText()).trim().length > 0;
        ensure(result.assertions.givenUpStatusVisible, `${width}px: given-up status was not visible`);
        ensure(result.assertions.solutionVisible, `${width}px: backend solution text was empty`);

        const solutionOverflow = await checkNoHorizontalOverflow(page);
        result.assertions.solutionNoHorizontalOverflow = solutionOverflow.noHorizontalOverflow;
        ensure(solutionOverflow.noHorizontalOverflow, `${width}px: solution has horizontal overflow`);
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: resolve(qaDirectory, `solution-given-up-${width}.png`), fullPage: true });
        result.assertions.solutionScreenshotSaved = true;

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.getByRole('heading', { name: '选一道汤面' }).waitFor({ state: 'visible' });
        await page.locator('.puzzle-row').first().waitFor({ state: 'visible' });
        result.assertions.refreshReturnsToLibrary = await page.locator('.puzzle-row').first().isVisible();
        const storage = await page.evaluate(() => ({ keyCount: localStorage.length, keys: Object.keys(localStorage) }));
        result.assertions.localStorageHasNoHistory = storage.keyCount === 0;
        result.localStorageKeyCount = storage.keyCount;
        ensure(result.assertions.refreshReturnsToLibrary, `${width}px: refresh did not return to library`);
        ensure(result.assertions.localStorageHasNoHistory, `${width}px: localStorage was not empty after refresh`);

        result.assertions.noPageErrors = pageErrors.length === 0;
        ensure(result.assertions.noPageErrors, `${width}px: browser emitted a pageerror`);

        result.assertions.realBackendHealthAndPuzzleRead = apiResponses.some(({ path, status }) => path.endsWith('/health') && status === 200)
          && apiResponses.some(({ path, status }) => path.endsWith('/puzzles') && status === 200);
        ensure(result.assertions.realBackendHealthAndPuzzleRead, `${width}px: health or puzzle read did not return HTTP 200 through the app`);
        result.status = 'passed';
      } finally {
        result.apiResponses = apiResponses;
        result.pageErrors = pageErrors;
        report.results.push(result);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
} catch (error) {
  report.errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
} finally {
  report.finishedAtUtc = new Date().toISOString();
  report.finishedAtShanghai = localShanghaiTimestamp();
  report.status = report.errors.length === 0 && report.results.length === widths.length && report.results.every((result) => result.status === 'passed')
    ? 'passed'
    : 'failed';
  await writeFile(resolve(qaDirectory, 'browser-smoke.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    status: report.status,
    browser: report.browser,
    startedAtUtc: report.startedAtUtc,
    finishedAtUtc: report.finishedAtUtc,
    finishedAtShanghai: report.finishedAtShanghai,
    api: report.api,
    results: report.results.map(({ width, status, assertions, apiResponses, pageErrors, localStorageKeyCount }) => ({
      width, status, assertions, apiResponses, pageErrors, localStorageKeyCount,
    })),
    errors: report.errors,
  }, null, 2));
  if (report.status !== 'passed') process.exitCode = 1;
}
