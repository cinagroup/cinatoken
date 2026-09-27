import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createUsageRecoveryJobsPostgres, postgresRecoveryScan } from './usage-recovery-jobs-postgres.ts';

const all = Object.freeze({ kind: 'all' });
const tenant = Object.freeze({ kind: 'tenant', userId: 'user', workspaceId: 'workspace' });
const expected = Object.freeze({
  'unregistered:all': 'b0c1db90763244dedf24aabba786941ec1f2af976c64ed8657ca9d64726e430f',
  'unregistered:tenant': 'e827ddea5b8432be1933e1f67125f17df555a19133b0c9c8aba7e852db1cb5b0',
  'due:all': 'c1ec7622024ed4631e5d6a076684267d1dd0e7e550fed38e9abdc0c36e1b2fcf',
  'due:tenant': '6ebba1daa7a11b3733856ba6531a3cb1f71192ee4b8a619a81c44d35a988b83a',
});

test('the closed catalogue pins all four existing read-only scan SQL byte sequences and bound parameters', () => {
  for (const kind of ['unregistered', 'due']) for (const scope of [all, tenant]) {
    const statement = postgresRecoveryScan(kind, scope, 7);
    assert.equal(createHash('sha256').update(statement.query).digest('hex'), expected[`${kind}:${scope.kind}`]);
    assert.deepEqual(statement.params, scope.kind === 'tenant' ? ['user', 'workspace', 7] : [7]);
    assert.equal(Object.isFrozen(statement), true);
    assert.equal(Object.isFrozen(statement.params), true);
    assert.match(statement.query, /^SELECT /);
    assert.doesNotMatch(statement.query, /\b(?:INSERT|UPDATE|DELETE|FOR UPDATE|COPY)\b/i);
  }
});

test('catalogue rejects unknown operation, malformed scope and out-of-range limit before any SQL', () => {
  assert.throws(() => postgresRecoveryScan('claim', all, 1), /Invalid recovery scan kind/);
  assert.throws(() => postgresRecoveryScan('due', { kind: 'tenant', userId: 'user\n', workspaceId: 'workspace' }, 1), /Invalid recovery scope/);
  for (const limit of [0, 51, 1.5, NaN, Infinity])
    assert.throws(() => postgresRecoveryScan('unregistered', all, limit), /Invalid recovery integer/);
});

test('default repository path executes the exact catalogue SQL without invoking a callback', async () => {
  const calls = [];
  const raw = { unsafe(query, params) { calls.push({ query, params }); return Promise.resolve([]); } };
  const jobs = createUsageRecoveryJobsPostgres({ driver: 'postgres', raw });
  assert.deepEqual(await jobs.scanUnregistered(tenant, 7), []);
  assert.deepEqual(await jobs.scanDue(all, 5), []);
  assert.deepEqual(calls, [postgresRecoveryScan('unregistered', tenant, 7), postgresRecoveryScan('due', all, 5)]);
});

test('optional callback receives only validated owned scan inputs; non-scan inspect remains on raw', async () => {
  const scans = [], rawCalls = [];
  const raw = { unsafe(query, params) { rawCalls.push({ query, params }); return Promise.resolve([]); } };
  const control = { scan(kind, scope, limit) {
    scans.push({ kind, scope, limit });
    assert.equal(Object.isFrozen(scope), true);
    return Promise.resolve([]);
  } };
  const jobs = createUsageRecoveryJobsPostgres({ driver: 'postgres', raw }, control);
  control.scan = () => { throw new Error('callback replacement must not take effect'); };
  assert.deepEqual(await jobs.scanUnregistered(tenant, 7), []);
  assert.deepEqual(await jobs.scanDue(all, 5), []);
  assert.deepEqual(scans, [{ kind: 'unregistered', scope: tenant, limit: 7 }, { kind: 'due', scope: all, limit: 5 }]);
  assert.equal(rawCalls.length, 0);
  const ref = { requestId: 'request', attemptIndex: 1, userId: 'user', apiKeyId: 'key', workspaceId: 'workspace',
    operation: 'images.generations', contextSha256: 'a'.repeat(64),
    dispatchClaimId: '00000000-0000-4000-8000-000000000001', payloadSha256: 'b'.repeat(64) };
  assert.equal(await jobs.inspect(ref), null);
  assert.equal(rawCalls.length, 1);
  assert.equal(scans.length, 2);
});

test('invalid repository scans never enter either callback or raw path', async () => {
  let called = 0;
  const jobs = createUsageRecoveryJobsPostgres({ driver: 'postgres', raw: { unsafe() { called++; return Promise.resolve([]); } } },
    { scan() { called++; return Promise.resolve([]); } });
  await assert.rejects(jobs.scanDue({ kind: 'tenant', userId: 'user', workspaceId: 'workspace\n' }, 1), TypeError);
  await assert.rejects(jobs.scanUnregistered(all, 51), TypeError);
  assert.equal(called, 0);
  assert.throws(() => createUsageRecoveryJobsPostgres({ driver: 'postgres', raw: {} }, { scan: true }), TypeError);
});
