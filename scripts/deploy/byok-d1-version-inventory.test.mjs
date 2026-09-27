import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const {createByokD1VersionInventory: create} = await import(process.env.BYOK_VERSION_INVENTORY_MODULE
  ? pathToFileURL(resolve(process.env.BYOK_VERSION_INVENTORY_MODULE)).href : './byok-d1-version-inventory.mjs');
const token = 'synthetic-version-inventory-token', privateValue = 'PRIVATE-DO-NOT-PERSIST';
const account = '7ea8e46d8210bad342fa7595f7935fea', a = '/accounts/' + account;
const db = '6bf5d41e-fe0b-4afa-9f67-ff5cf82e23d1';
const targets = ['cinatoken-proxy-staging', 'cinatoken-staging-recovery-control', 'cinatoken-staging-usage-recovery', 'cinatoken-staging-images-upstream'];
const names = [...targets, 'producer'];
const uuid = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ok = (result, result_info) => ({success: true, errors: null, result, result_info});
const sha = value => createHash('sha256').update(value).digest('hex');
function setup(options = {}) {
  const workspace = fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT ?? '.wrangler/staging', 'byok-version-test-'));
  const dir = resolve(workspace, '.wrangler/staging/byok-d1-version-inventory-reservation');
  const calls = [], counts = new Map(); let hook;
  const opts = {workspace, apiToken: token, fetchImpl: async (url, init) => {
    const u = new URL(url), path = u.pathname.replace('/client/v4', '') + u.search;
    assert.equal(u.origin, 'https://api.cloudflare.com'); assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined); assert.equal(init.redirect, 'error'); assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.Authorization, 'Bearer ' + token);
    assert.match(fs.readFileSync(resolve(dir, 'journal.jsonl'), 'utf8'), /PENDING/);
    const n = counts.get(path) ?? 0; counts.set(path, n + 1); calls.push(path);
    let value;
    if (path === a + '/workers/scripts') value = ok(names.map(id => ({id, modified_on: 'stable', deployment_id: 'stable'})));
    else if (path.startsWith(a + '/workers/services/')) value = ok({id: path.split('/').at(-1),
      default_environment: {environment: 'production'}, environments: [{environment: 'production'}]});
    else {
      const worker = u.pathname.split('/')[7], tail = path.slice((a + '/workers/scripts/' + worker).length);
      if (tail === '/subdomain') value = ok({enabled: worker === 'producer', previews_enabled: worker === 'producer'});
      else if (tail === '/deployments') value = ok({deployments: [{id: uuid(100), versions: [
        {version_id: uuid(1), percentage: 100}, ...(worker === 'producer' ? [{version_id: uuid(2), percentage: 0}] : []),
      ]}, {id: uuid(99), versions: [{version_id: uuid(9), percentage: 100}]}]});
      else if (tail.startsWith('/versions?')) {
        assert.equal(u.searchParams.has('deployable'), false);
        assert.equal(u.searchParams.get('per_page'), '100');
        const page = Number(u.searchParams.get('page'));
        value = ok({items: (page === 1 ? [1, 2] : [3, 4]).map(n => ({id: uuid(n), number: n,
          metadata: n === 4 ? {hasPreview: false} : {}}))}, {page, per_page: 2, count: 2, total_count: 4});
      } else if (tail.startsWith('/versions/')) {
        const id = tail.split('/').at(-1);
        value = ok({id, resources: {bindings: [
          {type: 'plain_text', name: 'PRIVATE', text: privateValue},
          {type: 'secret_text', name: 'SECRET'},
          ...(worker === 'producer' && id === uuid(2) ? [{type: 'd1', name: 'DB', id: db, database_id: db}] : []),
          ...(worker === 'producer' && id === uuid(3) ? [{type: 'service', name: 'RPC', service: targets[2], entrypoint: 'UsageRecovery'}] : []),
          ...(worker === 'producer' && id === uuid(4) ? [{type: 'durable_object_namespace', name: 'DO', script_name: targets[0], class_name: 'Example'}] : []),
        ], script: {handlers: ['fetch']}}});
      } else throw Error('Unexpected fixture path ' + path);
    }
    return await hook?.({path, n, value, init}) ?? Response.json(value);
  }, ...options};
  return {workspace, dir, calls, opts, make: () => create(opts), hook: fn => {hook = fn;}};
}

