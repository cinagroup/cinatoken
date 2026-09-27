import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresSharedEarningDelivery, SHARED_EARNING_DELIVERY_ROLE,
} from './postgres-shared-earning-delivery.ts';
import { SHARED_EARNING_CONSUMER_ROLE } from './postgres-shared-earning-consumer.ts';

const token = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const defaults = role => ({ current_role: role, session_role: role,
  transaction_timeout_ms: '30000', statement_timeout_ms: '15000',
  lock_timeout_ms: '5000', idle_transaction_timeout_ms: '10000' });
const client = raw => ({ driver: 'postgres', raw, drizzle: {} });

function fakeDelivery({ role = defaults(SHARED_EARNING_DELIVERY_ROLE), claim,
  status = 'pending', ack = 'completed', loseCommitAt = 0 } = {}) {
  const events = [];
  let transaction = 0;
  const raw = {
    unsafe() { throw new Error('Unscoped delivery SQL'); },
    async begin(run) {
      const current = ++transaction;
      const tx = { unsafe(sql, params) {
        if (sql.startsWith('SELECT current_user AS current_role, session_user AS session_role,')) {
          events.push({ kind: 'role', transaction: current });
          return Promise.resolve([role]);
        }
        if (sql === 'SELECT * FROM cinatoken_economic_delivery.claim_event($1::text,$2::integer)') {
          events.push({ kind: 'claim', transaction: current, params });
          return Promise.resolve(claim === undefined ? [{ out_event_id: params[0],
            out_claim_token: token, out_attempt_count: 1,
            out_lease_until: new Date('2030-01-01T00:00:00Z') }] : claim);
        }
        if (sql === 'SELECT * FROM cinatoken_economic_delivery.inspect_event($1::text)') {
          events.push({ kind: 'inspect', transaction: current, params });
          return Promise.resolve([{ out_status: status, out_next_attempt_at: null,
            out_lease_until: null, out_attempt_count: status === 'absent' ? null : 1 }]);
        }
        if (sql === 'SELECT cinatoken_economic_delivery.ack_event($1::text,$2::uuid) AS disposition') {
          events.push({ kind: 'ack', transaction: current, params });
          return Promise.resolve([{ disposition: ack }]);
        }
        throw new Error('Unexpected delivery SQL');
      } };
      const value = await run(tx);
      events.push({ kind: 'commit', transaction: current });
      if (current === loseCommitAt) throw new Error('COMMIT response lost');
      return value;
    },
  };
  return { raw, events };
}

function fakeEarning({ role = defaults(SHARED_EARNING_CONSUMER_ROLE),
  fail, loseCommit = false } = {}) {
  const events = [];
  const raw = {
    unsafe() { throw new Error('Unscoped earning SQL'); },
    async begin(run) {
      const tx = { unsafe(sql, params) {
        if (sql.startsWith('SELECT current_user AS current_role, session_user AS session_role,')) {
          events.push({ kind: 'role' });
          return Promise.resolve([role]);
        }
        if (sql === 'SELECT * FROM cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)') {
          events.push({ kind: 'consume', params });
          if (fail) return Promise.reject(fail);
          return Promise.resolve([{ out_event_id: params[0], out_decision: 'credited',
            out_credited_attempts: 1, out_pending_attempts: 0,
            out_net_micros: '5625000' }]);
        }
        throw new Error('Unexpected earning SQL');
      } };
      const value = await run(tx);
      events.push({ kind: 'commit' });
      if (loseCommit) throw new Error('COMMIT response lost');
      return value;
    },
  };
  return { raw, events };
}

function fixture({ enabled = true, delivery = fakeDelivery(), earning = fakeEarning(),
  openDelivery, openEarning, retireDelivery, retireEarning } = {}) {
  const authorities = [client(fakeDelivery().raw), client(fakeDelivery().raw)];
  let deliveryOpened = 0, earningOpened = 0, deliveryRetired = 0, earningRetired = 0;
  const deliveryClient = client(delivery.raw);
  const earningClient = client(earning.raw);
  const deps = { enabled, leaseSeconds: 30, forbiddenClients: authorities,
    async openDeliveryClient() { deliveryOpened++; return openDelivery ? openDelivery({ authorities,
      deliveryClient, earningClient }) : deliveryClient; },
    async retireConfirmedDeliveryClient(value) { deliveryRetired++; assert.equal(value, deliveryClient);
      await retireDelivery?.(); },
    async openEarningClient() { earningOpened++; return openEarning ? openEarning({ authorities,
      deliveryClient, earningClient }) : earningClient; },
    async retireConfirmedEarningClient(value) { earningRetired++; assert.equal(value, earningClient);
      await retireEarning?.(); },
  };
  return { deps, delivery, earning, counters: () => ({ deliveryOpened, earningOpened,
    deliveryRetired, earningRetired }) };
}

