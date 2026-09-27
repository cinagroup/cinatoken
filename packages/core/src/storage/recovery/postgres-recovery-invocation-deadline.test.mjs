import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline.ts';
import { createPostgresRecoveryRun } from './run-usage-recovery-postgres.ts';
import { POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } from './postgres-recovery-operation-owner.ts';

const options = Object.freeze({
  scope: Object.freeze({ kind: 'all' }), maxRegistrations: 1, maxItems: 1,
  concurrency: 1, leaseSeconds: 30, runBudgetMs: 10,
  reservedBytesPerScan: 1, reservedBytesPerConsumer: 1,
});

test('invocation deadline is monotonic, non-renewable and never yields zero as an admissible timeout', () => {
  let time = 100;
  const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
  assert.equal(Object.isFrozen(deadline), true);
  assert.deepEqual(deadline.snapshot(), { status: 'open', remainingMs: 10 });
  time = 105.25;
  assert.deepEqual(deadline.snapshot(), { status: 'open', remainingMs: 4 });
  time = 109.1;
  assert.deepEqual(deadline.snapshot(), { status: 'expired', remainingMs: 0 });
  time = 108;
  assert.deepEqual(deadline.snapshot(), { status: 'expired', remainingMs: 0 });
});

test('clock throw, nonfinite values and regression fail closed without renewing the budget', () => {
  for (const bad of [NaN, Infinity, -1, 9]) {
    let time = 10;
    const deadline = createPostgresRecoveryInvocationDeadline(10, () => time);
    assert.equal(deadline.snapshot().status, 'open');
    time = bad;
    assert.deepEqual(deadline.snapshot(), { status: 'clock_invalid', remainingMs: 0 });
    time = 11;
    assert.deepEqual(deadline.snapshot(), { status: 'clock_invalid', remainingMs: 0 });
  }
  let reads = 0;
  const throwing = createPostgresRecoveryInvocationDeadline(10, () => {
    if (++reads > 1) throw new Error('private clock');
    return 0;
  });
  assert.deepEqual(throwing.snapshot(), { status: 'clock_invalid', remainingMs: 0 });
});

test('invalid budget or initial clock is rejected before any recovery client can be opened', () => {
  for (const budget of [0, -1, 60_001, 1.5, NaN, Infinity])
    assert.throws(() => createPostgresRecoveryInvocationDeadline(budget, () => 0), /Invalid PostgreSQL recovery invocation budget/);
  for (const initial of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => createPostgresRecoveryInvocationDeadline(10, () => initial), /Invalid PostgreSQL recovery invocation clock/);
  assert.throws(() => createPostgresRecoveryInvocationDeadline(10, () => { throw new Error('private'); }),
    /Invalid PostgreSQL recovery invocation clock/);
});

function noSqlFixture() {
  let queries = 0, holds = 0;
  return {
    client: { driver: 'postgres', raw: {
      options: { parsers: {}, serializers: {} },
      recoveryStatementDeadlineFence: POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE,
      unsafe() { queries++; throw new Error('expired run must not issue SQL'); },
      begin() { throw new Error('expired run must not begin'); },
    } },
    capacity: { tryAcquire() { holds++; throw new Error('expired run must not acquire capacity'); } },
    counts: () => ({ queries, holds }),
  };
}

test('a deadline started before client initialization stops the runner before SQL or capacity', async () => {
  let time = 0;
  const deadline = createPostgresRecoveryInvocationDeadline(options.runBudgetMs, () => time);
  time = 10;
  const f = noSqlFixture();
  const run = createPostgresRecoveryRun(f.client, options, f.capacity, { deadline });
  const result = await run.completion;
  assert.equal(result.stopReason, 'budget');
  assert.equal(result.admissionStopped, true);
  assert.equal(result.resources, 'confirmed');
  assert.deepEqual(f.counts(), { queries: 0, holds: 0 });
});

test('clock failure is distinct from expiry; a second clock or renewed budget is rejected', async () => {
  let time = 0;
  const deadline = createPostgresRecoveryInvocationDeadline(options.runBudgetMs, () => time);
  time = NaN;
  const f = noSqlFixture();
  const run = createPostgresRecoveryRun(f.client, options, f.capacity, { deadline });
  assert.equal((await run.completion).stopReason, 'clock_invalid');
  assert.deepEqual(f.counts(), { queries: 0, holds: 0 });
  assert.throws(() => createPostgresRecoveryRun(f.client, { ...options, runBudgetMs: 11 }, f.capacity, { deadline }),
    /single run clock/);
  assert.throws(() => createPostgresRecoveryRun(f.client, options, f.capacity, { deadline, now: () => 0 }),
    /single run clock/);
});

test('an open deadline rejects an old driver before recovery capacity or SQL', () => {
  const deadline = createPostgresRecoveryInvocationDeadline(options.runBudgetMs, () => 0);
  const f = noSqlFixture();
  delete f.client.raw.recoveryStatementDeadlineFence;
  assert.throws(() => createPostgresRecoveryRun(f.client, options, f.capacity, { deadline }),
    /Recovery statement deadline driver required/);
  assert.deepEqual(f.counts(), { queries: 0, holds: 0 });
});
