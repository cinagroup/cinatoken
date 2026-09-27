import assert from 'node:assert/strict';
import test from 'node:test';
import { publishCompleteTextPlatformEventsV402, consumeCompleteTextPlatformMessageV402 } from './complete-text-platform-event-delivery-runner-v402.mjs';
import { scanPostgresCompleteTextPlatformEventsV402, claimPostgresCompleteTextPlatformEventsV402,
  finishPostgresCompleteTextPlatformPublishV402, consumePostgresCompleteTextPlatformEventV402,
  PostgresPlatformEventCleanupUnconfirmedV402 } from './postgres-complete-text-platform-event-delivery-v402.mjs';

const PUBLISHER = 'cinatoken_gateway_complete_text_platform_event_publisher';
const CONSUMER = 'cinatoken_gateway_complete_text_platform_event_consumer';
const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';
const TERMINAL = '44444444-4444-4444-8444-444444444444';
const TIME = '2026-09-27T00:00:30.000Z';
const connection = role => `postgres://${role}:fixture-only-password@127.0.0.1:5432/fixture?sslmode=disable`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = (eventId = EVENT, attemptCount = 1) => ({ eventId, attemptCount, leaseUntil: TIME });
const consumedReceipt = (status = 'consumed') => ({ status, eventId: EVENT, terminalId: TERMINAL, requestId: 'fixture-request',
  eventType: 'platform_text_no_fetch_closed', eventVersion: 1, payloadSha256: 'a'.repeat(64), consumedAt: TIME });

/** The runner calls actual client functions; only PostgreSQL replies and broker acceptance are doubled. */
function fixture() {
  const events = [], calls = [], opens = [];
  const state = { items: [item()], consumeStatus: 'consumed', beforeSQL: undefined, beforeCommit: undefined, beforeClose: undefined,
    failure: undefined, finishStatus: undefined, consumeReceipt: undefined };
  const factory = (url, options) => {
    const role = decodeURIComponent(new URL(url).username);
    assert.equal(url, connection(role)); assert.ok([PUBLISHER, CONSUMER].includes(role)); assert.deepEqual(options, { max: 1 });
    opens.push(role); let action;
    const fail = phase => { if (state.failure?.action === action && state.failure.phase === phase) throw state.failure.error; };
    const raw = {
      async unsafe(sql, values) {
        if (sql.startsWith('SELECT current_user')) return [{ current_role: role, session_role: role, transaction_isolation: 'read committed' }];
        if (sql.startsWith('SET LOCAL ')) return [];
        const match = /^SELECT cinatoken_gateway\.(scan_complete_text_platform_events|claim_complete_text_platform_events|finish_complete_text_platform_publish|consume_complete_text_platform_event)_v402\(/u.exec(sql);
        assert.ok(match, 'Only the four exact delivery operations are used');
        action = { scan_complete_text_platform_events: 'scan', claim_complete_text_platform_events: 'claim',
          finish_complete_text_platform_publish: 'finish', consume_complete_text_platform_event: 'consume' }[match[1]];
        events.push(`${action}:sql`); calls.push({ action, values }); fail('sql'); await state.beforeSQL?.(action);
        if (action === 'scan') { assert.deepEqual(values, [2]); return [{ value: { status: 'scanned', enqueued: state.items.length } }]; }
        if (action === 'claim') { assert.deepEqual(values, [2, NONCE]); return [{ value: { status: 'claimed', leaseNonce: NONCE, items: state.items } }]; }
        if (action === 'finish') {
          assert.equal(values[1], NONCE); assert.ok(state.items.some(candidate => candidate.eventId === values[0]));
          const claimed = state.items.find(candidate => candidate.eventId === values[0]);
          const status = state.finishStatus ?? (values[2] === 'published' ? 'published' : claimed.attemptCount === 7 ? 'dead_letter' : 'retry_scheduled');
          return [{ value: { status, eventId: values[0], attemptCount: claimed.attemptCount } }];
        }
        assert.deepEqual(values, [EVENT]); return [{ value: state.consumeReceipt ?? consumedReceipt(state.consumeStatus) }];
      },
      async begin(work) { const value = await work(raw); events.push(`${action}:commit`); await state.beforeCommit?.(action); fail('commit'); return value; },
      async end() { events.push(`${action}:close`); await state.beforeClose?.(action); fail('close'); },
    };
    return raw;
  };
  const ports = {
    scan: params => scanPostgresCompleteTextPlatformEventsV402(params, factory),
    claim: params => claimPostgresCompleteTextPlatformEventsV402(params, factory),
    finish: params => finishPostgresCompleteTextPlatformPublishV402(params, factory),
    consume: params => consumePostgresCompleteTextPlatformEventV402(params, factory),
  };
  const publishInput = queue => ({ connectionString: connection(PUBLISHER), limit: 2, leaseNonce: NONCE, queue });
  const consumeInput = ack => ({ connectionString: connection(CONSUMER), message: { body: EVENT, ack } });
  return { state, events, calls, opens, ports, publishInput, consumeInput };
}

test('v402 publisher uses actual owned clients and sends UUID-only messages without claiming consumption', async () => {
  const f = fixture(), bodies = []; const queue = { async send(eventId) { assert.equal(this, queue); f.events.push('broker:accepted'); bodies.push(eventId); } };
  const result = await publishCompleteTextPlatformEventsV402(f.publishInput(queue), f.ports);
  assert.deepEqual(bodies, [EVENT]); assert.equal(typeof bodies[0], 'string');
  assert.deepEqual(f.events, ['scan:sql', 'scan:commit', 'scan:close', 'claim:sql', 'claim:commit', 'claim:close',
    'broker:accepted', 'finish:sql', 'finish:commit', 'finish:close']);
  assert.equal(result.publications[0].outcome, 'published'); assert.equal(result.publications[0].receipt.status, 'published');
  assert.equal(f.calls.some(call => call.action === 'consume'), false);
  assert.deepEqual(f.opens, [PUBLISHER, PUBLISHER, PUBLISHER]);
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.publications), true);
  assert.equal(Object.isFrozen(result.publications[0]), true); assert.equal(Object.isFrozen(result.claim.items[0]), true);
});

