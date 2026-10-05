import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const temp = path.dirname(fileURLToPath(import.meta.url));
const browserTemp = 'C:/Users/cina/AppData/Local/Temp/cinatoken-independent-web-browser-696cc8df85ea423aa0d2545df155d197';
const configPath = 'C:/Users/cina/AppData/Local/Temp/cinatoken-web-html-integrity-20261005-463533d1f4514516803e726a963bfb90/production.browser-config.json';
const browserLabel = 'cutover-3847955-v2-07c0e12a';
const htmlLabel = 'production-3847955-precheck-v1-053c9a1f';
const raw = file => { const b = fs.readFileSync(file); return { path: file, bytes: b.length, sha256: crypto.createHash('sha256').update(b).digest('hex') }; };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const match = expected => { const actual = raw(expected.path); assert.equal(actual.bytes, expected.bytes); assert.equal(actual.sha256, expected.sha256); return actual; };
const write = (file, value) => { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return raw(file); };
assert.equal(process.argv[2], '--visual-reviewed-desktop-mobile-admin', 'run only after this agent views the actual new screenshots');
const config = read(configPath);
assert.equal(config.gitSHA, '3847955ccdb4c670f0f9aa099ef976889357e6b2');
assert.equal(config.workerVersionId, 'dbe1800e-cd09-4f47-ba5e-b2a256898ae4');
assert.equal(config.phase, 'cutover'); assert.equal(config.targetOrigin, 'https://cinatoken.com');
assert.equal(config.liveProof.bytes, 6014);
assert.equal(config.liveProof.sha256, 'f6beda579fce8c555121e1311c29a36435217cb74ad850f711e61b210eb77999');
const liveRaw = match(config.liveProof); const configRaw = raw(configPath);
const htmlResultPath = path.join(temp, `${htmlLabel}-html-precheck-closed.json`);
const htmlExecutionPath = path.join(temp, `${htmlLabel}-execution-closed.json`);
const html = read(htmlResultPath); const htmlExecution = read(htmlExecutionPath);
assert.equal(html.actualExit, 0); assert.equal(htmlExecution.actualExit, 0); assert.equal(htmlExecution.exit.code, 0);
assert.equal(htmlExecution.timedOut, false); assert.equal(html.liveProofRawStillSame, true);
assert.equal(html.requests.length, 4); assert.ok(html.requests.every(row => row.passed === true));
assert.equal(html.config.gitSHA, config.gitSHA); assert.equal(html.config.workerVersionId, config.workerVersionId);
match(htmlExecution.precheckResult); match(htmlExecution.stdout); match(htmlExecution.stderr); match(html.configRaw);
const bodyRefs = html.requests.map(row => match(row.bodyRaw));
const htmlScripts = htmlExecution.inputScripts.map(match);
const htmlFinal = {
  schema: 'cinatoken-production-html-integrity-companion-final-v1', at: new Date().toISOString(), status: 'PASS_STOP',
  sourceSHA: config.gitSHA, webVersionId: config.workerVersionId, phase: config.phase, origin: config.targetOrigin,
  actualExits: { precheck: html.actualExit, childProcess: htmlExecution.exit.code, executionWrapper: htmlExecution.actualExit, seal: 0 },
  processClosed: true, timedOut: false, requestsPassed: 4,
  execution: raw(htmlExecutionPath), precheckResult: raw(htmlResultPath), configRaw, liveProof: liveRaw,
  headerAndBodyRecords: html.requests.map(row => ({ route: row.route, kind: row.kind, method: row.method,
    url: row.url, status: row.status, headers: row.headers, bodyRaw: row.bodyRaw, checks: row.checks, passed: row.passed })),
  inputs: htmlScripts, stdout: htmlExecution.stdout, stderr: htmlExecution.stderr,
  scope: { realGET: 4, browserRuns: 0, sourceWrites: 0, gitWrites: 0, deployments: 0, routeWrites: 0, databaseWrites: 0, businessWrites: 0 },
  claimBoundary: 'Four actual GET HTML responses retain no-store plus no-transform, prior CSP/safety headers and no beacon/RUM marker. The separate unchanged browser verifies runtime behavior across 45 routes; this alone is not an authenticated business acceptance.',
};
const htmlFinalRaw = write(path.join(temp, 'FINAL-production-html-no-transform-3847955-v1.json'), htmlFinal);
const htmlStopRaw = write(path.join(temp, 'STOP-production-html-no-transform-3847955-v1.json'), {
  schema: 'cinatoken-production-html-integrity-companion-STOP-v1', at: new Date().toISOString(), status: 'STOP',
  actualExit: 0, sourceSHA: config.gitSHA, webVersionId: config.workerVersionId, processClosed: true,
  final: htmlFinalRaw, execution: htmlFinal.execution, precheckResult: htmlFinal.precheckResult,
  scope: htmlFinal.scope, oldPreparationAndFailureReceiptsUnmodified: true,
});
const resultPath = path.join(browserTemp, `${browserLabel}.json`);
const executionPath = path.join(browserTemp, `${browserLabel}-execution-closed.json`);
const result = read(resultPath); const execution = read(executionPath);
assert.equal(result.actualExit, 0); assert.equal(execution.actualExit, 0); assert.equal(execution.exit.code, 0);
assert.equal(result.browserClosed, true); assert.equal(result.contextClosed, true); assert.equal(execution.timedOut, false);
assert.equal(result.liveProofRawStillSame, true); assert.equal(result.config.gitSHA, config.gitSHA);
assert.equal(result.config.workerVersionId, config.workerVersionId); assert.equal(result.config.phase, 'cutover');
match(execution.browserResult); match(execution.stdout); match(execution.stderr); match(result.configRaw);
const counts = {
  publicKinds: result.pages.filter(row => ['public', 'missing-model'].includes(row.kind)).length,
  accountPages: result.pages.filter(row => row.kind === 'account').length,
  adminPages: result.pages.filter(row => row.kind === 'admin').length,
  totalPages: result.pages.length, pageErrors: result.pageErrors.length, warnings: result.warnings.length,
  requestFailures: result.requestFailures.length, unknownHTTP: result.unknownHTTPErrors.length,
  unknownConsole: result.unexplainedConsoleErrors.length, rawHTTPErrorResponses: result.httpErrors.length,
  rawConsoleErrors: result.consoleErrors.length, exactExplainedUserMe401: result.expectedAnonymous401.length,
  exactExplainedMissingModel404: result.expectedMissingModel404.length, refusedMutations: result.refusedMutations.length,
};
assert.deepEqual(counts, { publicKinds: 8, accountPages: 10, adminPages: 27, totalPages: 45,
  pageErrors: 0, warnings: 0, requestFailures: 0, unknownHTTP: 0, unknownConsole: 0,
  rawHTTPErrorResponses: 38, rawConsoleErrors: 38, exactExplainedUserMe401: 37,
  exactExplainedMissingModel404: 1, refusedMutations: 0 });
