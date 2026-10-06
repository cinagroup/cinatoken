import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { verifyV4Seals, attachReadinessObserver, beginNavigation, documentReady, functionalReady, inspectFailure, observeNetworkCheckpoint, collectReadinessNetwork, requireReadinessMetadata } from './readiness-v4.mjs';
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
  schema: 'cinatoken-functional-anonymous-web-browser-v4', startedAt: new Date().toISOString(),
  label, config: { ...config }, configRaw: raw(configPath),
  inputScripts: [raw(fileURLToPath(import.meta.url)), raw(path.join(temp, 'web-route-matrix.mjs')), raw(path.join(temp, 'readiness-v4.mjs'))],
  scope: 'Functional anonymous Web browser only: all original 45 route/UI/metadata/security assertions plus real public reactive readiness and 37 exact anonymous401; not the original networkidle matrix, real identity, performance P8-09 or full G8',
  scheduling: 'Original four fresh anonymous contexts public8/account10/admin14/admin13; HTTP routing cache remains disabled. DOMContentLoaded followed by exact UI readiness, required current-page JS/CSS completion and public reactive controls. Original v2/v3 failures remain unchanged.',
  browserDeadlineMs: 390000, executorDeadlineMs: 420000, shards: [], groupSettled: [],
  browserPlugin: 'absent', fallbackReason: 'Browser plugin not available; existing bundled Playwright and cached Chromium',
  realLogin: false, financialWrites: false, businessWrites: false,
  previewOriginLimit: config.phase === 'preview' ? 'Workers.dev UI does not certify production-host Cookie/OIDC/CSRF; Root must separately validate public-URL Service Binding forwarding' : null,
  pages: [], pageErrors: [], consoleErrors: [], warnings: [], httpErrors: [], requestFailures: [],
  expectedAnonymous401: [], expectedMissingModel404: [], unknownHTTPErrors: [],
  explainedConsoleErrors: [], unexplainedConsoleErrors: [], refusedMutations: [], screenshots: [], interactions: [],
};