test('v402 broker acceptance and the publication SQL close remain awaited', async () => {
  const f = fixture(), enteredSend = deferred(), releaseSend = deferred(), enteredClose = deferred(), releaseClose = deferred();
  f.state.beforeClose = async action => { if (action === 'finish') { enteredClose.resolve(); await releaseClose.promise; } };
  let settled = false;
  const pending = publishCompleteTextPlatformEventsV402(f.publishInput({ async send() { enteredSend.resolve(); await releaseSend.promise; } }), f.ports);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await enteredSend.promise; await tick(); assert.equal(settled, false); assert.equal(f.calls.some(call => call.action === 'finish'), false);
  releaseSend.resolve(); await enteredClose.promise; await tick(); assert.equal(settled, false);
  releaseClose.resolve(); await pending; assert.equal(f.calls.filter(call => call.action === 'finish').length, 1);
});

test('v402 a failed broker publication schedules retry once and continues other claimed events', async () => {
  const f = fixture(); f.state.items = [item(EVENT), item(OTHER)]; const bodies = [];
  const result = await publishCompleteTextPlatformEventsV402(f.publishInput({ async send(eventId) {
    bodies.push(eventId); if (eventId === EVENT) throw new Error('fixture broker acceptance unknown');
  } }), f.ports);
  assert.deepEqual(bodies, [EVENT, OTHER]);
  assert.deepEqual(f.calls.filter(call => call.action === 'finish').map(call => call.values), [[EVENT, NONCE, 'failed'], [OTHER, NONCE, 'published']]);
  assert.deepEqual(result.publications.map(row => [row.eventId, row.outcome, row.receipt.status]),
    [[EVENT, 'failed', 'retry_scheduled'], [OTHER, 'published', 'published']]);
  assert.equal(f.calls.filter(call => call.action === 'claim').length, 1); assert.equal(f.calls.some(call => call.action === 'consume'), false);
});

test('v402 synchronous broker failure or a missing acknowledgement never becomes published', async () => {
  for (const send of [() => { throw new Error('fixture synchronous broker failure'); }, () => undefined]) {
    const f = fixture(); const result = await publishCompleteTextPlatformEventsV402(f.publishInput({ send }), f.ports);
    assert.equal(result.publications[0].outcome, 'failed'); assert.equal(result.publications[0].receipt.status, 'retry_scheduled');
    assert.deepEqual(f.calls.filter(call => call.action === 'finish').map(call => call.values), [[EVENT, NONCE, 'failed']]);
  }
});

