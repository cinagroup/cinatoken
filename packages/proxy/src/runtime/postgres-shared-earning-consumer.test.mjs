import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresSharedEarningConsumer, SHARED_EARNING_CONSUMER_ROLE,
} from './postgres-shared-earning-consumer.ts';

const defaults = Object.freeze({ current_role: SHARED_EARNING_CONSUMER_ROLE,
  session_role: SHARED_EARNING_CONSUMER_ROLE, transaction_timeout_ms: '30000',
  statement_timeout_ms: '15000', lock_timeout_ms: '5000',
  idle_transaction_timeout_ms: '10000' });

function fakeRaw({ role = defaults, result, fail, afterCommit } = {}) {
  const events = [];
  const raw = {
    unsafe() { throw new Error('No unscoped consumer SQL'); },
    async begin(run) {
      const tx = { unsafe(query, params) {
        if (query.startsWith('SELECT current_user AS current_role, session_user AS session_role,')) {
          events.push({ kind: 'role', query });
          return Promise.resolve([role]);
        }
        if (query === 'SELECT * FROM cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)') {
          events.push({ kind: 'consume', query, params });
          if (fail) return Promise.reject(fail);
          return Promise.resolve(result ?? [{ out_event_id: params[0], out_decision: 'credited',
            out_credited_attempts: 1, out_pending_attempts: 0, out_net_micros: '1250000' }]);
        }
        throw new Error('Unexpected consumer SQL');
      } };
      const value = await run(tx);
      events.push({ kind: 'commit' });
      if (afterCommit) throw afterCommit;
      return value;
    },
  };
  return { raw, events };
}

const client = raw => ({ driver: 'postgres', raw, drizzle: {} });

function fixture({ enabled = true, raw = fakeRaw(), open, retire } = {}) {
  const forbidden = [client(fakeRaw().raw), client(fakeRaw().raw), client(fakeRaw().raw)];
  const privateClient = client(raw.raw);
  let opened = 0, retired = 0;
  const dependencies = { enabled, forbiddenClients: forbidden,
    async openInvocationClient() { opened++; return open ? open({ forbidden, privateClient }) : privateClient; },
    async retireConfirmedClient(value) { retired++; assert.equal(value, privateClient); await retire?.(); },
  };
  return { dependencies, raw, counters: () => ({ opened, retired }) };
}

test('default-off and invalid event IDs perform no database operation', async () => {
  const input = fixture();
  delete input.dependencies.enabled;
  const consumer = createPostgresSharedEarningConsumer(input.dependencies);
  assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'disabled', queueAckSafe: false });
  assert.deepEqual(consumer.snapshot(), { used: false, retainedClient: false });
  assert.deepEqual(input.counters(), { opened: 0, retired: 0 });
  const active = createPostgresSharedEarningConsumer(fixture().dependencies);
  for (const id of ['', 'a'.repeat(513), 'bad\nidentifier', null])
    await assert.rejects(active.runEventOnce(id), /Bounded economic event ID required/);
  assert.deepEqual(active.snapshot(), { used: false, retainedClient: false });
});

test('shared request or producer authority cannot invoke the function', async () => {
  for (const index of [0, 1, 2]) {
    const input = fixture({ open: ({ forbidden }) => client(forbidden[index].raw) });
    const consumer = createPostgresSharedEarningConsumer(input.dependencies);
    assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'shared_authority',
      queueAckSafe: false, clientDisposition: 'belongs_to_other_owner' });
    assert.deepEqual(input.counters(), { opened: 1, retired: 0 });
    assert.deepEqual(input.raw.events, []);
    assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: false });
  }
});

test('activation and forbidden raw identities are fixed when the one-shot owner is created', async () => {
  const disabled = fixture({ enabled: false });
  const disabledConsumer = createPostgresSharedEarningConsumer(disabled.dependencies);
  disabled.dependencies.enabled = true;
  assert.deepEqual(await disabledConsumer.runEventOnce('event-1'),
    { status: 'disabled', queueAckSafe: false });
  assert.equal(disabled.counters().opened, 0);

  const input = fixture();
  const originalRaw = input.dependencies.forbiddenClients[0].raw;
  const consumer = createPostgresSharedEarningConsumer(input.dependencies);
  input.dependencies.forbiddenClients[0].raw = fakeRaw().raw;
  input.dependencies.openInvocationClient = async () => client(originalRaw);
  assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'shared_authority',
    queueAckSafe: false, clientDisposition: 'belongs_to_other_owner' });
});