test('default-disabled candidate and invalid event ID do not open any client', async () => {
  const input = fixture();
  delete input.deps.enabled;
  const runner = createPostgresSharedEarningDelivery(input.deps);
  assert.deepEqual(await runner.runEventOnce('event-1'), { status: 'disabled', queueAckSafe: false });
  assert.deepEqual(input.counters(), { deliveryOpened: 0, earningOpened: 0,
    deliveryRetired: 0, earningRetired: 0 });
  const active = createPostgresSharedEarningDelivery(fixture().deps);
  for (const value of ['', 'a'.repeat(513), 'bad\nid', null])
    await assert.rejects(active.runEventOnce(value), /Bounded economic event ID required/);
});

test('wrong delivery LOGIN and client authority reuse stop before claim', async () => {
  const wrong = fixture({ delivery: fakeDelivery({ role: defaults('cinatoken_gateway_runtime') }) });
  assert.deepEqual(await createPostgresSharedEarningDelivery(wrong.deps).runEventOnce('event-1'),
    { status: 'authority_rejected', queueAckSafe: false, locallyRetainedClient: true });
  assert.deepEqual(wrong.delivery.events.map(event => event.kind), ['role']);
  assert.equal(wrong.counters().earningOpened, 0);

  const reused = fixture({ openDelivery: ({ authorities }) => client(authorities[0].raw) });
  assert.deepEqual(await createPostgresSharedEarningDelivery(reused.deps).runEventOnce('event-1'),
    { status: 'shared_authority', queueAckSafe: false });
  assert.deepEqual(reused.delivery.events, []);
});

test('zero-row exact claim inspects durable state and never consumes or ACKs', async () => {
  for (const status of ['absent', 'pending', 'leased', 'completed', 'dead_letter']) {
    const input = fixture({ delivery: fakeDelivery({ claim: [], status }) });
    const outcome = await createPostgresSharedEarningDelivery(input.deps).runEventOnce('event-1');
    assert.deepEqual(outcome, { status: 'unclaimed', queueAckSafe: false,
      jobStatus: status, physicalClose: 'not_observed' });
    assert.deepEqual(input.delivery.events.map(event => event.kind),
      ['role', 'claim', 'inspect', 'commit']);
    assert.deepEqual(input.counters(), { deliveryOpened: 1, earningOpened: 0,
      deliveryRetired: 1, earningRetired: 0 });
  }
});

test('exact event ID claim, committed earning, and marker-gated ACK occur in order', async () => {
  const input = fixture();
  const runner = createPostgresSharedEarningDelivery(input.deps);
  assert.deepEqual(await runner.runEventOnce('event-1'), { status: 'completed',
    queueAckSafe: false, physicalClose: 'not_observed', disposition: 'completed',
    result: { eventId: 'event-1', decision: 'credited', creditedAttempts: 1,
      pendingAttempts: 0, netMicros: '5625000' } });
  assert.deepEqual(input.delivery.events.map(event => event.kind),
    ['role', 'claim', 'commit', 'role', 'ack', 'commit']);
  assert.deepEqual(input.earning.events.map(event => event.kind), ['role', 'consume', 'commit']);
  assert.deepEqual(input.delivery.events.find(event => event.kind === 'claim').params,
    ['event-1', 30]);
  assert.deepEqual(input.delivery.events.find(event => event.kind === 'ack').params,
    ['event-1', token]);
  assert.deepEqual(input.counters(), { deliveryOpened: 1, earningOpened: 1,
    deliveryRetired: 1, earningRetired: 1 });
  assert.deepEqual(runner.snapshot(), { used: true, retainedClient: false });
  assert.deepEqual(await runner.runEventOnce('event-1'), { status: 'already_used', queueAckSafe: false });
});

test('lost claim COMMIT cannot start consumer; lost consumer or ACK COMMIT cannot mark queue safe', async () => {
  for (const [input, expectedEarningOpened, expectedAckCount] of [
    [fixture({ delivery: fakeDelivery({ loseCommitAt: 1 }) }), 0, 0],
    [fixture({ earning: fakeEarning({ loseCommit: true }) }), 1, 0],
    [fixture({ delivery: fakeDelivery({ loseCommitAt: 2 }) }), 1, 1],
    [fixture({ retireDelivery() { throw new Error('retirement response lost'); } }), 1, 1],
  ]) {
    const runner = createPostgresSharedEarningDelivery(input.deps);
    assert.deepEqual(await runner.runEventOnce('event-1'), { status: 'outcome_unknown',
      queueAckSafe: false, locallyRetainedClient: true });
    assert.deepEqual(runner.snapshot(), { used: true, retainedClient: true });
    assert.equal(input.counters().earningOpened, expectedEarningOpened);
    assert.equal(input.delivery.events.filter(event => event.kind === 'ack').length,
      expectedAckCount);
  }
});

test('earning client cannot reuse the delivery raw authority', async () => {
  const input = fixture({ openEarning: ({ deliveryClient }) => client(deliveryClient.raw) });
  const outcome = await createPostgresSharedEarningDelivery(input.deps).runEventOnce('event-1');
  assert.deepEqual(outcome, { status: 'outcome_unknown', queueAckSafe: false,
    locallyRetainedClient: true });
  assert.deepEqual(input.delivery.events.map(event => event.kind), ['role', 'claim', 'commit']);
  assert.equal(input.counters().deliveryRetired, 0);
});