test('v402 the seventh broker failure reports dead-letter and does not repeat the send', async () => {
  const f = fixture(); f.state.items = [item(EVENT, 7)]; let sent = 0;
  const result = await publishCompleteTextPlatformEventsV402(f.publishInput({ async send() { sent++; throw new Error('fixture broker unavailable'); } }), f.ports);
  assert.equal(sent, 1); assert.equal(result.publications[0].receipt.status, 'dead_letter');
  assert.equal(f.calls.filter(call => call.action === 'finish').length, 1);
});

test('v402 an empty claim sends nothing and creates no publication receipt', async () => {
  const f = fixture(); f.state.items = []; let sent = 0;
  const result = await publishCompleteTextPlatformEventsV402(f.publishInput({ async send() { sent++; } }), f.ports);
  assert.equal(sent, 0); assert.deepEqual(result.publications, []); assert.equal(f.calls.some(call => call.action === 'finish'), false);
});

for (const action of ['scan', 'claim', 'finish']) for (const phase of ['commit', 'close'])
test(`v402 ${action} ${phase} acknowledgement loss stops this publisher invocation without repeating work`, async () => {
  const f = fixture(); f.state.items = [item(EVENT), item(OTHER)]; const error = new Error(`fixture ${action} ${phase} unknown`);
  f.state.failure = { action, phase, error }; const bodies = [];
  await assert.rejects(() => publishCompleteTextPlatformEventsV402(f.publishInput({ async send(id) { bodies.push(id); } }), f.ports),
    phase === 'close' ? PostgresPlatformEventCleanupUnconfirmedV402 : observed => observed === error);
  assert.deepEqual(bodies, action === 'finish' ? [EVENT] : []);
  assert.equal(f.calls.filter(call => call.action === action).length, 1);
  if (action === 'scan') assert.equal(f.calls.some(call => call.action === 'claim'), false);
  assert.equal(f.events.at(-1), `${action}:close`);
});

test('v402 producer captures connection, lease, function ports and bound queue before the first await', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), bodies = [];
  f.state.beforeSQL = async action => { if (action === 'scan') { entered.resolve(); await release.promise; } };
  const queue = { async send(id) { assert.equal(this, queue); bodies.push(id); } }, input = f.publishInput(queue);
  const pending = publishCompleteTextPlatformEventsV402(input, f.ports); await entered.promise;
  const trap = () => { throw new Error('Mutated caller function must not run'); };
  Object.assign(input, { connectionString: 'changed', limit: 20, leaseNonce: OTHER, queue: { send: trap } });
  Object.assign(queue, { send: trap }); Object.assign(f.ports, { scan: trap, claim: trap, finish: trap });
  release.resolve(); const result = await pending; assert.deepEqual(bodies, [EVENT]); assert.equal(result.claim.leaseNonce, NONCE);
  assert.deepEqual(f.calls.filter(call => call.action === 'finish').map(call => call.values), [[EVENT, NONCE, 'published']]);
});

test('v402 every claimed event ID is validated before the first broker side effect', async () => {
  const f = fixture(); let sent = 0, finished = 0;
  const ports = { scan: async () => ({ status: 'scanned', enqueued: 2 }),
    claim: async () => ({ status: 'claimed', leaseNonce: NONCE, items: [item(EVENT), item('not-a-uuid')] }),
    finish: async () => { finished++; } };
  await assert.rejects(() => publishCompleteTextPlatformEventsV402(f.publishInput({ async send() { sent++; } }), ports));
  assert.equal(sent, 0); assert.equal(finished, 0);
});

for (const status of ['consumed', 'already_consumed']) test(`v402 ${status} commits and closes before acknowledging a queue message`, async () => {
  const f = fixture(); f.state.consumeStatus = status; let acked = 0;
  const input = f.consumeInput(function () { assert.equal(this, input.message); f.events.push('message:ack'); acked++; });
  const result = await consumeCompleteTextPlatformMessageV402(input, f.ports);
  assert.equal(result.status, status); assert.equal(result.consumedAt, TIME); assert.equal(acked, 1);
  assert.deepEqual(f.events, ['consume:sql', 'consume:commit', 'consume:close', 'message:ack']);
  assert.deepEqual(f.opens, [CONSUMER]); assert.equal(f.calls.length, 1);
});

