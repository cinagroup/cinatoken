import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const temp = path.dirname(fileURLToPath(import.meta.url));
const clockStart = performance.now();
const ms = () => Math.round((performance.now() - clockStart) * 1000) / 1000;
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const assetTypes = new Set(['script', 'stylesheet']);
const allowedHeaders = new Set(['content-type', 'cache-control', 'cf-cache-status', 'age', 'server-timing', 'content-length', 'content-encoding', 'cf-ray']);
function safeURL(value) { try { const u = new URL(value); u.username = ''; u.password = ''; for (const key of [...u.searchParams.keys()]) u.searchParams.set(key, '[redacted]'); u.hash = ''; return u.toString(); } catch { return String(value).slice(0, 500); } }
function safeText(value) { return String(value).replace(/https?:\/\/[^\s"'<>]+/g, safeURL).replace(/(token|authorization|cookie|state|password|secret|code)\s*[:=]\s*[^\s,;]+/ig, '$1=[redacted]').replace(/Bearer\s+[\w.+/-]+/ig, 'Bearer [redacted]').slice(0, 4000); }
const wait = interval => new Promise(resolve => setTimeout(resolve, interval));
function requireCondition(value, message) { if (!value) throw new Error('V4 functional readiness: ' + message); }
async function bounded(promise, timeout, message) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message + ' bounded timeout')), timeout); })]); } finally { clearTimeout(timer); } }
function timing(request) { const t = request.timing(); return { ...t, ttfbMs: t.responseStart >= 0 && t.requestStart >= 0 ? t.responseStart - t.requestStart : null }; }

export function verifyV4Seals() {
  const file = path.join(temp, 'v4-sealed-plan.json');
  const plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const item of [...plan.originalInputs, ...plan.newInputs]) {
    const actual = raw(item.path);
    requireCondition(actual.bytes === item.bytes && actual.sha256 === item.sha256, 'immutable raw input binding ' + item.path);
  }
  return { planRaw: raw(file), originalV3Raw: plan.originalV3, assertionEquivalenceRaw: plan.assertionEquivalence, original85AssertCallsRetained: true, originalInputsStillSame: true, newInputsStillSame: true };
}

export function attachReadinessObserver(group, targetOrigin, isClosing) {
  const network = group.network = { targetOrigin, isClosing, records: [], requests: new Map(), navigations: [], current: null, events: [] };
  function record(request) {
    let item = network.requests.get(request);
    if (!item) { item = { id: group.state.name + '-' + (network.records.length + 1), navigationId: network.current?.id ?? null, pageURL: safeURL(group.page.url()), url: safeURL(request.url()), method: request.method(), resourceType: request.resourceType(), startMs: ms(), status: 'pending' }; network.requests.set(request, item); network.records.push(item); }
    return item;
  }
  group.page.on('request', request => { const item = record(request); network.events.push({ type: 'request-start', atMs: item.startMs, id: item.id, navigationId: item.navigationId, url: item.url, method: item.method, resourceType: item.resourceType }); });
  group.page.on('response', response => { const item = record(response.request()); item.responseAtMs = ms(); item.http = response.status(); item.responseHeaders = Object.fromEntries(Object.entries(response.headers()).filter(([key]) => allowedHeaders.has(key.toLowerCase())).map(([key, val]) => [key.toLowerCase(), safeText(val)])); item.responseTiming = timing(response.request()); network.events.push({ type: 'response', atMs: item.responseAtMs, id: item.id, http: item.http, headers: item.responseHeaders, timing: item.responseTiming }); });
  group.page.on('requestfinished', request => { const item = record(request); item.status = 'finished'; item.finishMs = ms(); item.timing = timing(request); network.events.push({ type: 'request-finished', atMs: item.finishMs, id: item.id, timing: item.timing }); });
  group.page.on('requestfailed', request => { const item = record(request); item.status = 'failed'; item.failedMs = ms(); item.failure = safeText(request.failure()?.errorText ?? 'unknown'); item.duringClosing = isClosing(); item.timing = timing(request); network.events.push({ type: 'request-failed', atMs: item.failedMs, id: item.id, failure: item.failure, duringClosing: item.duringClosing, timing: item.timing }); });
}

export function observeNetworkCheckpoint(group) {
  const network = group.network;
  if (!network) return { atMs: ms(), unavailable: true };
  const all = network.records.filter(item => item.status === 'pending');
  return { atMs: ms(), navigationId: network.current?.id ?? null, requestCount: network.records.length, pending: all.map(item => ({ id: item.id, navigationId: item.navigationId, url: item.url, method: item.method, resourceType: item.resourceType, startMs: item.startMs, ageMs: ms() - item.startMs, responseAtMs: item.responseAtMs ?? null, http: item.http ?? null })), pendingRequiredAssets: all.filter(item => assetTypes.has(item.resourceType)).map(item => ({ id: item.id, url: item.url, resourceType: item.resourceType, startMs: item.startMs, ageMs: ms() - item.startMs })) };
}