test('wrong role, SET ROLE impersonation and missing server deadlines fail before consume', async () => {
  for (const role of [
    { ...defaults, current_role: 'cinatoken_gateway_runtime',
      session_role: 'cinatoken_gateway_runtime' },
    { ...defaults, session_role: 'cinatoken_gateway_runtime' },
    { ...defaults, transaction_timeout_ms: null },
    { ...defaults, statement_timeout_ms: '15001' },
    { ...defaults, lock_timeout_ms: '0' },
    { ...defaults, idle_transaction_timeout_ms: '10001' },
  ]) {
    const input = fixture({ raw: fakeRaw({ role }) });
    const consumer = createPostgresSharedEarningConsumer(input.dependencies);
    assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'authority_rejected',
      queueAckSafe: false, locallyRetainedClient: true });
    assert.deepEqual(input.raw.events.map(event => event.kind), ['role']);
    assert.deepEqual(input.counters(), { opened: 1, retired: 0 });
    assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: true });
  }
});

test('one event ID and one SQL transaction produce a bounded decision after COMMIT', async () => {
  const input = fixture();
  const consumer = createPostgresSharedEarningConsumer(input.dependencies);
  assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'processed',
    queueAckSafe: false, physicalClose: 'not_observed',
    result: { eventId: 'event-1', decision: 'credited', creditedAttempts: 1,
      pendingAttempts: 0, netMicros: '1250000' } });
  assert.deepEqual(input.raw.events.map(event => event.kind), ['role', 'consume', 'commit']);
  assert.deepEqual(input.raw.events[1].params, ['event-1']);
  assert.deepEqual(input.counters(), { opened: 1, retired: 1 });
  assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: false });
  assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'already_used', queueAckSafe: false });
});

test('pending_manual is surfaced without claiming a Queue ACK', async () => {
  const input = fixture({ raw: fakeRaw({ result: [{ out_event_id: 'pending',
    out_decision: 'pending_manual', out_credited_attempts: 0,
    out_pending_attempts: 2, out_net_micros: '0' }] }) });
  const outcome = await createPostgresSharedEarningConsumer(input.dependencies).runEventOnce('pending');
  assert.equal(outcome.status, 'processed');
  assert.equal(outcome.result.decision, 'pending_manual');
  assert.equal(outcome.queueAckSafe, false);
});

test('invalid result, SQL failure, lost COMMIT ACK and retirement failure remain uncertain', async () => {
  const cases = [
    { raw: fakeRaw({ result: [{ out_event_id: 'wrong', out_decision: 'credited',
      out_credited_attempts: 1, out_pending_attempts: 0, out_net_micros: '1' }] }) },
    { raw: fakeRaw({ fail: new Error('SQL connection lost') }) },
    { raw: fakeRaw({ afterCommit: new Error('COMMIT response lost') }) },
    { retire() { throw new Error('retirement failed'); } },
  ];
  for (const spec of cases) {
    const input = fixture(spec);
    const consumer = createPostgresSharedEarningConsumer(input.dependencies);
    assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'outcome_unknown',
      queueAckSafe: false, locallyRetainedClient: true });
    assert.deepEqual(consumer.snapshot(), { used: true, retainedClient: true });
    assert.deepEqual(await consumer.runEventOnce('event-1'), { status: 'already_used', queueAckSafe: false });
  }
});

test('ambiguous opening and invalid client never call consumer SQL', async () => {
  const opening = fixture({ open() { throw new Error('open response lost'); } });
  assert.deepEqual(await createPostgresSharedEarningConsumer(opening.dependencies).runEventOnce('event-1'),
    { status: 'open_failed', queueAckSafe: false, clientReturned: false, resourceState: 'unknown' });
  const invalid = fixture({ open() { return { driver: 'd1', raw: {} }; } });
  assert.deepEqual(await createPostgresSharedEarningConsumer(invalid.dependencies).runEventOnce('event-1'),
    { status: 'invalid_client', queueAckSafe: false, locallyRetainedClient: true });
  assert.deepEqual(opening.raw.events, []);
  assert.deepEqual(invalid.raw.events, []);
});
