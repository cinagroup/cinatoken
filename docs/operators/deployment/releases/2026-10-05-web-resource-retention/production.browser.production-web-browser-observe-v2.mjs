import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';
import { PUBLIC_PAGES, MISSING_MODEL_PATH, ACCOUNT_PAGES, ADMIN_FLAGS_AND_PAGES, ALL_FLAGS } from './web-route-matrix.mjs';

// This harness has no deployment or identity fixtures. Root supplies the independently
// verified release/version receipt; every observed HTTP response remains real.
const temp = path.dirname(fileURLToPath(import.meta.url));
const [label, configPath] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const allowedConfigKeys = new Set(['gitSHA', 'workerVersionId', 'phase', 'targetOrigin', 'canonicalOrigin', 'operatorVerifiedLiveVersion', 'all29FlagsEnabled', 'liveProof']);
assert.ok(Object.keys(config).every(key => allowedConfigKeys.has(key)), 'config contains only public execution metadata');
assert.match(config.gitSHA ?? '', /^[a-f0-9]{40}$/);
assert.match(config.workerVersionId ?? '', /^[a-f0-9-]{36}$/);
assert.ok(['preview', 'cutover'].includes(config.phase));
const target = new URL(config.targetOrigin);
assert.equal(target.protocol, 'https:');
assert.equal(target.pathname, '/');
assert.equal(target.search + target.hash + target.username + target.password, '');
assert.equal(config.canonicalOrigin, 'https://cinatoken.com');
if (config.phase === 'cutover') assert.equal(target.origin, config.canonicalOrigin);
assert.equal(config.operatorVerifiedLiveVersion, true);
assert.equal(config.all29FlagsEnabled, true);
assert.equal(ALL_FLAGS.length, 29);
assert.equal(ACCOUNT_PAGES.length + ADMIN_FLAGS_AND_PAGES.length, 37);
function raw(file) { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; }
assert.ok(config.liveProof?.path && config.liveProof?.bytes > 0);
assert.match(config.liveProof.sha256 ?? '', /^[a-f0-9]{64}$/);
assert.deepEqual(raw(config.liveProof.path), config.liveProof, 'Root live API proof raw binding');
const result = {
  schema: 'cinatoken-independent-web-real-browser-v2', startedAt: new Date().toISOString(),
  label, config: { ...config }, configRaw: raw(configPath),
  inputScripts: [raw(fileURLToPath(import.meta.url)), raw(path.join(temp, 'web-route-matrix.mjs'))],
  scope: 'Real independent Web public SSR/hydration and 37 anonymous private route gates; desktop/theme/locale/mobile',
  browserPlugin: 'absent', fallbackReason: 'Browser plugin not available; existing bundled Playwright and cached Chromium',
  realLogin: false, financialWrites: false, businessWrites: false,
  previewOriginLimit: config.phase === 'preview' ? 'Workers.dev UI does not certify production-host Cookie/OIDC/CSRF; Root must separately validate public-URL Service Binding forwarding' : null,
  pages: [], pageErrors: [], consoleErrors: [], warnings: [], httpErrors: [], requestFailures: [],
  expectedAnonymous401: [], expectedMissingModel404: [], unknownHTTPErrors: [],
  explainedConsoleErrors: [], unexplainedConsoleErrors: [], refusedMutations: [], screenshots: [], interactions: [],
};
let browser, context, page, deadline;
let closing = false;
const pending = new Set();
const output = path.join(temp, label + '.json');
assert.equal(fs.existsSync(output), false, 'fresh label only');
function observe(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); }
async function screenshot(name) {
  const file = path.join(temp, `${label}-${name}.png`);
  assert.equal(fs.existsSync(file), false);
  await page.screenshot({ path: file, fullPage: false });
  const value = raw(file); result.screenshots.push({ name, ...value }); return value;
}
async function snapshot() {
  return await page.evaluate(() => ({ url: location.href, lang: document.documentElement.lang,
    className: document.documentElement.className,
    dark: document.documentElement.classList.contains('dark'),
    hydrationFailure: document.documentElement.dataset.cinatokenHydration === 'failed',
    themeCookie: document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('cinatoken-theme=')) ?? null,
    localeCookie: document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('NEXT_LOCALE=')) ?? null,
    width: innerWidth, documentWidth: document.documentElement.scrollWidth,
  }));
}
async function settled() { await Promise.allSettled([...pending]); }
async function checkPage(route, kind, expectedStatus = 200, takeScreenshot = false) {
  const response = await page.goto(target.origin + route, { waitUntil: 'networkidle', timeout: 45000 });
  assert.equal(response?.status(), expectedStatus, route + ' document status');
  if (kind === 'account') {
    await page.getByText('Your account, one secure sign-in', { exact: true }).waitFor({ timeout: 20000 });
  } else if (kind === 'admin') {
    await page.locator('#console-access-title').filter({ hasText: 'Sign in to the console' }).waitFor({ timeout: 20000 });
  } else {
    await page.locator('main#main-content').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#cinatoken-public-bootstrap').count(), 1, route + ' actual SSR bootstrap');
  }
  const state = await snapshot();
  const bootstrap = kind === 'public' || kind === 'missing-model' ? await page.locator('#cinatoken-public-bootstrap').evaluate(node => {
    const value = JSON.parse(node.textContent ?? '');
    return { version: value.version, status: value.status, pathname: value.pathname, search: value.search, locale: value.locale };
  }) : null;
  const body = await page.locator('body').innerText();
  const metadata = bootstrap ? await page.evaluate(() => ({ canonical: [...document.querySelectorAll('link[rel=canonical]')].map(node => node.getAttribute('href')), ogURL: document.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? null, robots: document.querySelector('meta[name=robots]')?.getAttribute('content') ?? null })) : null;
  const overlays = await page.locator('nextjs-portal, vite-error-overlay, rsbuild-error-overlay, webpack-dev-server-client-overlay').count();
  const entry = { route, kind, http: response?.status(), finalURL: page.url(), title: await page.title(),
    state, bootstrap, metadata, nonblank: body.trim().length > 100, mainText: (await page.locator('main#main-content').innerText()).slice(0, 1800),
    body: body.slice(0, 7500), frameworkOverlay: overlays > 0 };
  result.pages.push(entry);
  assert.equal(new URL(entry.finalURL).pathname, route);
  assert.ok(entry.title.trim().length > 0, route + ' title');
  assert.ok(entry.nonblank, route + ' meaningful screen');
  assert.equal(entry.frameworkOverlay, false, route + ' framework overlay');
  assert.equal(state.hydrationFailure, false, route + ' hydration failure');
  if (bootstrap) {
    assert.equal(bootstrap.version, 1); assert.equal(bootstrap.status, expectedStatus);
    assert.equal(bootstrap.pathname, route); assert.equal(bootstrap.search, '');
    assert.equal(bootstrap.locale, 'en');
    if (expectedStatus === 200) {
      assert.deepEqual(metadata.canonical, [config.canonicalOrigin + route]);
      assert.equal(metadata.ogURL, config.canonicalOrigin + route);
      assert.equal(metadata.robots, route === '/en/chat' ? 'noindex, nofollow' : 'index, follow');
    } else { assert.deepEqual(metadata.canonical, []); assert.equal(metadata.ogURL, null); assert.equal(metadata.robots, 'noindex, nofollow'); }
  }
  if (kind === 'account') assert.equal(await page.locator('#workspace').count(), 0, 'anonymous has no workspace picker');
  if (kind === 'admin') assert.equal(await page.getByRole('navigation', { name: 'Console navigation', exact: true }).count(), 0, 'anonymous has no privileged navigation');
  if (takeScreenshot) entry.screenshot = await screenshot(kind + '-' + result.pages.length);
  console.log(JSON.stringify({ progress: 'page-checked', route, kind, http: entry.http, pagesChecked: result.pages.length }));
  await settled();
}
try {
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/cina/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe' });
  deadline = setTimeout(async () => { result.timedOut = true; try { await browser?.close(); } catch (error) { result.timeoutCloseError = error.message; } }, 390000);
  result.browserVersion = browser.version();
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' });
  result.initialCookies = [];
  await context.route('**/*', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      result.refusedMutations.push({ method: route.request().method(), url: route.request().url() });
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => result.pageErrors.push({ message: error.message, url: page.url() }));
  page.on('console', message => {
    const item = { text: message.text(), location: message.location(), pageURL: page.url() };
    if (message.type() === 'error') result.consoleErrors.push(item);
    if (message.type() === 'warning') result.warnings.push(item);
  });
  page.on('requestfailed', request => { if (!closing) result.requestFailures.push({ url: request.url(), method: request.method(), failure: request.failure() }); });
  page.on('response', response => {
    if (response.status() < 400) return;
    observe((async () => {
      const item = { url: response.url(), method: response.request().method(), status: response.status(), body: null };
      try { const body = await response.text(); try { item.body = JSON.parse(body); } catch { item.body = body.slice(0, 8192); } } catch {}
      result.httpErrors.push(item);
      const u = new URL(item.url);
      if (u.origin === target.origin && u.pathname === '/api/user/me' && item.method === 'GET' && item.status === 401 && item.body?.success === false && item.body?.message === 'Unauthorized') {
        result.expectedAnonymous401.push({ ...item, reason: 'Only exact same-origin anonymous user/me body is expected; SessionGate/ConsoleGate display sign-in and grant no workspace/console.' });
      } else if (u.origin === target.origin && u.pathname === MISSING_MODEL_PATH && item.method === 'GET' && item.status === 404 && typeof item.body === 'string' && item.body.includes('cinatoken-public-bootstrap')) {
        result.expectedMissingModel404.push({ ...item, reason: 'The reserved nonexistent model renders real localized public 404; no nonempty production catalog claim.' });
      } else result.unknownHTTPErrors.push(item);
    })());
  });
  for (const route of PUBLIC_PAGES) await checkPage(route, 'public', 200, route === '/en' || route === '/en/models');
  await checkPage(MISSING_MODEL_PATH, 'missing-model', 404, false);
  for (const route of ACCOUNT_PAGES) await checkPage(route, 'account', 200, route === '/account');
  for (const [, route] of ADMIN_FLAGS_AND_PAGES) await checkPage(route, 'admin', 200, route === '/admin');
  await page.goto(target.origin + '/en', { waitUntil: 'networkidle', timeout: 45000 });
  await page.locator('header select:has(option[value="dark"])').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.classList.contains('dark') && document.cookie.split(';').some(v => v.trim() === 'cinatoken-theme=dark'));
  result.interactions.push({ step: 'desktop-dark-selected', ...await snapshot() });
  await screenshot('desktop-dark');
  await Promise.all([
    page.waitForURL(target.origin + '/zh', { waitUntil: 'networkidle', timeout: 45000 }),
    page.locator('header select:has(option[value="zh"])').selectOption('zh'),
  ]);
  await page.waitForFunction(() => document.documentElement.lang === 'zh' && document.documentElement.classList.contains('dark'));
  result.interactions.push({ step: 'language-zh-navigated', ...await snapshot() });
  assert.equal(await page.locator('header select:has(option[value="zh"])').inputValue(), 'zh');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForFunction(() => document.documentElement.lang === 'zh' && document.documentElement.classList.contains('dark'));
  const mobile = await snapshot(); result.interactions.push({ step: 'mobile-zh-dark-reload', ...mobile });
  assert.equal(mobile.themeCookie, 'cinatoken-theme=dark');
  assert.equal(mobile.hydrationFailure, false);
  assert.ok(mobile.documentWidth <= mobile.width + 1, 'mobile horizontal overflow');
  await screenshot('mobile-zh-dark');
  await settled();
  for (const entry of result.consoleErrors) {
    const matching = [...result.expectedAnonymous401, ...result.expectedMissingModel404].find(item => item.url === entry.location?.url && new RegExp(`^Failed to load resource: the server responded with a status of ${item.status}(?:\\s|$)`).test(entry.text));
    if (matching) result.explainedConsoleErrors.push({ ...entry, responseURL: matching.url, reason: matching.reason });
    else result.unexplainedConsoleErrors.push(entry);
  }
  assert.equal(result.pages.length, 45, 'all 8 public kinds and 37 private route gates');
  assert.equal(result.refusedMutations.length, 0, 'no attempted business/API mutation');
  assert.equal(result.requestFailures.length, 0, 'no unexplained failed request');
  assert.equal(result.pageErrors.length, 0, 'real runtime errors');
  assert.equal(result.unknownHTTPErrors.length, 0, 'unknown HTTP errors');
  assert.equal(result.unexplainedConsoleErrors.length, 0, 'unexplained console errors');
  assert.equal(result.warnings.length, 0, 'unexplained warnings');
  result.actualExit = 0; result.outcome = 'PASS_REAL_WEB_ENTRY_ANONYMOUS_GATES_AND_THEME_LOCALE_MOBILE';
} catch (error) {
  result.actualExit = 1; result.outcome = 'FAILED'; result.failure = { name: error.name, message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { try { result.failureScreenshot = await screenshot('failure'); result.failureState = await snapshot(); result.failureBody = (await page.locator('body').innerText()).slice(0, 10000); } catch {} }
} finally {
  clearTimeout(deadline);
  if (result.timedOut) result.actualExit = 1;
  await settled(); closing = true;
  try { await context?.close(); result.contextClosed = true; } catch (error) { result.contextClosed = false; result.closeError = error.message; result.actualExit = 1; }
  try { await browser?.close(); result.browserClosed = true; } catch (error) { result.browserClosed = false; result.browserCloseError = error.message; result.actualExit = 1; }
  result.finishedAt = new Date().toISOString();
  try { assert.deepEqual(raw(config.liveProof.path), config.liveProof); result.liveProofRawStillSame = true; } catch (error) { result.liveProofRawStillSame = false; result.bindingFailure = error.message; result.actualExit = 1; }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ actualExit: result.actualExit, outcome: result.outcome, failure: result.failure,
    evidence: raw(output), pages: result.pages.length, screenshots: result.screenshots,
    pageErrors: result.pageErrors, unknownHTTPErrors: result.unknownHTTPErrors,
    unexplainedConsoleErrors: result.unexplainedConsoleErrors, expectedAnonymous401: result.expectedAnonymous401.length,
    contextClosed: result.contextClosed, browserClosed: result.browserClosed }));
}
process.exitCode = result.actualExit;