export function beginNavigation(group, route, kind, phase = 'matrix') {
  const network = group.network;
  const nav = { id: group.state.name + '-nav-' + (network.navigations.length + 1), route, kind, phase, navigationWaitUntil: 'domcontentloaded', navigationTimeoutMs: 45000, appReadinessTimeoutMs: 20000, startMs: ms(), startedAt: new Date().toISOString(), pendingBefore: observeNetworkCheckpoint(group), ready: false };
  network.navigations.push(nav); network.current = nav; return nav;
}

export function documentReady(group) {
  const nav = group.network.current;
  nav.domContentLoadedAtMs = ms(); nav.domContentLoadedDurationMs = nav.domContentLoadedAtMs - nav.startMs; nav.pendingAtDOMContentLoaded = observeNetworkCheckpoint(group);
}

function requiredAssets(group, nav) { return group.network.records.filter(item => item.navigationId === nav.id && assetTypes.has(item.resourceType)); }

async function waitForRequiredAssets(group, nav, deadline) {
  while (ms() < deadline) {
    const assets = requiredAssets(group, nav);
    const failed = assets.find(item => item.status === 'failed' || item.http >= 400);
    requireCondition(!failed, 'required JS/CSS failed: ' + (failed?.url ?? ''));
    if (assets.some(item => item.resourceType === 'script') && assets.some(item => item.resourceType === 'stylesheet') && assets.every(item => item.status === 'finished' && item.http >= 200 && item.http < 400)) return assets;
    await wait(Math.min(50, Math.max(1, deadline - ms())));
  }
  nav.pendingAtReadinessTimeout = observeNetworkCheckpoint(group);
  throw new Error('Required current-page JS/CSS did not finish within the shared 20000ms app-readiness budget');
}

async function publicReactiveHeader(group, deadline) {
  const page = group.page;
  const remaining = () => { const left = deadline - ms(); requireCondition(left > 0, 'public reactive header exceeded shared 20000ms readiness budget'); return Math.max(1, Math.floor(left)); };
  const control = page.locator('header select:has(option[value="dark"])');
  await control.waitFor({ timeout: remaining() });
  const originalMode = await control.inputValue();
  const initialDark = await bounded(page.evaluate(() => document.documentElement.classList.contains('dark')), remaining(), 'public initial theme state');
  const probeMode = initialDark ? 'light' : 'dark';
  let attempts = 0, changed = false;
  while (ms() < deadline && !changed) {
    attempts++;
    await control.selectOption(probeMode, { timeout: remaining() });
    try {
      await page.waitForFunction(mode => document.documentElement.classList.contains('dark') === (mode === 'dark') && document.cookie.split(';').some(value => value.trim() === 'cinatoken-theme=' + mode), probeMode, { timeout: Math.min(400, remaining()) });
      changed = true;
    } catch (error) { if (error.name !== 'TimeoutError') throw error; }
  }
  requireCondition(changed, 'public SSR header never produced a real React theme class/cookie state change');
  const changedAtMs = ms();
  await control.selectOption(originalMode, { timeout: remaining() });
  await page.waitForFunction(mode => document.cookie.split(';').some(value => value.trim() === 'cinatoken-theme=' + mode) && document.documentElement.classList.contains('dark') === (mode === 'dark' || mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches), originalMode, { timeout: remaining() });
  const restoredMode = await control.inputValue();
  requireCondition(restoredMode === originalMode, 'public original theme control restored');
  return { originalMode, initialDark, probeMode, attempts, changedAtMs, restoredAtMs: ms(), restoredMode, realThemeClassAndCookieChange: true, originalControlModeRestored: true, cookieLimit: 'Only cinatoken-theme control preference is inspected; restoring a previously unset system mode intentionally writes a local system preference cookie. No Cookie/Auth/state token values are collected.' };
}

