import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const temp = path.dirname(fileURLToPath(import.meta.url));
const [label, configPath] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const allowed = new Set(['gitSHA', 'workerVersionId', 'phase', 'targetOrigin', 'canonicalOrigin', 'operatorVerifiedLiveVersion', 'all29FlagsEnabled', 'liveProof']);
assert.ok(Object.keys(config).every(k => allowed.has(k)), 'public metadata only');
assert.match(config.gitSHA ?? '', /^[a-f0-9]{40}$/);
assert.match(config.workerVersionId ?? '', /^[a-f0-9-]{36}$/);
assert.equal(config.phase, 'cutover');
assert.equal(config.targetOrigin, 'https://cinatoken.com');
assert.equal(config.canonicalOrigin, config.targetOrigin);
assert.equal(config.operatorVerifiedLiveVersion, true);
assert.equal(config.all29FlagsEnabled, true);
assert.deepEqual(raw(config.liveProof.path), config.liveProof, 'fresh Root Cloudflare proof binding');
const preparationPath = path.join(temp, 'preparation.receipt.json');
const preparation = JSON.parse(fs.readFileSync(preparationPath, 'utf8'));
for (const item of preparation.sealedInputs) assert.deepEqual(raw(item.path), item, 'unchanged historical sealed input');
assert.deepEqual(raw(fileURLToPath(import.meta.url)), preparation.diagnosticScript);
const output = path.join(temp, label + '.json');
const journalPath = path.join(temp, label + '-events.jsonl');
assert.equal(fs.existsSync(output), false);
assert.equal(fs.existsSync(journalPath), false);
const journal = fs.openSync(journalPath, 'wx');
const started = performance.now();
const rel = () => Math.round((performance.now() - started) * 1000) / 1000;
function safeURL(value) {
  try { const u = new URL(value); u.username = ''; u.password = ''; for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '[redacted]'); u.hash = u.hash ? '#[redacted]' : ''; return u.toString(); }
  catch { return String(value).replace(/(token|authorization|cookie|state|password|secret|code)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]').slice(0, 500); }
}
function safeText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/g, safeURL).replace(/(token|authorization|cookie|state|password|secret|code)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]').replace(/Bearer\s+[\w.+/-]+/ig, 'Bearer [redacted]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted-jwt]').slice(0, 4000);
}
const permittedHeaders = new Set(['content-type', 'content-length', 'cache-control', 'cf-cache-status', 'age', 'server-timing', 'etag', 'last-modified', 'vary', 'cf-ray', 'date', 'server', 'content-encoding']);
function headers(value) { return Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => permittedHeaders.has(key.toLowerCase())).map(([key, val]) => [key.toLowerCase(), safeText(val)])); }
function event(type, data) { fs.writeSync(journal, JSON.stringify({ type, atMs: rel(), ...data }) + '\n'); }
function errorValue(error) { return { name: error.name, message: safeText(error.message) }; }
async function bounded(promise, timeout, description) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description + ' bounded timeout')), timeout); })]); }
  finally { clearTimeout(timer); }
}
const result = {
  schema: 'cinatoken-production-network-diagnostic-v1', label, startedAt: new Date().toISOString(), config, configRaw: raw(configPath), preparationRaw: raw(preparationPath),
  flow: 'Anonymous direct /account/withdraw -> sign-in gate; /admin/config/timezone -> console sign-in gate; /en -> public control.',
  scope: 'Three route network diagnostic only; does not replace or pass the historical failed 45-route matrix.',
  originalNetworkidleTimeoutMs: 45000, browserDeadlineMs: 165000, executorDeadlineMs: 180000,
  browserPlugin: 'absent', fallbackReason: 'Browser plugin not available', browserExpectedVersion: '147.0.7727.15', playwrightVersion: '1.62.1',
  viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light', scheduling: 'Single fresh anonymous context, one page, three sequential direct navigations; original GET/HEAD guard disables HTTP cache.',
  sourceWrites: 0, deployments: 0, databaseWrites: 0, apiWrites: 0, realLogin: false,
  initialCookieCount: null, initialServiceWorkerCount: null, serviceWorkerEvents: [], refusedMutations: [], pages: [], pageErrors: [], console: [], screenshots: [], observerErrors: [],
  eventJournal: journalPath, requests: [], cdpRequests: [], contextClosed: false, browserClosed: false, actualExit: 1,
};
let browser, context, page, cdp, deadline, closing = false, nav = null, reqSequence = 0;
const requests = new Map();
const cdpRequests = new Map();
const tasks = new Set();
function observe(promise) { tasks.add(promise); promise.then(() => tasks.delete(promise), error => { tasks.delete(promise); result.observerErrors.push(errorValue(error)); }); }
function requestRecord(req) {
  let item = requests.get(req);
  if (!item) { const previous = req.redirectedFrom(); item = { id: 'pw-' + (++reqSequence), navigation: nav?.route ?? null, url: safeURL(req.url()), method: req.method(), resourceType: req.resourceType(), startMs: rel(), redirectedFrom: previous ? requests.get(previous)?.id ?? null : null, status: 'pending' }; requests.set(req, item); result.requests.push(item); }
  return item;
}
function timing(req) {
  const t = req.timing();
  return { ...t, ttfbMs: t.responseStart >= 0 && t.requestStart >= 0 ? t.responseStart - t.requestStart : null, durationMs: t.responseEnd >= 0 ? t.responseEnd : null };
}
function pendingSnapshot() {
  return { atMs: rel(), playwright: [...requests.values()].filter(item => item.status === 'pending').map(item => ({ id: item.id, navigation: item.navigation, url: item.url, method: item.method, resourceType: item.resourceType, startMs: item.startMs, ageMs: rel() - item.startMs, responseAtMs: item.responseAtMs ?? null, responseStatus: item.responseStatus ?? null })), cdp: [...cdpRequests.values()].filter(item => item.status === 'pending').map(item => ({ id: item.id, navigation: item.navigation, url: item.url, method: item.method, type: item.type, startMs: item.startMs, ageMs: rel() - item.startMs, responseAtMs: item.responseAtMs ?? null, responseStatus: item.responseStatus ?? null, dataEvents: item.dataEvents, encodedDataBytes: item.encodedDataBytes })) };
}
function checkpoint() { fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n'); }

try {
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/cina/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe' });
  result.browserVersion = browser.version();
  assert.equal(result.browserVersion, result.browserExpectedVersion, 'same Chrome 147 build as retained v3');
  deadline = setTimeout(() => { result.timedOut = true; result.deadlinePending = pendingSnapshot(); event('browser-deadline', result.deadlinePending); void browser.close().catch(error => { result.deadlineCloseError = errorValue(error); }); }, Math.max(1, 165000 - rel()));
  context = await browser.newContext({ viewport: result.viewport, locale: result.locale, colorScheme: result.colorScheme });
  result.initialCookieCount = (await context.cookies()).length;
  result.initialServiceWorkerCount = context.serviceWorkers().length;
  assert.equal(result.initialCookieCount, 0, 'anonymous empty cookie jar (no Cookie values recorded)');
  assert.equal(result.initialServiceWorkerCount, 0);
  context.on('serviceworker', worker => { const item = { url: safeURL(worker.url()), atMs: rel() }; result.serviceWorkerEvents.push(item); event('serviceworker-failclosed', item); void browser.close().catch(error => { result.observerErrors.push(errorValue(error)); }); });
  await context.route('**/*', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) { const item = { method: route.request().method(), url: safeURL(route.request().url()), atMs: rel() }; result.refusedMutations.push(item); event('refused-mutation', item); await route.abort('blockedbyclient'); return; }
    await route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(4000);
  page.on('pageerror', error => { const item = { navigation: nav?.route, atMs: rel(), ...errorValue(error) }; result.pageErrors.push(item); event('pageerror', item); });
  page.on('console', message => { if (!['error', 'warning'].includes(message.type())) return; const loc = message.location(); const item = { navigation: nav?.route, type: message.type(), atMs: rel(), text: safeText(message.text()), location: { url: safeURL(loc.url), lineNumber: loc.lineNumber, columnNumber: loc.columnNumber } }; result.console.push(item); event('console', item); });
  page.on('request', req => { const item = requestRecord(req); event('request-start', { ...item }); });
  page.on('response', response => {
    const req = response.request(), item = requestRecord(req); item.responseAtMs = rel(); item.responseStatus = response.status(); item.responseHeaders = headers(response.headers()); item.timingAtResponse = timing(req); event('response', { id: item.id, navigation: item.navigation, url: item.url, status: item.responseStatus, headers: item.responseHeaders, timing: item.timingAtResponse });
    if (new URL(req.url()).origin === config.targetOrigin && new URL(req.url()).pathname === '/api/user/me' && req.method() === 'GET' && response.status() === 401) observe((async () => { try { const body = JSON.parse(await bounded(response.text(), 3500, 'anonymous 401 observation')); item.exactAnonymous401 = body.success === false && body.message === 'Unauthorized'; } catch (error) { item.anonymous401ObservationError = errorValue(error); } })());
  });
  page.on('requestfinished', req => { const item = requestRecord(req); item.status = 'finished'; item.finishMs = rel(); item.finalTiming = timing(req); event('request-finished', { id: item.id, navigation: item.navigation, url: item.url, finishMs: item.finishMs, timing: item.finalTiming }); });
  page.on('requestfailed', req => { const item = requestRecord(req); item.status = 'failed'; item.failedMs = rel(); item.failure = safeText(req.failure()?.errorText ?? 'unknown'); item.duringClosing = closing; item.finalTiming = timing(req); event('request-failed', { id: item.id, navigation: item.navigation, url: item.url, failedMs: item.failedMs, failure: item.failure, duringClosing: closing, timing: item.finalTiming }); });
  cdp = await context.newCDPSession(page);
  cdp.on('Network.requestWillBeSent', e => {
    if (e.redirectResponse) { const previous = cdpRequests.get(e.requestId); if (previous) { previous.status = 'redirected'; previous.finishMs = rel(); previous.redirectStatus = e.redirectResponse.status; event('cdp-redirect', { id: previous.id, status: e.redirectResponse.status, url: previous.url }); } }
    const item = { id: 'cdp-' + e.requestId + '-' + result.cdpRequests.length, protocolRequestId: e.requestId, navigation: nav?.route ?? null, url: safeURL(e.request.url), method: e.request.method, type: e.type, initiatorType: e.initiator?.type, startMs: rel(), cdpStart: e.timestamp, wallTime: e.wallTime, status: 'pending', dataEvents: 0, decodedDataBytes: 0, encodedDataBytes: 0 };
    cdpRequests.set(e.requestId, item); result.cdpRequests.push(item); event('cdp-request-start', { ...item });
  });
  cdp.on('Network.responseReceived', e => { const item = cdpRequests.get(e.requestId); if (!item) return; item.responseAtMs = rel(); item.cdpResponse = e.timestamp; item.responseStatus = e.response.status; item.protocol = e.response.protocol; item.mimeType = e.response.mimeType; item.fromDiskCache = e.response.fromDiskCache ?? false; item.fromServiceWorker = e.response.fromServiceWorker ?? false; item.responseHeaders = headers(e.response.headers); item.responseTiming = e.response.timing ?? null; item.ttfbMs = e.response.timing && e.response.timing.receiveHeadersStart >= 0 ? e.response.timing.receiveHeadersStart - e.response.timing.sendStart : null; event('cdp-response', { id: item.id, navigation: item.navigation, url: item.url, responseAtMs: item.responseAtMs, status: item.responseStatus, protocol: item.protocol, fromDiskCache: item.fromDiskCache, fromServiceWorker: item.fromServiceWorker, headers: item.responseHeaders, timing: item.responseTiming, ttfbMs: item.ttfbMs }); });
  cdp.on('Network.dataReceived', e => { const item = cdpRequests.get(e.requestId); if (!item) return; item.dataEvents++; item.decodedDataBytes += e.dataLength; item.encodedDataBytes += e.encodedDataLength; item.lastDataMs = rel(); event('cdp-data', { id: item.id, dataLength: e.dataLength, encodedDataLength: e.encodedDataLength, cdpTimestamp: e.timestamp }); });
  cdp.on('Network.loadingFinished', e => { const item = cdpRequests.get(e.requestId); if (!item) return; item.status = 'finished'; item.finishMs = rel(); item.cdpFinish = e.timestamp; item.loadingFinishedEncodedBytes = e.encodedDataLength; event('cdp-finished', { id: item.id, finishMs: item.finishMs, cdpTimestamp: e.timestamp, encodedDataLength: e.encodedDataLength }); });
  cdp.on('Network.loadingFailed', e => { const item = cdpRequests.get(e.requestId); if (!item) return; item.status = 'failed'; item.failedMs = rel(); item.failure = safeText(e.errorText); item.canceled = e.canceled ?? false; item.blockedReason = e.blockedReason ?? null; item.duringClosing = closing; event('cdp-failed', { id: item.id, failedMs: item.failedMs, failure: item.failure, canceled: item.canceled, blockedReason: item.blockedReason, duringClosing: closing }); });
  await cdp.send('Network.enable');
  for (const [route, kind] of [['/account/withdraw', 'account'], ['/admin/config/timezone', 'admin'], ['/en', 'public']]) {
    if (result.timedOut || !browser.isConnected()) break;
    nav = { route, kind, startedAt: new Date().toISOString(), startMs: rel(), pendingBeforeNavigation: pendingSnapshot(), networkidlePassed: false };
    result.pages.push(nav); event('navigation-start', { route, kind });
    try { const response = await page.goto(config.targetOrigin + route, { waitUntil: 'networkidle', timeout: 45000 }); nav.networkidlePassed = true; nav.navigationStatus = response?.status() ?? null; nav.gotoSettledMs = rel(); nav.pendingAtGotoSettlement = pendingSnapshot(); event('navigation-networkidle-pass', { route, status: nav.navigationStatus, atMs: nav.gotoSettledMs }); }
    catch (error) { nav.gotoSettledMs = rel(); nav.pendingAtGotoSettlement = pendingSnapshot(); nav.navigationError = errorValue(error); nav.isOriginal45sTimeout = error.name === 'TimeoutError' && error.message.includes('Timeout 45000ms exceeded'); event('navigation-failed', { route, error: nav.navigationError, pending: nav.pendingAtGotoSettlement }); }
    nav.gotoDurationMs = nav.gotoSettledMs - nav.startMs;
    try {
      const state = await bounded(page.evaluate(() => {
        const body = document.body?.innerText ?? '';
        return { url: location.href, title: document.title, lang: document.documentElement.lang, readyState: document.readyState, bodyText: body.slice(0, 2500), bodyLength: body.trim().length, accountGate: [...document.querySelectorAll('*')].some(node => node.children.length === 0 && node.textContent === 'Your account, one secure sign-in'), consoleGate: document.querySelector('#console-access-title')?.textContent ?? null, privilegedWorkspaceCount: document.querySelectorAll('#workspace').length, privilegedConsoleNavCount: document.querySelectorAll('nav[aria-label="Console navigation"]').length, publicMainCount: document.querySelectorAll('main#main-content').length, publicBootstrapCount: document.querySelectorAll('#cinatoken-public-bootstrap').length, hydrationFailure: document.documentElement.dataset.cinatokenHydration === 'failed', frameworkOverlayCount: document.querySelectorAll('nextjs-portal, vite-error-overlay, rsbuild-error-overlay, webpack-dev-server-client-overlay').length, viewport: { width: innerWidth, height: innerHeight }, resourceTiming: performance.getEntriesByType('resource').map(e => ({ name: e.name, entryType: e.entryType, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, fetchStart: e.fetchStart, domainLookupStart: e.domainLookupStart, domainLookupEnd: e.domainLookupEnd, connectStart: e.connectStart, connectEnd: e.connectEnd, secureConnectionStart: e.secureConnectionStart, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, nextHopProtocol: e.nextHopProtocol, responseStatus: e.responseStatus ?? null, deliveryType: e.deliveryType ?? null })), navigationTiming: performance.getEntriesByType('navigation').map(e => ({ name: e.name, type: e.type, startTime: e.startTime, duration: e.duration, fetchStart: e.fetchStart, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd, domContentLoadedEventStart: e.domContentLoadedEventStart, domContentLoadedEventEnd: e.domContentLoadedEventEnd, loadEventStart: e.loadEventStart, loadEventEnd: e.loadEventEnd, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, nextHopProtocol: e.nextHopProtocol, responseStatus: e.responseStatus ?? null })) };
      }), 4500, 'DOM and ResourceTiming');
      state.url = safeURL(state.url); state.bodyText = safeText(state.bodyText); state.consoleGate = state.consoleGate ? safeText(state.consoleGate) : null;
      for (const entry of [...state.resourceTiming, ...state.navigationTiming]) entry.name = safeURL(entry.name);
      nav.dom = state;
      nav.renderChecks = { identity: new URL(state.url).pathname === route && state.title.trim().length > 0, nonblank: state.bodyLength > 100, noFrameworkOverlay: state.frameworkOverlayCount === 0, noHydrationFailure: state.hydrationFailure === false, expectedGate: kind === 'account' ? state.accountGate && state.privilegedWorkspaceCount === 0 : kind === 'admin' ? state.consoleGate?.includes('Sign in to the console') && state.privilegedConsoleNavCount === 0 : state.publicMainCount === 1 && state.publicBootstrapCount === 1 };
    } catch (error) { nav.domError = errorValue(error); }
    try { const file = path.join(temp, `${label}-${kind}.png`); assert.equal(fs.existsSync(file), false); await page.screenshot({ path: file, fullPage: false, timeout: 4500 }); nav.screenshot = raw(file); result.screenshots.push({ route, ...nav.screenshot }); }
    catch (error) { nav.screenshotError = errorValue(error); }
    nav.finishedAt = new Date().toISOString(); nav.finishMs = rel(); nav.pendingAfterEvidence = pendingSnapshot(); checkpoint();
    console.log(JSON.stringify({ route, networkidlePassed: nav.networkidlePassed, gotoDurationMs: nav.gotoDurationMs, pendingAtGoto: nav.pendingAtGotoSettlement.playwright.length, cdpPendingAtGoto: nav.pendingAtGotoSettlement.cdp.length, renderChecks: nav.renderChecks, error: nav.navigationError }));
  }
} catch (error) { result.setupOrRunFailure = errorValue(error); }
finally {
  clearTimeout(deadline); result.pendingBeforeClose = pendingSnapshot(); closing = true;
  if (page && !page.isClosed()) {
    try { result.finalCookieCount = context ? (await context.cookies()).length : null; result.finalServiceWorkerCount = context?.serviceWorkers().length ?? null; } catch (error) { result.finalContextMetadataError = errorValue(error); }
  }
  try { await bounded(context?.close() ?? Promise.resolve(), 5000, 'context close'); result.contextClosed = Boolean(context) && context.isClosed(); } catch (error) { result.contextCloseError = errorValue(error); }
  try { await bounded(browser?.close() ?? Promise.resolve(), 5000, 'browser close'); result.browserClosed = Boolean(browser) && !browser.isConnected(); } catch (error) { result.browserCloseError = errorValue(error); }
  await bounded(Promise.allSettled([...tasks]), 4000, 'observer closure').catch(error => { result.observerErrors.push(errorValue(error)); });
  result.finishedAt = new Date().toISOString(); result.elapsedMs = rel();
  try { assert.deepEqual(raw(configPath), result.configRaw); assert.deepEqual(raw(config.liveProof.path), config.liveProof); assert.deepEqual(raw(preparationPath), result.preparationRaw); for (const item of preparation.sealedInputs) assert.deepEqual(raw(item.path), item); assert.deepEqual(raw(fileURLToPath(import.meta.url)), preparation.diagnosticScript); result.bindingsUnchanged = true; }
  catch (error) { result.bindingsUnchanged = false; result.bindingFailure = errorValue(error); }
  result.consoleClassification = result.console.map(item => { const matching = result.requests.find(req => req.navigation === item.navigation && req.url === item.location.url && req.exactAnonymous401 && /^Failed to load resource: the server responded with a status of 401(?:\s|$)/.test(item.text)); return { ...item, explainedExactAnonymous401: Boolean(matching) }; });
  result.summary = { navigationCount: result.pages.length, networkidlePasses: result.pages.filter(item => item.networkidlePassed).length, original45sTimeouts: result.pages.filter(item => item.isOriginal45sTimeout).length, requestCount: result.requests.length, cdpRequestCount: result.cdpRequests.length, requestFailureCount: result.requests.filter(item => item.status === 'failed' && !item.duringClosing).length, pageErrorCount: result.pageErrors.length, consoleErrors: result.console.filter(item => item.type === 'error').length, unexplainedConsole: result.consoleClassification.filter(item => !item.explainedExactAnonymous401).length, refusedMutations: result.refusedMutations.length };
  result.actualExit = result.pages.length === 3 && result.pages.every(item => item.networkidlePassed && item.navigationStatus === 200 && Object.values(item.renderChecks ?? {}).length === 5 && Object.values(item.renderChecks).every(Boolean) && item.screenshot) && result.contextClosed && result.browserClosed && result.bindingsUnchanged && !result.timedOut && !result.setupOrRunFailure && result.refusedMutations.length === 0 && result.serviceWorkerEvents.length === 0 && result.pageErrors.length === 0 && result.summary.requestFailureCount === 0 && result.summary.unexplainedConsole === 0 && result.observerErrors.length === 0 ? 0 : 1;
  result.outcome = result.actualExit === 0 ? 'PASS_THREE_ROUTE_DIAGNOSTIC_ONLY' : 'FAILED_THREE_ROUTE_DIAGNOSTIC';
  event('closed', { actualExit: result.actualExit, contextClosed: result.contextClosed, browserClosed: result.browserClosed, summary: result.summary }); fs.closeSync(journal); result.eventJournalRaw = raw(journalPath); checkpoint();
  console.log(JSON.stringify({ actualExit: result.actualExit, outcome: result.outcome, evidence: raw(output), summary: result.summary, contextClosed: result.contextClosed, browserClosed: result.browserClosed, bindingsUnchanged: result.bindingsUnchanged }));
}
process.exitCode = result.actualExit;
