import assert from 'node:assert/strict';
import test from 'node:test';
import { sql } from 'drizzle-orm';
import { createPostgresFinancialConsumer, createRoleCheckedRecoveryClient,
  FINANCIAL_RECOVERY_ROLE } from './postgres-financial-consumer.ts';

const limits = Object.freeze({ scope: { kind: 'all' }, maxRegistrations: 2, maxItems: 2,
  concurrency: 1, leaseSeconds: 30, runBudgetMs: 10_000,
  reservedBytesPerConsumer: 7, reservedBytesPerScan: 11 });
const serverDefaults = Object.freeze({ transaction_timeout_ms: '30000',
  statement_timeout_ms: '15000', lock_timeout_ms: '5000',
  idle_transaction_timeout_ms: '10000' });

function fakeRaw(roleForSession = () => FINANCIAL_RECOVERY_ROLE) {
  const events = [];
  let nextSession = 0;
  const result = rows => Object.assign(Promise.resolve(rows), {
    values: () => Promise.resolve(rows.map(row => Object.values(row))),
  });
  const raw = {
    options: { parsers: {}, serializers: {} },
    unsafe() { throw new Error('Unscoped PostgreSQL SQL forbidden in consumer test'); },
    async begin(run) {
      const session = ++nextSession;
      const selected = roleForSession(session);
      const role = typeof selected === 'string'
        ? { ...serverDefaults, current_role: selected, session_role: selected }
        : { ...serverDefaults, ...selected };
      const tx = {
        unsafe(query) {
          if (query.startsWith('SELECT current_user AS current_role, session_user AS session_role,')) {
            events.push({ session, kind: 'role' });
            return result([role]);
          }
          events.push({ session, kind: 'statement', query });
          if (/^select 1(?:\s|$)/i.test(query)) return result([{ one: 1 }]);
          if (query.includes('FROM cinatoken_gateway.request_usage_settlements')
            || query.includes('FROM cinatoken_gateway.request_usage_recovery_jobs')) return result([]);
          throw new Error('Unexpected recovery SQL in local test');
        },
      };
      return run(tx);
    },
  };
  return { raw, events };
}

function client(raw) { return { driver: 'postgres', raw, drizzle: {} }; }

function fixture({ enabled = true, recovery = fakeRaw(), open, retire, inputLimits = limits } = {}) {
  const runtime = client(fakeRaw().raw);
  const dispatchProducer = client(fakeRaw().raw);
  const factProducer = client(fakeRaw().raw);
  let opened = 0, retired = 0, acquisitions = 0, releases = 0;
  const privateClient = client(recovery.raw);
  const dependencies = {
    enabled, runtime, dispatchProducer, factProducer,
    limits: inputLimits,
    capacity: { tryAcquire() { acquisitions++; return { release() { releases++; } }; } },
    async openInvocationClient() { opened++; return open ? open({ runtime, dispatchProducer, factProducer, privateClient }) : privateClient; },
    async retireConfirmedClient(value) { retired++; assert.equal(value, privateClient); await retire?.(); },
  };
  return { dependencies, recovery, counters: () => ({ opened, retired, acquisitions, releases }) };
}

test('default-disabled consumer does not open a database client', async () => {
  const input = fixture();
  delete input.dependencies.enabled;
  const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
  assert.deepEqual(outcome, { status: 'disabled', queueAckSafe: false });
  assert.deepEqual(input.counters(), { opened: 0, retired: 0, acquisitions: 0, releases: 0 });
});

test('shared runtime or producer raw authority is rejected before SQL or capacity allocation', async () => {
  for (const shared of ['runtime', 'dispatchProducer', 'factProducer']) {
    const input = fixture({ open: authorities => client(authorities[shared].raw) });
    const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
    assert.deepEqual(outcome, { status: 'shared_authority', queueAckSafe: false,
      clientDisposition: 'belongs_to_other_owner' });
    assert.deepEqual(input.counters(), { opened: 1, retired: 0, acquisitions: 0, releases: 0 });
    assert.equal(input.recovery.events.length, 0);
  }
});