for (const phase of ['sql', 'commit', 'close']) test(`v402 consumption ${phase} failure cannot ACK or automatically repeat`, async () => {
  const f = fixture(), error = new Error(`fixture consumption ${phase} unknown`); f.state.failure = { action: 'consume', phase, error };
  let acked = 0;
  await assert.rejects(() => consumeCompleteTextPlatformMessageV402(f.consumeInput(() => { acked++; }), f.ports),
    phase === 'close' ? PostgresPlatformEventCleanupUnconfirmedV402 : observed => observed === error);
  assert.equal(acked, 0); assert.equal(f.calls.length, 1); assert.equal(f.events.at(-1), 'consume:close');
});

test('v402 malformed actual consumption receipt never acknowledges the message', async () => {
  const f = fixture(); f.state.consumeReceipt = { ...consumedReceipt(), payloadSha256: 'invalid' }; let acked = 0;
  await assert.rejects(() => consumeCompleteTextPlatformMessageV402(f.consumeInput(() => { acked++; }), f.ports));
  assert.equal(acked, 0); assert.equal(f.events.at(-1), 'consume:close'); assert.equal(f.calls.length, 1);
});

test('v402 async message acknowledgement remains owned and acknowledgement failure does not re-consume', async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let settled = false;
  const pending = consumeCompleteTextPlatformMessageV402(f.consumeInput(async () => { entered.resolve(); await release.promise; }), f.ports);
  pending.then(() => { settled = true; }, () => { settled = true; });
  await entered.promise; await tick(); assert.equal(settled, false); assert.equal(f.events.at(-1), 'consume:close');
  release.resolve(); await pending; assert.equal(f.calls.length, 1);
  const duplicate = fixture(); duplicate.state.consumeStatus = 'already_consumed'; let acked = 0;
  const error = new Error('fixture message ACK unknown');
  await assert.rejects(() => consumeCompleteTextPlatformMessageV402(duplicate.consumeInput(async () => { acked++; throw error; }), duplicate.ports), observed => observed === error);
  assert.equal(acked, 1); assert.equal(duplicate.calls.length, 1);
});

test('v402 consumer captures event ID, connection, consume port and bound ACK before waiting for COMMIT', async () => {
  const f = fixture(), entered = deferred(), release = deferred(); let acked = 0;
  f.state.beforeCommit = async action => { if (action === 'consume') { entered.resolve(); await release.promise; } };
  const input = f.consumeInput(function () { assert.equal(this, message); acked++; }), message = input.message;
  const pending = consumeCompleteTextPlatformMessageV402(input, f.ports); await entered.promise;
  const trap = () => { throw new Error('Mutated message/port must not run'); };
  Object.assign(input, { connectionString: 'changed', message: { body: OTHER, ack: trap } });
  Object.assign(message, { body: OTHER, ack: trap }); Object.assign(f.ports, { consume: trap });
  release.resolve(); const result = await pending; assert.equal(result.eventId, EVENT); assert.equal(acked, 1);
  assert.deepEqual(f.calls, [{ action: 'consume', values: [EVENT] }]);
});

test('v402 consumer rejects unbound port receipts and object message bodies before ACK', async () => {
  const f = fixture(); let acked = 0, consumed = 0;
  for (const receipt of [{ ...consumedReceipt(), eventId: OTHER }, { ...consumedReceipt(), status: 'published' }]) {
    await assert.rejects(() => consumeCompleteTextPlatformMessageV402(f.consumeInput(() => { acked++; }), { consume: async () => { consumed++; return receipt; } }));
  }
  const input = f.consumeInput(() => { acked++; }); input.message.body = { eventId: EVENT };
  await assert.rejects(() => consumeCompleteTextPlatformMessageV402(input, { consume: async () => { consumed++; return consumedReceipt(); } }));
  assert.equal(acked, 0); assert.equal(consumed, 2);
});