let browser, deadline;
let closing = false;
const output = path.join(temp, label + '.json');
assert.equal(fs.existsSync(output), false, 'fresh label only');
result.v4SealedBefore = verifyV4Seals();
result.readinessMethod = { navigationWaitUntil: 'domcontentloaded', navigationTimeoutMs: 45000, originalLocatorTimeoutMs: 20000, addedAppReadinessBudgetMs: 20000, browserDeadlineMs: 390000, executorDeadlineMs: 420000, networkidleMeasuredOrPassed: false, performanceP809Complete: false, realIdentityTested: false, fullG8Complete: false };
const configAtStart = raw(configPath);
const selfAtStart = raw(fileURLToPath(import.meta.url));
const originalV2 = [{"path":"C:\\Users\\cina\\AppData\\Local\\Temp\\cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197\\production-web-browser-observe-v2.mjs","bytes":15695,"sha256":"415d123bbc71cfdb5d8ed02bf91f01d9021031358667cd7aaf2f0fd6edcd55be"},{"path":"C:\\Users\\cina\\AppData\\Local\\Temp\\cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197\\execute-web-browser-observe-v2.mjs","bytes":3432,"sha256":"ffd074ec8b52d5ce7c9dbd8a9dace29ec29130b661e0290e72f1f2d2d0424ed8"},{"path":"C:\\Users\\cina\\AppData\\Local\\Temp\\cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197\\web-route-matrix.mjs","bytes":1770,"sha256":"c8a3211d07979c037022f689aa442bd95de9b7c11843fb52b9ae9fa93ac01e61"}];
result.unchangedV2Scripts = originalV2;
for (const item of originalV2) assert.deepEqual(raw(item.path), item, 'sealed v2 input before browser execution');
assert.equal(raw(path.join(temp, 'web-route-matrix.mjs')).sha256, originalV2.find(item => item.path.endsWith('web-route-matrix.mjs')).sha256);
const SHARDS = [
  { name: 'public', kind: 'public', routes: [...PUBLIC_PAGES, MISSING_MODEL_PATH] },
  { name: 'account', kind: 'account', routes: [...ACCOUNT_PAGES] },
  { name: 'admin-a', kind: 'admin', routes: ADMIN_FLAGS_AND_PAGES.slice(0, 14).map(([, route]) => route) },
  { name: 'admin-b', kind: 'admin', routes: ADMIN_FLAGS_AND_PAGES.slice(14).map(([, route]) => route) },
];
assert.deepEqual(SHARDS.map(shard => shard.routes.length), [8, 10, 14, 13]);
const expectedRoutes = SHARDS.flatMap(shard => shard.routes);
assert.equal(expectedRoutes.length, 45); assert.equal(new Set(expectedRoutes).size, 45);
const expectedTuples = [
  ...PUBLIC_PAGES.map(route => [route, 'public', 200]),
  [MISSING_MODEL_PATH, 'missing-model', 404],
  ...ACCOUNT_PAGES.map(route => [route, 'account', 200]),
  ...ADMIN_FLAGS_AND_PAGES.map(([, route]) => [route, 'admin', 200]),
];
result.expectedRouteTuples = expectedTuples;
const arrays = ['pageErrors', 'consoleErrors', 'warnings', 'httpErrors', 'requestFailures', 'expectedAnonymous401', 'expectedMissingModel404', 'unknownHTTPErrors', 'explainedConsoleErrors', 'unexplainedConsoleErrors', 'refusedMutations'];
const groups = [];
function observe(group, promise) {
  group.pending.add(promise);
  promise.then(() => group.pending.delete(promise), error => { group.pending.delete(promise); group.state.observerFailures.push({ name: error.name, message: error.message }); });
}
async function screenshot(group, name) {
  const page = group.page;
  const file = path.join(temp, `${label}-${name}.png`);
  assert.equal(fs.existsSync(file), false);
  await page.screenshot({ path: file, fullPage: false });
  const value = raw(file); result.screenshots.push({ name, ...value }); return value;
}
async function snapshot(group) {
  const page = group.page;
  return await page.evaluate(() => ({ url: location.href, lang: document.documentElement.lang,
    className: document.documentElement.className,
    dark: document.documentElement.classList.contains('dark'),
    hydrationFailure: document.documentElement.dataset.cinatokenHydration === 'failed',
    themeCookie: document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('cinatoken-theme=')) ?? null,
    localeCookie: document.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('NEXT_LOCALE=')) ?? null,
    width: innerWidth, documentWidth: document.documentElement.scrollWidth,
  }));
}
async function settled(group) { await Promise.allSettled([...group.pending]); }
async function checkPage(group, route, kind, expectedStatus = 200, takeScreenshot = false) {
  const page = group.page;
  beginNavigation(group, route, kind);
  const response = await page.goto(target.origin + route, { waitUntil: 'domcontentloaded', timeout: 45000 });
  documentReady(group);
  assert.equal(response?.status(), expectedStatus, route + ' document status');
  if (kind === 'account') {
    await page.getByText('Your account, one secure sign-in', { exact: true }).waitFor({ timeout: 20000 });
  } else if (kind === 'admin') {
    await page.locator('#console-access-title').filter({ hasText: 'Sign in to the console' }).waitFor({ timeout: 20000 });
  } else {
    await page.locator('main#main-content').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('#cinatoken-public-bootstrap').count(), 1, route + ' actual SSR bootstrap');
  }
  const functionalReadinessProof = await functionalReady(group, route, kind);
  const state = await snapshot(group);
  const bootstrap = kind === 'public' || kind === 'missing-model' ? await page.locator('#cinatoken-public-bootstrap').evaluate(node => {
    const value = JSON.parse(node.textContent ?? '');
    return { version: value.version, status: value.status, pathname: value.pathname, search: value.search, locale: value.locale };
  }) : null;
  const body = await page.locator('body').innerText();
  const metadata = bootstrap ? await page.evaluate(() => ({ canonical: [...document.querySelectorAll('link[rel=canonical]')].map(node => node.getAttribute('href')), ogURL: document.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? null, robots: document.querySelector('meta[name=robots]')?.getAttribute('content') ?? null })) : null;
  const overlays = await page.locator('nextjs-portal, vite-error-overlay, rsbuild-error-overlay, webpack-dev-server-client-overlay').count();
  const entry = { shard: group.state.name, route, kind, http: response?.status(), finalURL: page.url(), title: await page.title(),
    state, bootstrap, metadata, nonblank: body.trim().length > 100, mainText: (await page.locator('main#main-content').innerText()).slice(0, 1800),
    body: body.slice(0, 7500), frameworkOverlay: overlays > 0 };
  entry.functionalReadiness = functionalReadinessProof;
  result.pages.push(entry); group.state.pages.push(entry);
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
  if (takeScreenshot) entry.screenshot = await screenshot(group, group.state.name + '-' + group.state.pages.length);
  console.log(JSON.stringify({ progress: 'page-checked', shard: group.state.name, route, kind, http: entry.http, pagesChecked: result.pages.length, shardPagesChecked: group.state.pages.length }));
  await settled(group);
}
async function runThemeLocaleMobile(group) {
  const page = group.page;
  beginNavigation(group, '/en', 'public', 'original-desktop-dark-reset');
  await page.goto(target.origin + '/en', { waitUntil: 'domcontentloaded', timeout: 45000 });
  documentReady(group);
  await functionalReady(group, '/en', 'public');
  await page.locator('header select:has(option[value="dark"])').selectOption('dark');
  await page.waitForFunction(() => document.documentElement.classList.contains('dark') && document.cookie.split(';').some(v => v.trim() === 'cinatoken-theme=dark'));
  result.interactions.push({ step: 'desktop-dark-selected', ...await snapshot(group) });
  await screenshot(group, 'desktop-dark');
  beginNavigation(group, '/zh', 'public', 'original-locale-navigation');
  await Promise.all([
    page.waitForURL(target.origin + '/zh', { waitUntil: 'domcontentloaded', timeout: 45000 }),
    page.locator('header select:has(option[value="zh"])').selectOption('zh'),
  ]);
  documentReady(group);
  await functionalReady(group, '/zh', 'public');
  await page.waitForFunction(() => document.documentElement.lang === 'zh' && document.documentElement.classList.contains('dark'));
  result.interactions.push({ step: 'language-zh-navigated', ...await snapshot(group) });
  assert.equal(await page.locator('header select:has(option[value="zh"])').inputValue(), 'zh');
  await page.setViewportSize({ width: 390, height: 844 });
  beginNavigation(group, '/zh', 'public', 'original-mobile-reload');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  documentReady(group);
  await functionalReady(group, '/zh', 'public');
  await page.waitForFunction(() => document.documentElement.lang === 'zh' && document.documentElement.classList.contains('dark'));
  const mobile = await snapshot(group); result.interactions.push({ step: 'mobile-zh-dark-reload', ...mobile });
  assert.equal(mobile.themeCookie, 'cinatoken-theme=dark');
  assert.equal(mobile.hydrationFailure, false);
  assert.ok(mobile.documentWidth <= mobile.width + 1, 'mobile horizontal overflow');
  await screenshot(group, 'mobile-zh-dark');
  await settled(group);
}
async function prepareGroup(spec) {
  const state = { name: spec.name, kind: spec.kind, expectedRoutes: spec.routes, pages: [], initialCookies: null, initialServiceWorkers: null, finalServiceWorkers: null, serviceWorkerEvents: [], observerFailures: [], contextClosed: false };
  for (const key of arrays) state[key] = [];
  const group = { state, context: null, page: null, pending: new Set() };
  groups.push(group); result.shards.push(state);
  group.context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' });
  state.initialCookies = await group.context.cookies();
  assert.deepEqual(state.initialCookies, [], spec.name + ' fresh anonymous cookies');
  state.initialServiceWorkers = group.context.serviceWorkers().map(worker => worker.url());
  assert.deepEqual(state.initialServiceWorkers, [], spec.name + ' no initial Service Worker');
  group.context.on('serviceworker', worker => {
    state.serviceWorkerEvents.push({ url: worker.url(), observedAt: new Date().toISOString() });
    state.guardFailure = 'Service Worker appeared outside route guard coverage; strict failure and fail-closed browser shutdown.';
    void browser.close().catch(error => { state.serviceWorkerShutdownError = error.message; });
  });
  await group.context.route('**/*', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      state.refusedMutations.push({ shard: spec.name, method: route.request().method(), url: route.request().url() });
      await route.abort('blockedbyclient'); return;
    }
    await route.continue();
  });
  group.page = await group.context.newPage();
  const page = group.page;
  attachReadinessObserver(group, target.origin, () => closing);
  page.on('pageerror', error => state.pageErrors.push({ shard: spec.name, message: error.message, url: page.url() }));
  page.on('console', message => {
    const item = { shard: spec.name, text: message.text(), location: message.location(), pageURL: page.url() };
    if (message.type() === 'error') state.consoleErrors.push(item);
    if (message.type() === 'warning') state.warnings.push(item);
  });
  page.on('requestfailed', request => { if (!closing) state.requestFailures.push({ shard: spec.name, pageURL: page.url(), url: request.url(), method: request.method(), failure: request.failure() }); });
  page.on('response', response => {
    if (response.status() < 400) return;
    const item = { shard: spec.name, pageURL: page.url(), url: response.url(), method: response.request().method(), status: response.status(), body: null };
    observe(group, (async () => {
      try { const body = await response.text(); try { item.body = JSON.parse(body); } catch { item.body = body.slice(0, 8192); } } catch {}
      state.httpErrors.push(item);
      const u = new URL(item.url);
      if (u.origin === target.origin && u.pathname === '/api/user/me' && item.method === 'GET' && item.status === 401 && item.body?.success === false && item.body?.message === 'Unauthorized') {
        state.expectedAnonymous401.push({ ...item, reason: 'Only exact same-origin anonymous user/me body is expected; SessionGate/ConsoleGate display sign-in and grant no workspace/console.' });
      } else if (u.origin === target.origin && u.pathname === MISSING_MODEL_PATH && item.method === 'GET' && item.status === 404 && typeof item.body === 'string' && item.body.includes('cinatoken-public-bootstrap')) {
        state.expectedMissingModel404.push({ ...item, reason: 'The reserved nonexistent model renders real localized public 404; no nonempty production catalog claim.' });
      } else state.unknownHTTPErrors.push(item);
    })());
  });
  return group;
}
async function runGroup(group) {
  const state = group.state;
  state.startedAt = new Date().toISOString();
  try {
    for (const [index, route] of state.expectedRoutes.entries()) {
      const missing = route === MISSING_MODEL_PATH;
      const kind = missing ? 'missing-model' : state.kind;
      const takeScreenshot = state.kind === 'public' ? route === '/en' || route === '/en/models' : index === 0;
      await checkPage(group, route, kind, missing ? 404 : 200, takeScreenshot);
    }
    if (state.name === 'public') await runThemeLocaleMobile(group);
    await settled(group);
    state.status = 'fulfilled';
  } catch (error) {
    state.networkFailurePending = inspectFailure(group, error);
    state.status = 'rejected'; state.failure = { name: error.name, message: error.message, stack: error.stack };
    if (group.page && !group.page.isClosed()) {
      try { state.failureScreenshot = await screenshot(group, state.name + '-failure'); state.failureState = await snapshot(group); state.failureBody = (await group.page.locator('body').innerText()).slice(0, 10000); } catch {}
    }
    throw error;
  } finally { state.finishedAt = new Date().toISOString(); }
}
function classifyConsoleAndAggregate() {
  for (const group of groups) {
    const state = group.state;
    for (const entry of state.consoleErrors) {
      const matching = [...state.expectedAnonymous401, ...state.expectedMissingModel404].find(item => item.shard === entry.shard && item.url === entry.location?.url && new RegExp('^Failed to load resource: the server responded with a status of ' + item.status + '(?:\\s|$)').test(entry.text));
      if (matching) state.explainedConsoleErrors.push({ ...entry, responseURL: matching.url, reason: matching.reason });
      else state.unexplainedConsoleErrors.push(entry);
    }
  }
  for (const key of arrays) result[key] = groups.flatMap(group => group.state[key]);
  result.consoleClassificationExecuted = true;
}
try {
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/cina/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe' });
  deadline = setTimeout(async () => { result.timedOut = true; try { await browser?.close(); } catch (error) { result.timeoutCloseError = error.message; } }, 390000);
  result.browserVersion = browser.version();
  for (const spec of SHARDS) await prepareGroup(spec);
  const settledGroups = await Promise.allSettled(groups.map(group => runGroup(group)));
  result.groupSettled = settledGroups.map((entry, index) => ({ shard: groups[index].state.name, status: entry.status, reason: entry.status === 'rejected' ? { name: entry.reason.name, message: entry.reason.message } : null }));
} catch (error) {
  result.failure = { name: error.name, message: error.message, stack: error.stack };
} finally {
  await Promise.allSettled(groups.map(group => settled(group)));
  clearTimeout(deadline); closing = true;
  await Promise.allSettled(groups.map(async group => {
    try {
      group.state.networkBeforeClose = observeNetworkCheckpoint(group);
      group.state.finalServiceWorkers = group.context?.serviceWorkers().map(worker => worker.url()) ?? null;
      await group.context?.close();
      group.state.contextClosed = group.context?.isClosed() === true;
    } catch (error) { group.state.contextClosed = false; group.state.closeError = error.message; }
  }));
  result.contextClosed = groups.length === 4 && groups.every(group => group.state.contextClosed);
  try { await browser?.close(); result.browserClosed = browser?.isConnected() === false; } catch (error) { result.browserClosed = false; result.browserCloseError = error.message; }
  await Promise.allSettled(groups.map(group => settled(group)));
  classifyConsoleAndAggregate();
  result.readinessNetwork = collectReadinessNetwork(groups);
  result.finishedAt = new Date().toISOString();
  try { assert.deepEqual(raw(config.liveProof.path), config.liveProof); result.liveProofRawStillSame = true; } catch (error) { result.liveProofRawStillSame = false; result.bindingFailure = error.message; }
  try {
    assert.deepEqual(raw(configPath), configAtStart); assert.deepEqual(raw(fileURLToPath(import.meta.url)), selfAtStart);
    for (const item of originalV2) assert.deepEqual(raw(item.path), item);
    assert.equal(raw(path.join(temp, 'web-route-matrix.mjs')).sha256, originalV2.find(item => item.path.endsWith('web-route-matrix.mjs')).sha256);
    result.sourceAndConfigRawStillSame = true;
  } catch (error) { result.sourceAndConfigRawStillSame = false; result.inputFailure = error.message; }
  try {
    assert.equal(result.failure, undefined, 'no setup failure');
    assert.equal(result.groupSettled.length, 4, 'four groups converged');
    assert.ok(result.groupSettled.every(entry => entry.status === 'fulfilled'), 'all groups fulfilled');
    assert.equal(result.timedOut ?? false, false, 'original 390 second browser deadline');
    assert.equal(result.pages.length, 45, 'all 8 public kinds and 37 private route gates');
    assert.equal(new Set(result.pages.map(entry => entry.route)).size, 45, '45 unique direct routes');
    assert.deepEqual(result.pages.map(entry => entry.route).sort(), [...expectedRoutes].sort(), 'exact original route matrix');
    assert.deepEqual(result.pages.map(entry => JSON.stringify([entry.route, entry.kind, entry.http])).sort(), expectedTuples.map(tuple => JSON.stringify(tuple)).sort(), 'exact original route/kind/http tuple matrix');
    for (const group of groups) {
      assert.deepEqual(group.state.pages.map(entry => entry.route).sort(), [...group.state.expectedRoutes].sort(), group.state.name + ' exact route set');
      assert.deepEqual(group.state.initialCookies, [], group.state.name + ' anonymous context');
      assert.deepEqual(group.state.initialServiceWorkers, [], group.state.name + ' no initial service worker');
      assert.deepEqual(group.state.finalServiceWorkers, [], group.state.name + ' no final service worker');
      assert.equal(group.state.serviceWorkerEvents.length, 0, group.state.name + ' no unguarded service worker');
      assert.equal(group.state.observerFailures.length, 0, group.state.name + ' complete HTTP body observation');
      assert.equal(group.state.contextClosed, true, group.state.name + ' real context closure');
    }
    assert.equal(result.expectedAnonymous401.length, 37, '37 exact anonymous user/me 401 responses');
    const privatePages = result.pages.filter(entry => entry.kind === 'account' || entry.kind === 'admin');
    assert.equal(privatePages.length, 37, '37 completed private pages');
    result.anonymous401PerPage = privatePages.map(entry => {
      const matching = result.expectedAnonymous401.filter(item => item.shard === entry.shard && new URL(item.pageURL).origin === target.origin && new URL(item.pageURL).pathname === entry.route);
      assert.equal(matching.length, 1, entry.shard + ' ' + entry.route + ' exactly one originating-page anonymous 401');
      return { shard: entry.shard, route: entry.route, expected401Count: matching.length, responseURL: matching[0].url, originatingPageURL: matching[0].pageURL };
    });
    assert.equal(result.expectedMissingModel404.length, 1, 'one exact reserved missing-model 404 response');
    assert.equal(result.refusedMutations.length, 0, 'no attempted business/API mutation');
    assert.equal(result.requestFailures.length, 0, 'no unexplained failed request');
    assert.equal(result.pageErrors.length, 0, 'real runtime errors');
    assert.equal(result.unknownHTTPErrors.length, 0, 'unknown HTTP errors');
    assert.equal(result.unexplainedConsoleErrors.length, 0, 'unexplained console errors');
    assert.equal(result.warnings.length, 0, 'unexplained warnings');
    assert.deepEqual(result.interactions.map(entry => entry.step), ['desktop-dark-selected', 'language-zh-navigated', 'mobile-zh-dark-reload'], 'all three original interactions');
    assert.equal(result.contextClosed, true, 'all four contexts closed'); assert.equal(result.browserClosed, true, 'browser closed');
    assert.equal(result.liveProofRawStillSame, true); assert.equal(result.sourceAndConfigRawStillSame, true);
    requireReadinessMetadata(groups);
    result.v4SealedAfter = verifyV4Seals();
    result.actualExit = 0; result.outcome = 'PASS_FUNCTIONAL_ANONYMOUS_WEB_BROWSER_V4_ONLY';
  } catch (error) {
    result.actualExit = 1; result.outcome = 'FAILED'; result.validationFailure = { name: error.name, message: error.message, stack: error.stack };
    result.failure ??= groups.find(group => group.state.failure)?.state.failure ?? result.validationFailure;
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ actualExit: result.actualExit, outcome: result.outcome, failure: result.failure,
    evidence: raw(output), pages: result.pages.length, screenshots: result.screenshots,
    pageErrors: result.pageErrors, unknownHTTPErrors: result.unknownHTTPErrors, unexplainedConsoleErrors: result.unexplainedConsoleErrors,
    expectedAnonymous401: result.expectedAnonymous401.length, expectedMissingModel404: result.expectedMissingModel404.length,
    contextClosed: result.contextClosed, browserClosed: result.browserClosed, shards: result.shards.map(shard => ({ name: shard.name, pages: shard.pages.length, status: shard.status, contextClosed: shard.contextClosed })) }));
}
process.exitCode = result.actualExit;