test('open failure and invalid returned client keep resource ownership explicit', async () => {
  const opening = fixture({ open() { throw new Error('open response lost'); } });
  const failed = await createPostgresFinancialConsumer(opening.dependencies).runOnce();
  assert.deepEqual(failed, { status: 'open_failed', queueAckSafe: false,
    clientReturned: false, resourceState: 'unknown' });
  assert.deepEqual(opening.counters(), { opened: 1, retired: 0, acquisitions: 0, releases: 0 });

  const invalid = fixture({ open() { return { driver: 'd1', raw: {} }; } });
  const consumer = createPostgresFinancialConsumer(invalid.dependencies);
  assert.deepEqual(await consumer.runOnce(), {
    status: 'invalid_client', queueAckSafe: false, locallyRetainedClient: true,
  });
  assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: true });
  assert.deepEqual(invalid.counters(), { opened: 1, retired: 0, acquisitions: 0, releases: 0 });
});

test('wrong direct-login role is rejected before any recovery scan', async () => {
  const input = fixture({ recovery: fakeRaw(() => 'cinatoken_gateway_runtime') });
  const consumer = createPostgresFinancialConsumer(input.dependencies);
  assert.deepEqual(await consumer.runOnce(), {
    status: 'authority_rejected', queueAckSafe: false, locallyRetainedClient: true,
  });
  assert.deepEqual(await consumer.runOnce(), { status: 'already_used', queueAckSafe: false });
  assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: true });
  assert.deepEqual(input.recovery.events.map(event => event.kind), ['role']);
  assert.deepEqual(input.counters(), { opened: 1, retired: 0, acquisitions: 0, releases: 0 });
});

test('SET ROLE impersonation is rejected when current_user matches but session_user differs', async () => {
  const recovery = fakeRaw(() => ({ current_role: FINANCIAL_RECOVERY_ROLE,
    session_role: 'cinatoken_gateway_runtime' }));
  const input = fixture({ recovery });
  const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
  assert.equal(outcome.status, 'authority_rejected');
  assert.deepEqual(recovery.events.map(event => event.kind), ['role']);
  assert.equal(input.counters().acquisitions, 0);
});

test('financial transaction callback receives SQL authority only after same-session role check', async () => {
  const recovery = fakeRaw();
  const checked = createRoleCheckedRecoveryClient(client(recovery.raw));
  const rows = await checked.raw.begin(async tx => tx.unsafe('SELECT 1'));
  assert.deepEqual(rows, [{ one: 1 }]);
  assert.deepEqual(recovery.events.map(event => event.kind), ['role', 'statement']);
  assert.equal(recovery.events[0].session, recovery.events[1].session);
  const transactionRows = await checked.drizzle.transaction(tx => tx.execute(sql`SELECT 1`));
  assert.deepEqual(transactionRows, [{ one: 1 }]);
  const values = await checked.raw.unsafe('SELECT 1').values();
  assert.deepEqual(values, [[1]]);
  assert.deepEqual(recovery.events.slice(2).map(event => event.kind), ['role', 'statement', 'role', 'statement']);
  assert.equal(recovery.events[2].session, recovery.events[3].session);
  assert.equal(recovery.events[4].session, recovery.events[5].session);
  const drift = fakeRaw(() => 'cinatoken_gateway_fact_producer');
  const denied = createRoleCheckedRecoveryClient(client(drift.raw));
  await assert.rejects(denied.raw.begin(async tx => tx.unsafe('SELECT 1')), /Dedicated PostgreSQL recovery login and server deadlines required/);
  assert.deepEqual(drift.events.map(event => event.kind), ['role']);
});