test('includes 0% deployed versions, later-page preview bindings and absent/false hasPreview without leaking values', async () => {
  const f = setup(), c = f.make(), pending = c.run(); assert.equal(c.run(), pending);
  const r = await pending;
  assert.equal(r.result, 'VERSION_BINDINGS_OBSERVED_GAPS_RETAINED');
  assert.equal(r.callableDefaultVersionBindingsObserved, true); assert.equal(r.allInvocationPathsInventoried, false);
  assert.equal(r.fullPreflightPassed, false); assert.equal(r.snapshotIsAtomic, false);
  assert.equal(r.workers.length, 5); assert.ok(r.workers.every(w => w.stable));
  assert.equal(r.operations.length, 44); assert.ok(r.operations.every(op => op.result === 'ACK'));
  assert.equal(r.edges.length, 3); assert.deepEqual(r.edges.map(e => e.kind).sort(), ['d1', 'durable-object', 'service']);
  const producer = r.workers.find(w => w.name === 'producer');
  assert.equal(producer.versionDetails.length, 4); assert.equal(producer.previewVersionCount, 4);
  assert.equal(producer.deployment.versions.find(v => v.versionId === uuid(2)).percentage, 0);
  assert.equal(producer.versionDetails.find(v => v.versionId === uuid(3)).inCurrentDeployment, false);
  assert.equal(f.calls.some(path => path.endsWith('/versions/' + uuid(9))), false);
  const raw = fs.readFileSync(resolve(f.dir, 'result.json'), 'utf8'), log = fs.readFileSync(resolve(f.dir, 'journal.jsonl'), 'utf8');
  for (const secret of [token, privateValue]) {assert.ok(!raw.includes(secret)); assert.ok(!log.includes(secret));}
  let previous = '0'.repeat(64);
  for (const line of log.trim().split('\n')) {const {sha256, ...row} = JSON.parse(line); assert.equal(row.previous, previous); assert.equal(sha(JSON.stringify(row)), sha256); previous = sha256;}
  r.edges.length = 0; assert.equal(c.report().edges.length, 3);
});

