import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'file:///C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs';

const own = path.dirname(fileURLToPath(import.meta.url));
const [label, configPath] = process.argv.slice(2);
assert.match(label ?? '', /^[a-z0-9-]+$/);
const output = path.join(own, label + '.json');
assert.equal(fs.existsSync(output), false);
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
assert.equal(config.targetOrigin, 'https://cinatoken.com');
assert.deepEqual(raw(config.liveProof.path), config.liveProof);
const browserDir = 'C:/Users/cina/AppData/Local/Temp/cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197';
const hashes = { 'production-web-browser-observe-v2.mjs': '415d123bbc71cfdb5d8ed02bf91f01d9021031358667cd7aaf2f0fd6edcd55be', 'execute-web-browser-observe-v2.mjs': 'ffd074ec8b52d5ce7c9dbd8a9dace29ec29130b661e0290e72f1f2d2d0424ed8', 'web-route-matrix.mjs': 'c8a3211d07979c037022f689aa442bd95de9b7c11843fb52b9ae9fa93ac01e61' };
const originals = Object.entries(hashes).map(([name, sha]) => { const item = raw(path.join(browserDir, name)); assert.equal(item.sha256, sha); return item; });
const pwRoot = 'C:/Users/cina/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core';
const types = fs.readFileSync(path.join(pwRoot, 'types/types.d.ts'), 'utf8').split(/\r?\n/);
const core = fs.readFileSync(path.join(pwRoot, 'lib/coreBundle.js'), 'utf8').split(/\r?\n/);
const result = { schema: 'bounded-readonly-cache-diagnostic-v1', label, startedAt: new Date().toISOString(), purpose: 'Two public /en navigations per fresh context, not a full QA attempt or product performance change.', config, configRaw: raw(configPath), input: raw(fileURLToPath(import.meta.url)), unchangedV2Scripts: originals, localPlaywrightVersion: JSON.parse(fs.readFileSync(path.join(pwRoot, 'package.json'), 'utf8')).version, mechanism: { note: { path: path.join(pwRoot, 'types/types.d.ts'), line: 10231, text: types[10230] }, code: { path: path.join(pwRoot, 'lib/coreBundle.js'), startLine: 35895, endLine: 35907, text: core.slice(35894, 35907).join('\n') }, sourceRaw: [raw(path.join(pwRoot, 'types/types.d.ts')), raw(path.join(pwRoot, 'lib/coreBundle.js')), raw(path.join(pwRoot, 'types/protocol.d.ts'))] }, totalDeadlineMs: 90000, modes: [], refusedMutations: [], timedOut: false };
const headerAllow = new Set(['cache-control', 'content-type', 'content-length', 'content-encoding', 'vary', 'etag', 'cf-cache-status']);
const filterHeaders = h => Object.fromEntries(Object.entries(h ?? {}).filter(([key]) => headerAllow.has(key.toLowerCase())).map(([key, val]) => [key.toLowerCase(), val]));
let browser, deadline, closing = false;
const started = performance.now();
try {
  deadline = setTimeout(async () => { result.timedOut = true; closing = true; try { await browser?.close(); } catch (error) { result.deadlineCloseError = error.message; } }, 90000);
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Users/cina/AppData/Local/ms-playwright/chromium-1217/chrome-win64/chrome.exe' });
  result.browserVersion = browser.version();
  for (const restoreCache of [false, true]) {
    if (result.timedOut) break;
    const mode = { restoreCache, name: restoreCache ? 'same-guard-cdp-cache-enabled' : 'same-guard-playwright-default', startedAt: new Date().toISOString(), navigations: [], consoleErrors: [], warnings: [], pageErrors: [], requestFailures: [], requests: [], cacheServedEvents: [] };
    result.modes.push(mode);
    let context, page, cdp, activeStep = null;
    const records = new Map();
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', colorScheme: 'light' });
      await context.route('**/*', async route => {
        if (!['GET', 'HEAD'].includes(route.request().method())) { result.refusedMutations.push({ mode: mode.name, method: route.request().method(), url: route.request().url() }); await route.abort('blockedbyclient'); return; }
        await route.continue();
      });
      page = await context.newPage();
      cdp = await context.newCDPSession(page);
      cdp.on('Network.requestWillBeSent', event => { const record = { requestId: event.requestId, step: activeStep, url: event.request.url, method: event.request.method, type: event.type, requestTimestamp: event.timestamp, wallTime: event.wallTime }; records.set(event.requestId, record); mode.requests.push(record); });
      cdp.on('Network.requestServedFromCache', event => { const record = records.get(event.requestId); if (record) record.requestServedFromCache = true; mode.cacheServedEvents.push({ requestId: event.requestId, step: activeStep }); });
      cdp.on('Network.responseReceived', event => { const record = records.get(event.requestId); if (record) Object.assign(record, { status: event.response.status, responseTimestamp: event.timestamp, fromDiskCache: event.response.fromDiskCache ?? false, fromPrefetchCache: event.response.fromPrefetchCache ?? false, fromServiceWorker: event.response.fromServiceWorker ?? false, headers: filterHeaders(event.response.headers), timing: event.response.timing ?? null }); });
      cdp.on('Network.loadingFinished', event => { const record = records.get(event.requestId); if (record) Object.assign(record, { finishTimestamp: event.timestamp, encodedDataLength: event.encodedDataLength }); });
      cdp.on('Network.loadingFailed', event => { const record = records.get(event.requestId); if (record) Object.assign(record, { finishTimestamp: event.timestamp, loadingFailed: { errorText: event.errorText, canceled: event.canceled ?? false, blockedReason: event.blockedReason ?? null } }); });
      await cdp.send('Network.enable');
      if (restoreCache) { await cdp.send('Network.setCacheDisabled', { cacheDisabled: false }); mode.cacheCommand = { method: 'Network.setCacheDisabled', params: { cacheDisabled: false }, completedAt: new Date().toISOString() }; }
      page.on('console', message => { if (message.type() === 'error') mode.consoleErrors.push({ text: message.text(), location: message.location() }); if (message.type() === 'warning') mode.warnings.push({ text: message.text(), location: message.location() }); });
      page.on('pageerror', error => mode.pageErrors.push(error.message));
      page.on('requestfailed', request => { if (!closing) mode.requestFailures.push({ url: request.url(), method: request.method(), failure: request.failure() }); });
      for (const step of ['initial', 'reload']) {
        if (result.timedOut) break;
        activeStep = step;
        const nav = { step, startedAt: new Date().toISOString() }; mode.navigations.push(nav);
        const before = performance.now();
        try {
          const remaining = 90000 - (performance.now() - started);
          const response = step === 'initial' ? await page.goto(config.targetOrigin + '/en', { waitUntil: 'networkidle', timeout: Math.max(1, Math.min(30000, remaining)) }) : await page.reload({ waitUntil: 'networkidle', timeout: Math.max(1, Math.min(30000, remaining)) });
          nav.wallMs = performance.now() - before;
          nav.status = response?.status(); nav.documentHeaders = filterHeaders(await response.allHeaders());
          nav.anonymousAPI = await page.evaluate(async () => { const before = performance.now(); const response = await fetch('/api/user/me', { method: 'GET' }); const body = await response.json(); return { method: 'GET', status: response.status, cacheControl: response.headers.get('cache-control'), contentType: response.headers.get('content-type'), body: { success: body.success, message: body.message }, wallMs: performance.now() - before }; });
          assert.equal(nav.anonymousAPI.status, 401); assert.equal(nav.anonymousAPI.body.success, false); assert.equal(nav.anonymousAPI.body.message, 'Unauthorized');
          nav.performance = await page.evaluate(() => { const timing = entry => ({ name: entry.name, entryType: entry.entryType, initiatorType: entry.initiatorType ?? null, duration: entry.duration, fetchStart: entry.fetchStart, domainLookupStart: entry.domainLookupStart, domainLookupEnd: entry.domainLookupEnd, connectStart: entry.connectStart, connectEnd: entry.connectEnd, secureConnectionStart: entry.secureConnectionStart, requestStart: entry.requestStart, responseStart: entry.responseStart, responseEnd: entry.responseEnd, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize, nextHopProtocol: entry.nextHopProtocol, deliveryType: entry.deliveryType ?? null, workerStart: entry.workerStart, serverTiming: entry.serverTiming?.map(t => ({ name: t.name, duration: t.duration, description: t.description })) ?? [] }); return { timeOrigin: performance.timeOrigin, navigation: performance.getEntriesByType('navigation').map(timing), resources: performance.getEntriesByType('resource').map(timing), screen: { url: location.href, title: document.title, lang: document.documentElement.lang, hydrationFailure: document.documentElement.dataset.cinatokenHydration === 'failed', bodyLength: document.body.innerText.trim().length, bootstrapCount: document.querySelectorAll('#cinatoken-public-bootstrap').length } }; });
          assert.equal(nav.status, 200); assert.equal(nav.performance.screen.url, config.targetOrigin + '/en'); assert.ok(nav.performance.screen.bodyLength > 100); assert.equal(nav.performance.screen.hydrationFailure, false); assert.equal(nav.performance.screen.bootstrapCount, 1);
        } catch (error) { nav.wallMs = performance.now() - before; nav.error = { name: error.name, message: error.message }; }
        nav.finishedAt = new Date().toISOString();
        console.log(JSON.stringify({ mode: mode.name, step, status: nav.status ?? null, wallMs: nav.wallMs, resources: nav.performance?.resources.length ?? null, error: nav.error ?? null }));
      }
    } catch (error) { mode.error = { name: error.name, message: error.message }; }
    finally { activeStep = 'cleanup'; try { await context?.close(); mode.contextClosed = true; } catch (error) { mode.contextClosed = false; mode.closeError = error.message; } mode.finishedAt = new Date().toISOString(); }
  }
  assert.equal(result.refusedMutations.length, 0);
  assert.equal(result.modes.length, 2);
  assert.ok(result.modes.every(mode => mode.navigations.length === 2 && mode.navigations.every(nav => !nav.error) && mode.contextClosed));
  assert.equal(result.timedOut, false);
  result.actualExit = 0;
} catch (error) { result.actualExit = 1; result.failure = { name: error.name, message: error.message }; }
finally {
  clearTimeout(deadline); closing = true;
  try { await browser?.close(); result.browserClosed = true; } catch (error) { result.browserClosed = false; result.browserCloseError = error.message; result.actualExit = 1; }
  result.finishedAt = new Date().toISOString(); result.wallMs = performance.now() - started;
  try { assert.deepEqual(raw(config.liveProof.path), config.liveProof); result.liveProofRawStillSame = true; for (const [name, sha] of Object.entries(hashes)) assert.equal(raw(path.join(browserDir, name)).sha256, sha); result.v2ScriptsStillSame = true; } catch (error) { result.actualExit = 1; result.bindingFailure = error.message; }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ evidence: raw(output), actualExit: result.actualExit, timedOut: result.timedOut, browserClosed: result.browserClosed, wallMs: result.wallMs, modeSummaries: result.modes.map(mode => ({ name: mode.name, contextClosed: mode.contextClosed, navigations: mode.navigations.map(nav => ({ step: nav.step, status: nav.status ?? null, wallMs: nav.wallMs, error: nav.error ?? null })) })) }));
}
process.exitCode = result.actualExit;