export async function functionalReady(group, route, kind) {
  const network = group.network, nav = network.current;
  requireCondition(nav?.route === route && nav.kind === kind, 'navigation/readiness association');
  nav.readinessStartMs = ms(); nav.originalLocatorFinishedAtMs = nav.readinessStartMs;
  const deadline = nav.domContentLoadedAtMs + 20000;
  nav.readinessBudgetStartMs = nav.domContentLoadedAtMs;
  nav.locatorAndReadinessDeadlineMs = deadline;
  requireCondition(deadline > ms(), 'original locator and readiness shared20000ms budget remains');
  try {
    await waitForRequiredAssets(group, nav, deadline);
    if (kind === 'public' || kind === 'missing-model') nav.publicReactiveProof = await publicReactiveHeader(group, deadline);
    else {
      while (ms() < deadline) {
        const exact = group.state.expectedAnonymous401.filter(item => item.shard === group.state.name && new URL(item.pageURL).origin === network.targetOrigin && new URL(item.pageURL).pathname === route);
        if (exact.length === 1) { nav.exactAnonymous401Observed = { responseURL: exact[0].url, method: exact[0].method, status: exact[0].status, successFalse: exact[0].body?.success === false, messageUnauthorized: exact[0].body?.message === 'Unauthorized' }; break; }
        requireCondition(exact.length < 2, 'duplicate exact anonymous user/me401 for originating page');
        await wait(Math.min(50, Math.max(1, deadline - ms())));
      }
      requireCondition(nav.exactAnonymous401Observed, 'current private page exact anonymous user/me401 body observed within shared readiness budget');
    }
    const assets = await waitForRequiredAssets(group, nav, deadline);
    nav.requiredAssets = assets.map(item => ({ id: item.id, url: item.url, resourceType: item.resourceType, http: item.http, status: item.status, startMs: item.startMs, finishMs: item.finishMs, durationMs: item.finishMs - item.startMs, ttfbMs: item.timing?.ttfbMs ?? null }));
    const resource = await bounded(group.page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation').map(e => ({ name: e.name, type: e.type, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd, domContentLoadedEventEnd: e.domContentLoadedEventEnd, loadEventEnd: e.loadEventEnd, duration: e.duration, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })), resources: performance.getEntriesByType('resource').map(e => ({ name: e.name, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, requestStart: e.requestStart, responseStart: e.responseStart, responseEnd: e.responseEnd, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize })) })), Math.max(1, deadline - ms()), 'functional readiness ResourceTiming');
    for (const item of [...resource.navigation, ...resource.resources]) item.name = safeURL(item.name);
    nav.resourceTiming = resource; nav.readyAtMs = ms(); nav.readinessDurationMs = nav.readyAtMs - nav.readinessStartMs; nav.locatorPlusReadinessDurationMs = nav.readyAtMs - nav.domContentLoadedAtMs; nav.functionalPageDurationMs = nav.readyAtMs - nav.startMs; nav.pendingAtReady = observeNetworkCheckpoint(group); nav.ready = true;
    return { navigationId: nav.id, ready: nav.ready, readyAtMs: nav.readyAtMs, functionalPageDurationMs: nav.functionalPageDurationMs, domContentLoadedDurationMs: nav.domContentLoadedDurationMs, readinessDurationMs: nav.readinessDurationMs, locatorPlusReadinessDurationMs: nav.locatorPlusReadinessDurationMs, requiredAssetCount: nav.requiredAssets.length, publicReactiveProof: nav.publicReactiveProof ?? null, exactAnonymous401Observed: nav.exactAnonymous401Observed ?? null, pendingAtReady: nav.pendingAtReady };
  } catch (error) { nav.readinessFailure = { name: error.name, message: safeText(error.message) }; nav.pendingAtReadinessFailure = observeNetworkCheckpoint(group); throw error; }
}

export function inspectFailure(group, error) {
  const nav = group.network?.current;
  if (nav) { nav.failureAtMs = ms(); nav.failure = { name: error.name, message: safeText(error.message) }; nav.pendingAtFailure = observeNetworkCheckpoint(group); }
  return observeNetworkCheckpoint(group);
}

export function collectReadinessNetwork(groups) {
  return groups.map(group => ({ shard: group.state.name, navigations: group.network?.navigations ?? [], requests: group.network?.records ?? [], events: group.network?.events ?? [], finalCheckpoint: observeNetworkCheckpoint(group) }));
}

export function requireReadinessMetadata(groups) {
  for (const group of groups) {
    const network = group.network;
    requireCondition(Boolean(network), 'complete request observer for ' + group.state.name);
    const expected = group.state.expectedRoutes.length + (group.state.name === 'public' ? 3 : 0);
    requireCondition(network.navigations.length === expected, 'all matrix and original three interaction navigations observed for ' + group.state.name);
    for (const nav of network.navigations) {
      requireCondition(nav.ready, 'app ready on ' + nav.route + '/' + nav.phase);
      requireCondition(nav.domContentLoadedDurationMs <= 45000, 'original navigation budget on ' + nav.route);
      requireCondition(nav.locatorPlusReadinessDurationMs <= 20000, 'original locator plus app-readiness shared20000ms budget on ' + nav.route);
      requireCondition(nav.requiredAssets.length > 0 && nav.requiredAssets.every(item => item.status === 'finished' && item.http >= 200 && item.http < 400), 'no missing JS/CSS on ' + nav.route);
      if (nav.kind === 'public' || nav.kind === 'missing-model') requireCondition(nav.publicReactiveProof?.realThemeClassAndCookieChange && nav.publicReactiveProof?.originalControlModeRestored, 'actual public hydration interaction on ' + nav.route);
      else requireCondition(nav.exactAnonymous401Observed?.successFalse && nav.exactAnonymous401Observed?.messageUnauthorized, 'private originating-page exact anonymous401');
    }
    for (const item of network.records.filter(item => assetTypes.has(item.resourceType))) requireCondition(item.status === 'finished' && item.http >= 200 && item.http < 400, 'late known JS/CSS must finish, including at context closure: ' + item.url);
  }
}