for (const kind of ['missing-target', 'duplicate-worker', 'unsafe-worker', 'too-many-workers', 'root-drift', 'legacy-environment',
  'wrong-service', 'service-drift', 'missing-preview-flag', 'preview-flag-drift', 'empty-deployment', 'duplicate-deployed-version',
  'invalid-percentage', 'invalid-sum', 'deployment-drift', 'missing-pagination', 'wrong-page', 'wrong-count', 'changed-total',
  'excess-total', 'duplicate-version', 'missing-active-in-preview', 'preview-catalogue-drift', 'wrong-version-id', 'missing-bindings',
  'conflicting-d1-aliases', 'duplicate-binding', 'missing-service-target', 'http-error', 'invalid-errors', 'redirect', 'mime', 'length', 'utf8']) {
  test('fails closed and retains evidence: ' + kind, async () => {
    const f = setup(); f.hook(({path, n, value}) => {
      if (path === a + '/workers/scripts') {
        if (kind === 'missing-target') value.result.shift();
        if (kind === 'duplicate-worker') value.result.push(value.result[0]);
        if (kind === 'unsafe-worker') value.result[0].id = '../escape';
        if (kind === 'too-many-workers') value.result = Array(201).fill(value.result[0]);
        if (kind === 'root-drift' && n === 1) value.result[0].modified_on = 'changed';
        if (kind === 'http-error') return Response.json(value, {status: 403});
        if (kind === 'invalid-errors') value.errors = {};
        if (kind === 'redirect') return {status: 200, redirected: true, body: new ReadableStream(), headers: new Headers()};
        if (kind === 'mime') return new Response(JSON.stringify(value), {headers: {'Content-Type': 'text/html'}});
        if (kind === 'length') return Response.json(value, {headers: {'Content-Length': '1'}});
        if (kind === 'utf8') return new Response(new Uint8Array([255]), {headers: {'Content-Type': 'application/json'}});
      }
      if (path.endsWith('/workers/services/producer')) {
        if (kind === 'legacy-environment') value.result.environments.push({environment: 'legacy'});
        if (kind === 'wrong-service') value.result.id = 'other';
        if (kind === 'service-drift' && n === 1) {value.result.default_environment.environment = 'changed'; value.result.environments = [{environment: 'changed'}];}
      }
      if (path.endsWith('/producer/subdomain')) {
        if (kind === 'missing-preview-flag') delete value.result.previews_enabled;
        if (kind === 'preview-flag-drift' && n === 1) value.result.previews_enabled = false;
      }
      if (path.endsWith('/producer/deployments')) {
        const d = value.result.deployments[0];
        if (kind === 'empty-deployment') value.result.deployments = [];
        if (kind === 'duplicate-deployed-version') d.versions[1].version_id = uuid(1);
        if (kind === 'invalid-percentage') d.versions[1].percentage = -1;
        if (kind === 'invalid-sum') d.versions[0].percentage = 99;
        if (kind === 'deployment-drift' && n === 1) d.id = uuid(101);
      }
      if (path.includes('/producer/versions?')) {
        const second = path.includes('page=2&');
        if (kind === 'missing-pagination') delete value.result_info;
        if (kind === 'wrong-page') value.result_info.page = 9;
        if (kind === 'wrong-count') value.result_info.count = 0;
        if (kind === 'changed-total' && second) value.result_info.total_count = 5;
        if (kind === 'excess-total') value.result_info.total_count = 501;
        if (kind === 'duplicate-version' && second) value.result.items[0].id = uuid(1);
        if (kind === 'missing-active-in-preview' && !second) value.result.items[1].id = uuid(8);
        if (kind === 'preview-catalogue-drift' && n === 1 && second) value.result.items[0].metadata.hasPreview = true;
      }
      if (path.endsWith('/producer/versions/' + uuid(2))) {
        if (kind === 'wrong-version-id') value.result.id = uuid(99);
        if (kind === 'missing-bindings') delete value.result.resources.bindings;
        if (kind === 'conflicting-d1-aliases') value.result.resources.bindings[2].database_id = uuid(88);
        if (kind === 'duplicate-binding') value.result.resources.bindings[2].name = 'PRIVATE';
      }
      if (path.endsWith('/producer/versions/' + uuid(3)) && kind === 'missing-service-target') delete value.result.resources.bindings[2].service;
      return Response.json(value);
    });
    const r = await f.make().run(); assert.equal(r.result, 'FAILED_RETAINED');
    assert.equal(r.callableDefaultVersionBindingsObserved, false); assert.equal(r.fullPreflightPassed, false);
    assert.ok(fs.existsSync(resolve(f.dir, 'result.json')));
  });
}
test('disabled previews do not trigger a historical scan but current 0% deployment versions remain included', async () => {
  const f = setup(); f.hook(({path, value}) => {if (path.endsWith('/producer/subdomain')) {value.result.previews_enabled = false; return Response.json(value);}});
  const r = await f.make().run(); assert.equal(r.callableDefaultVersionBindingsObserved, true);
  assert.equal(f.calls.some(path => path.includes('/versions?')), false);
  assert.equal(r.workers.find(w => w.name === 'producer').versionDetails.length, 2);
  assert.equal(r.edges[0].kind, 'd1');
});
test('body size is bounded even with compressed or dishonest Content-Length', async () => {
  const f = setup(); f.hook(() => new Response(' '.repeat(2097153), {headers: {'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'Content-Length': '1'}}));
  assert.equal((await f.make().run()).callableDefaultVersionBindingsObserved, false); assert.equal(f.calls.length, 1);
});
test('timeout cancels late noncooperative response and cannot mutate final evidence', {timeout: 5000}, async () => {
  // Allow durable reservation and PENDING persistence before exercising the hung fetch.
  let finish, cancelled = 0; const f = setup({timeoutMs: 1000}); f.hook(() => new Promise(resolve => {finish = resolve;}));
  const c = f.make(), r = await c.run(), log = fs.readFileSync(resolve(f.dir, 'journal.jsonl'), 'utf8');
  assert.equal(r.result, 'FAILED_RETAINED');
  finish(new Response(new ReadableStream({cancel() {cancelled++;}}))); await tick(); await tick();
  assert.equal(cancelled, 1); assert.deepEqual(c.report(), r); assert.equal(fs.readFileSync(resolve(f.dir, 'journal.jsonl'), 'utf8'), log);
});
test('caller cancellation bounds a fetch that ignores AbortSignal', async () => {
  const ac = new AbortController(), f = setup({signal: ac.signal}); f.hook(() => new Promise(() => {}));
  const p = f.make().run(); await tick(); ac.abort(); assert.equal((await p).result, 'FAILED_RETAINED');
});
test('already aborted request creates no reservation or cloud traffic', async () => {
  const f = setup({signal: AbortSignal.abort()}); assert.equal((await f.make().run()).result, 'FAILED_RETAINED');
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(f.dir), false);
});
test('existing reservation is never replayed or overwritten', async () => {
  const f = setup(); await f.make().run(); const before = fs.readFileSync(resolve(f.dir, 'result.json')), count = f.calls.length;
  assert.equal((await f.make().run()).result, 'FAILED_RETAINED'); assert.equal(f.calls.length, count);
  assert.deepEqual(fs.readFileSync(resolve(f.dir, 'result.json')), before);
});
test('symlinked parent is refused before traffic', async () => {
  const f = setup(), target = fs.mkdtempSync(resolve(process.env.BYOK_OPERATOR_TEST_ROOT ?? '.wrangler/staging', 'byok-version-link-'));
  fs.symlinkSync(target, resolve(f.workspace, '.wrangler'), 'junction');
  assert.equal((await f.make().run()).result, 'FAILED_RETAINED'); assert.equal(f.calls.length, 0); assert.deepEqual(fs.readdirSync(target), []);
});
test('invalid configuration rejects before I/O', () => {
  const f = setup(); for (const change of [{apiToken: 'bad\n'}, {timeoutMs: 600001}, {timeoutMs: 0}, {fetchImpl: null}]) assert.throws(() => create({...f.opts, ...change}));
  assert.equal(f.calls.length, 0);
});
test('records only bounded transport error identifiers, never raw messages or credentials', async () => {
  const f = setup(); f.hook(() => {throw new TypeError(privateValue + token, {cause: {code: 'ECONNRESET', message: privateValue}});});
  const r = await f.make().run(); assert.equal(r.result, 'FAILED_RETAINED');
  assert.equal(r.operations[0].failureClass, 'READ_FAILURE');
  assert.equal(r.operations[0].errorName, 'TypeError'); assert.equal(r.operations[0].errorCode, 'ECONNRESET');
  const saved = fs.readFileSync(resolve(f.dir, 'result.json'), 'utf8');
  assert.ok(!saved.includes(privateValue)); assert.ok(!saved.includes(token));
});
test('ten-minute discovery budget is explicit and does not grant preflight or increase other limits', async () => {
  const f = setup(), r = await f.make().run();
  assert.deepEqual(r.discoveryBudget, {timeoutMs: 600000, requestLimit: 1000, concurrency: 4, requestTimeoutMs: 20000, responseBytes: 2097152});
  assert.equal(r.allInvocationPathsInventoried, false); assert.equal(r.fullPreflightPassed, false);
  const shorter = setup({timeoutMs: 300000}); assert.equal((await shorter.make().run()).discoveryBudget.timeoutMs, 300000);
});
test('delayed requests remain globally bounded to four concurrent fetches', async () => {
  let active = 0, peak = 0; const f = setup();
  f.hook(async () => {active++; peak = Math.max(peak, active); await tick(); active--;});
  assert.equal((await f.make().run()).callableDefaultVersionBindingsObserved, true);
  assert.equal(active, 0); assert.equal(peak, 4);
});
test('large version histories stop at exactly 1000 GETs even with the larger time budget', async () => {
  const f = setup(); f.hook(({path, value}) => {
    if (path.endsWith('/subdomain')) value.result.previews_enabled = true;
    if (path.includes('/versions?')) {
      const page = Number(new URL('https://example.test' + path).searchParams.get('page'));
      value.result.items = Array.from({length: 100}, (_, i) => ({id: uuid((page - 1) * 100 + i + 1), number: (page - 1) * 100 + i + 1, metadata: {}}));
      value.result_info = {page, per_page: 100, count: 100, total_count: 500};
    }
    return Response.json(value);
  });
  const r = await f.make().run();
  assert.equal(r.result, 'FAILED_RETAINED'); assert.equal(r.callableDefaultVersionBindingsObserved, false);
  assert.equal(f.calls.length, 1000); assert.equal(r.operations.length, 1000);
  assert.equal(r.automaticRetries, 0); assert.equal(r.fullPreflightPassed, false);
  const lines = fs.readFileSync(resolve(f.dir, 'journal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2002); assert.equal(JSON.parse(lines.at(-1)).event, 'FINISHED');
});