assert.equal(result.interactions.length, 3);
assert.deepEqual(result.interactions.map(row => row.step), ['desktop-dark-selected', 'language-zh-navigated', 'mobile-zh-dark-reload']);
assert.ok(result.interactions.every(row => row.dark === true && row.hydrationFailure === false && row.documentWidth <= row.width));
assert.equal(result.interactions[1].lang, 'zh'); assert.equal(result.interactions[2].lang, 'zh');
assert.equal(result.interactions[2].width, 390);
const screenshots = result.screenshots.map(row => ({ name: row.name, ...match(row) }));
assert.equal(screenshots.length, 6);
for (const name of ['desktop-dark', 'mobile-zh-dark', 'admin-19']) assert.ok(screenshots.some(row => row.name === name));
const browserScripts = execution.inputScripts.map(match);
const scriptSHAs = [
  'ffd074ec8b52d5ce7c9dbd8a9dace29ec29130b661e0290e72f1f2d2d0424ed8',
  '415d123bbc71cfdb5d8ed02bf91f01d9021031358667cd7aaf2f0fd6edcd55be',
  'c8a3211d07979c037022f689aa442bd95de9b7c11843fb52b9ae9fa93ac01e61',
];
assert.deepEqual(browserScripts.map(row => row.sha256), scriptSHAs);
const priorRefs = [
  ['cutover-bdc1bfcf-v2-3d7fd159.json', 230992, '2500754ce7470909f7940367a04890ef5146127489c42cb128ef4fd729976067'],
  ['cutover-bdc1bfcf-v2-3d7fd159-execution-closed.json', 5241, '8cc3ba77ef5a2a9ed32157eff86c73d7173fcf9c4ad4d22c9a3ed60f80dd5de6'],
  ['FINAL-independent-web-production-browser-failure-v2.json', 15848, 'ce028bda226f7a78a666713dfef02720d2dedb3d398a8da0a989270361329b1b'],
  ['STOP-independent-web-production-browser-failure-v2.json', 868, '15cd115dc5f708dc59c5cdc15c794b8865020f79dc159c2f00f90e145bc399df'],
].map(([name, bytes, sha256]) => match({ path: path.join(browserTemp, name), bytes, sha256 }));
const final = {
  schema: 'cinatoken-independent-web-production-browser-final-v2', at: new Date().toISOString(),
  status: 'PASS_PRODUCTION_QA_STOP', label: browserLabel, sourceSHA: config.gitSHA,
  webVersionId: config.workerVersionId, origin: config.targetOrigin, phase: config.phase,
  canonicalOrigin: config.canonicalOrigin, execution: raw(executionPath), browserResult: raw(resultPath),
  actualExits: { browser: result.actualExit, childProcess: execution.exit.code, executionWrapper: execution.actualExit, seal: 0 },
  closed: { browser: true, context: true, processExit: 0, timedOut: false }, counts,
  themeLocaleMobile: result.interactions,
  visualReview: { reviewedScreenshots: ['desktop-dark', 'mobile-zh-dark', 'admin-19'],
    findings: 'Actual desktop dark and mobile Chinese dark pages show readable content without overlay or horizontal clipping; actual Console entry shows anonymous sign-in gate.',
    performedBy: 'j3_operational_review', reviewedAfterNewRunClosed: true },
  screenshots, htmlIntegrityCompanion: { final: htmlFinalRaw, stop: htmlStopRaw, actualExit: 0, realGET: 4, bodyReferences: bodyRefs },
  strictHarnessUnchanged: browserScripts, telemetryOrConsoleExemptionsAdded: 0,
  priorProductionFailurePreserved: { actualExit: 1, sourceSHA: 'bdc1bfcf15d93a9b2769d3f52352bfa39eab8928',
    webVersionId: 'ecba2f94-90a3-4e32-af20-9fd9d3718811', refusedRUMPOST: 32, CSPBlockedBeaconGET: 37, rawReferences: priorRefs },
  limitations: ['No real CinaAuth credential login, protected account/Console business data, live inference, financial or chain writes.',
    'Anonymous private entry gates and assets were tested; protected child screens with real identity remain outside this read-only smoke.',
    'Root independently owns live release/routes and separate GET23/HEAD6/auth3/135-asset probes; these were not repeated by this agent.'],
  scope: { sourceWrites: 0, gitWrites: 0, deployments: 0, routeWrites: 0, databaseWrites: 0, businessWrites: 0,
    installedDependencies: 0, productionRouteChangedByThisAgent: false },
  artifactRawReferences: [raw(resultPath), raw(executionPath), match(execution.stdout), match(execution.stderr),
    ...browserScripts, configRaw, liveRaw, ...screenshots, htmlFinalRaw, htmlStopRaw,
    ...priorRefs, raw(fileURLToPath(import.meta.url))],
};
const finalRaw = write(path.join(browserTemp, 'FINAL-independent-web-production-browser-3847955-v2.json'), final);
const stopRaw = write(path.join(browserTemp, 'STOP-independent-web-production-browser-3847955-v2.json'), {
  schema: 'cinatoken-independent-web-production-browser-STOP-v2', at: new Date().toISOString(), status: 'STOP',
  actualExit: 0, sourceSHA: config.gitSHA, webVersionId: config.workerVersionId,
  browserClosed: true, contextClosed: true, processExit: 0, noFurtherRuntimeAuthorizedByThisReceipt: true,
  final: finalRaw, browserResult: final.browserResult, execution: final.execution,
  companionFinal: htmlFinalRaw, companionStop: htmlStopRaw, scope: final.scope,
});
const smallRefs = write(path.join(temp, 'production-3847955-v2-small-refs.json'), {
  schema: 'cinatoken-production-web-QA-small-refs-v2', sourceSHA: config.gitSHA, webVersionId: config.workerVersionId,
  phase: 'cutover', actualExits: { HTML: 0, browser: 0, seal: 0 }, final: finalRaw, stop: stopRaw,
  browserResult: final.browserResult, execution: final.execution, companionFinal: htmlFinalRaw,
  companionStop: htmlStopRaw, companionResult: htmlFinal.precheckResult, companionExecution: htmlFinal.execution,
  screenshots, counts, themeLocaleMobile: result.interactions,
});
console.log(JSON.stringify({ actualExit: 0, final: finalRaw, stop: stopRaw, smallRefs, htmlFinal: htmlFinalRaw, htmlStop: htmlStopRaw,
  browserResult: final.browserResult, execution: final.execution, counts, screenshots }));