test('missing, disabled and oversized server defaults reject before recovery SQL or capacity', async () => {
  for (const [name, value] of [
    ['transaction_timeout_ms', null], ['transaction_timeout_ms', '0'],
    ['transaction_timeout_ms', '30001'], ['statement_timeout_ms', '15001'],
    ['lock_timeout_ms', '5001'], ['idle_transaction_timeout_ms', '10001'],
  ]) {
    const input = fixture({ recovery: fakeRaw(() => ({
      current_role: FINANCIAL_RECOVERY_ROLE, session_role: FINANCIAL_RECOVERY_ROLE,
      [name]: value,
    })) });
    const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
    assert.equal(outcome.status, 'authority_rejected', `${name}=${value}`);
    assert.deepEqual(input.recovery.events.map(event => event.kind), ['role']);
    assert.deepEqual(input.counters(), { opened: 1, retired: 0, acquisitions: 0, releases: 0 });
  }
});

test('later session server deadline drift prevents new recovery SQL', async () => {
  const input = fixture({ recovery: fakeRaw(session => session === 1
    ? FINANCIAL_RECOVERY_ROLE : { current_role: FINANCIAL_RECOVERY_ROLE,
      session_role: FINANCIAL_RECOVERY_ROLE, transaction_timeout_ms: null }) });
  const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
  assert.equal(outcome.status, 'outcome_unknown');
  assert.equal(outcome.locallyRetainedClient, true);
  assert.deepEqual(input.recovery.events.map(event => event.kind), ['role', 'role']);
  assert.deepEqual(input.counters(), { opened: 1, retired: 0, acquisitions: 2, releases: 1 });
});

test('confirmed empty sweep checks recovery role on each statement session and drains holds', async () => {
  const input = fixture();
  const consumer = createPostgresFinancialConsumer(input.dependencies);
  const outcome = await consumer.runOnce();
  assert.equal(outcome.status, 'run_drained');
  assert.equal(outcome.queueAckSafe, false);
  assert.equal(outcome.physicalClose, 'not_observed');
  assert.equal(outcome.result.resources, 'confirmed');
  assert.equal(outcome.result.discovered, 0);
  assert.equal(outcome.result.scanned, 0);
  assert.deepEqual(input.counters(), { opened: 1, retired: 1, acquisitions: 2, releases: 2 });
  assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: false });
  const events = input.recovery.events;
  assert.deepEqual(events.map(event => event.kind), ['role', 'role', 'statement', 'role', 'statement']);
  for (const statement of events.filter(event => event.kind === 'statement')) {
    const preceding = events[events.indexOf(statement) - 1];
    assert.equal(preceding.kind, 'role');
    assert.equal(preceding.session, statement.session);
  }
});

test('later session role drift never reaches recovery SQL and retains uncertain authority', async () => {
  const input = fixture({ recovery: fakeRaw(session => session === 1
    ? FINANCIAL_RECOVERY_ROLE : 'cinatoken_gateway_fact_producer') });
  const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
  assert.equal(outcome.status, 'outcome_unknown');
  assert.equal(outcome.queueAckSafe, false);
  assert.equal(outcome.locallyRetainedClient, true);
  assert.equal(outcome.result.resources, 'unconfirmed');
  assert.deepEqual(input.recovery.events.map(event => event.kind), ['role', 'role']);
  assert.deepEqual(input.counters(), { opened: 1, retired: 0, acquisitions: 2, releases: 1 });
});

test('failed client retirement cannot be reported as a drained successful invocation', async () => {
  const input = fixture({ retire() { throw new Error('close result lost'); } });
  const outcome = await createPostgresFinancialConsumer(input.dependencies).runOnce();
  assert.equal(outcome.status, 'outcome_unknown');
  assert.equal(outcome.locallyRetainedClient, true);
  assert.equal(outcome.queueAckSafe, false);
  assert.deepEqual(input.counters(), { opened: 1, retired: 1, acquisitions: 2, releases: 2 });
});

test('invalid bounded limits are rejected before opening a client', () => {
  const input = fixture({ inputLimits: { ...limits, concurrency: 5 } });
  assert.throws(() => createPostgresFinancialConsumer(input.dependencies), /Invalid bounded PostgreSQL recovery limits/);
  assert.equal(input.counters().opened, 0);
});
