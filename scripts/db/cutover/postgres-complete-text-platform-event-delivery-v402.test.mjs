import assert from 'node:assert/strict';
import test from 'node:test';
import {
  scanPostgresCompleteTextPlatformEventsV402,
  claimPostgresCompleteTextPlatformEventsV402,
  finishPostgresCompleteTextPlatformPublishV402,
  consumePostgresCompleteTextPlatformEventV402,
  observePostgresCompleteTextPlatformEventV402,
  requeuePostgresCompleteTextPlatformEventV402,
  PostgresPlatformEventCleanupUnconfirmedV402,
} from './postgres-complete-text-platform-event-delivery-v402.mjs';

const PUBLISHER = 'cinatoken_gateway_complete_text_platform_event_publisher';
const CONSUMER = 'cinatoken_gateway_complete_text_platform_event_consumer';
const OPERATOR = 'cinatoken_gateway_migrator';
const EVENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NONCE = '33333333-3333-4333-8333-333333333333';
const TERMINAL = '44444444-4444-4444-8444-444444444444';
const TIME = '2026-09-27T00:00:30.000Z';
const SHA = 'a'.repeat(64);
const connection = role => `postgres://${role}:fixture-only-password@127.0.0.1:5432/fixture?sslmode=disable`;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const consumedFields = () => ({ eventId: EVENT, terminalId: TERMINAL, requestId: 'fixture-request',
  eventType: 'platform_text_no_fetch_closed', eventVersion: 1, payloadSha256: SHA, consumedAt: TIME });
const job = () => ({ status: 'published', attemptCount: 1, nextAttemptAt: TIME, leaseNonce: NONCE, leaseUntil: TIME });
const actions = [
  { name: 'scan', call: scanPostgresCompleteTextPlatformEventsV402, role: PUBLISHER, sql: 'scan_complete_text_platform_events_v402',
    input: () => ({ connectionString: connection(PUBLISHER), limit: 2 }), values: () => [2], receipt: () => ({ status: 'scanned', enqueued: 2 }) },
  { name: 'claim', call: claimPostgresCompleteTextPlatformEventsV402, role: PUBLISHER, sql: 'claim_complete_text_platform_events_v402',
    input: () => ({ connectionString: connection(PUBLISHER), limit: 2, leaseNonce: NONCE }), values: () => [2, NONCE],
    receipt: () => ({ status: 'claimed', leaseNonce: NONCE, items: [{ eventId: EVENT, attemptCount: 1, leaseUntil: TIME }] }) },
  { name: 'finish', call: finishPostgresCompleteTextPlatformPublishV402, role: PUBLISHER, sql: 'finish_complete_text_platform_publish_v402',
    input: () => ({ connectionString: connection(PUBLISHER), eventId: EVENT, leaseNonce: NONCE, outcome: 'published' }), values: () => [EVENT, NONCE, 'published'],
    receipt: () => ({ status: 'published', eventId: EVENT, attemptCount: 1 }) },
  { name: 'consume', call: consumePostgresCompleteTextPlatformEventV402, role: CONSUMER, sql: 'consume_complete_text_platform_event_v402',
    input: () => ({ connectionString: connection(CONSUMER), eventId: EVENT }), values: () => [EVENT],
    receipt: () => ({ status: 'consumed', ...consumedFields() }) },
  { name: 'observe', call: observePostgresCompleteTextPlatformEventV402, role: CONSUMER, sql: 'observe_complete_text_platform_event_v402',
    input: () => ({ connectionString: connection(CONSUMER), eventId: EVENT }), values: () => [EVENT],
    receipt: () => ({ status: 'pending', eventId: EVENT, receipt: null, job: job() }) },
  { name: 'requeue', call: requeuePostgresCompleteTextPlatformEventV402, role: OPERATOR, sql: 'requeue_complete_text_platform_event_v402',
    input: () => ({ connectionString: connection(OPERATOR), eventId: EVENT, reason: 'reviewed fixture recovery', operatorLogin: OPERATOR }),
    values: () => [EVENT, 'reviewed fixture recovery'], receipt: () => ({ status: 'requeued', eventId: EVENT, restoreCount: 1 }) },
];

/** SQL replies are doubles. The actual client validates arguments, role, receipt and owned transaction/close. */
function fixture(action, { receipt = action.receipt(), roles = {}, commitError, closeError, beforeAction, beforeCommit, beforeClose } = {}) {
  const events = [], calls = []; let opens = 0;
  const raw = {
    async unsafe(sql, values) {
      calls.push({ sql, values });
      if (sql.startsWith('SELECT current_user')) {
        events.push('roles');
        return [{ current_role: action.role, session_role: action.role, isolation: 'read committed', transaction_isolation: 'read committed',
          role_setting: 'none', role: 'none', replication_role: 'origin', session_replication_role: 'origin', ...roles }];
      }
      if (sql.startsWith('SET LOCAL ')) return [];
      assert.match(sql, new RegExp(`^SELECT cinatoken_gateway\\.${action.sql}\\(`));
      assert.deepEqual(values, action.values()); events.push('action'); await beforeAction?.();
      return [{ value: receipt }];
    },
    async begin(work) { events.push('begin'); const value = await work(raw); events.push('commit'); await beforeCommit?.(); if (commitError) throw commitError; return value; },
    async end() { events.push('close'); await beforeClose?.(); if (closeError) throw closeError; },
  };
  const factory = (url, options) => { opens++; assert.equal(url, connection(action.role)); assert.deepEqual(options, { max: 1 }); return raw; };
  return { factory, events, calls, opens: () => opens };
}

for (const action of actions) test(`v402 actual ${action.name} client binds exact SQL inputs and waits for COMMIT and close`, async () => {
  const enteredCommit = deferred(), releaseCommit = deferred(), enteredClose = deferred(), releaseClose = deferred();
  const f = fixture(action, { beforeCommit: async () => { enteredCommit.resolve(); await releaseCommit.promise; },
    beforeClose: async () => { enteredClose.resolve(); await releaseClose.promise; } });
  let settled = false;
  const pending = action.call(action.input(), f.factory); pending.then(() => { settled = true; }, () => { settled = true; });
  await enteredCommit.promise; await tick(); assert.equal(settled, false); assert.equal(f.events.includes('close'), false);
  releaseCommit.resolve(); await enteredClose.promise; await tick(); assert.equal(settled, false);
  releaseClose.resolve(); const result = await pending;
  for (const [key, value] of Object.entries(action.receipt())) assert.deepEqual(result[key], value);
  assert.equal(Object.isFrozen(result), true);
  if (action.name === 'claim') { assert.equal(Object.isFrozen(result.items), true); assert.equal(Object.isFrozen(result.items[0]), true); }
  assert.deepEqual(f.events, ['begin', 'roles', 'action', 'commit', 'close']); assert.equal(f.opens(), 1);
});

test('v402 clients reject poisoned connection URLs before constructing a SQL client', async () => {
  for (const action of actions) for (const url of [
    `https://${action.role}:pw@127.0.0.1/fixture`, `postgres://${action.role}@127.0.0.1/fixture`,
    'postgres://cinatoken_gateway_runtime:pw@127.0.0.1/fixture', `postgres://${action.role}:pw@127.0.0.1/`,
    `${connection(action.role)}&options=-c%20role%3Dcinatoken_gateway_migrator`, `${connection(action.role)}&sslmode=require`,
    `${connection(action.role)}#fragment`, ` ${connection(action.role)}`,
  ]) {
    let opened = false;
    await assert.rejects(() => action.call({ ...action.input(), connectionString: url }, () => { opened = true; throw new Error('Poisoned URL opened'); }));
    assert.equal(opened, false, `${action.name}: ${url}`);
  }
});

test('v402 invalid limits, identifiers, publish outcomes and operator reasons reject before SQL opens', async () => {
  const invalid = [
    ['scan', { limit: 0 }], ['scan', { limit: 21 }], ['scan', { limit: 1.5 }], ['claim', { leaseNonce: 'invalid' }],
    ['finish', { eventId: 'invalid' }], ['finish', { leaseNonce: 'invalid' }], ['finish', { outcome: 'consumed' }],
    ['consume', { eventId: 'invalid' }], ['observe', { eventId: 'invalid' }], ['requeue', { operatorLogin: CONSUMER }],
    ['requeue', { reason: '' }], ['requeue', { reason: ' padded' }], ['requeue', { reason: 'line\nbreak' }], ['requeue', { reason: 'x'.repeat(257) }],
  ];
  for (const [name, overrides] of invalid) {
    const action = actions.find(item => item.name === name); let opened = false;
    await assert.rejects(async () => action.call({ ...action.input(), ...overrides }, () => { opened = true; throw new Error('Invalid call opened'); }));
    assert.equal(opened, false, name);
  }
});

test('v402 clients reject wrong current/session LOGIN or transaction isolation and still await close', async () => {
  for (const roles of [{ current_role: OPERATOR }, { session_role: OPERATOR }, { isolation: 'repeatable read', transaction_isolation: 'repeatable read' }]) {
    const action = actions[0], f = fixture(action, { roles });
    await assert.rejects(() => action.call(action.input(), f.factory));
    assert.deepEqual(f.events, ['begin', 'roles', 'close']);
  }
});

for (const action of actions) test(`v402 actual ${action.name} client rejects malformed or caller-unbound receipts`, async () => {
  const original = action.receipt();
  const invalid = [null, [], { ...original, extra: true }, { ...original, status: 'unreviewed' }];
  if ('eventId' in original) invalid.push({ ...original, eventId: OTHER });
  if (action.name === 'scan') invalid.push({ status: 'scanned', enqueued: 3 }, { status: 'scanned', enqueued: 1.5 });
  if (action.name === 'claim') invalid.push({ ...original, leaseNonce: OTHER }, { ...original, items: [{ eventId: EVENT, attemptCount: 8, leaseUntil: TIME }] },
    { ...original, items: [{ eventId: EVENT, attemptCount: 1, leaseUntil: 'invalid' }] }, { ...original, items: [...original.items, ...original.items] },
    { ...original, items: Array.from({ length: 3 }, (_, i) => ({ eventId: `${i + 5}5555555-5555-4555-8555-555555555555`, attemptCount: 1, leaseUntil: TIME })) });
  if (action.name === 'consume') invalid.push({ ...original, eventType: 'buyer_debit' }, { ...original, eventVersion: 2 }, { ...original, payloadSha256: 'invalid' },
    { ...original, consumedAt: 'invalid' }, { ...original, terminalId: 'invalid' }, { ...original, requestId: '' });
  if (action.name === 'observe') invalid.push({ ...original, receipt: consumedFields() }, { ...original, job: { ...job(), attemptCount: 8 } },
    { ...original, job: { ...job(), leaseNonce: 'invalid' } }, { ...original, job: { ...job(), status: 'unreviewed' } },
    { ...original, job: { ...job(), leaseNonce: null, leaseUntil: null } }, { ...original, job: { ...job(), attemptCount: 0 } },
    { ...original, job: { ...job(), nextAttemptAt: '2026-09-27T00:01:00Z' } }, { ...original, job: { ...job(), status: 'pending' } },
    { ...original, job: { ...job(), status: 'dead_letter', attemptCount: 7 } },
    { status: 'consumed', eventId: EVENT, receipt: consumedFields(), job: job() });
  if (action.name === 'finish') invalid.push({ ...original, attemptCount: 8 }, { ...original, attemptCount: -1 }, { ...original, attemptCount: 0 },
    { ...original, status: 'retry_scheduled' }, { ...original, status: 'dead_letter', attemptCount: 7 });
  if (action.name === 'requeue') invalid.push({ ...original, restoreCount: 4 }, { ...original, restoreCount: 0 });
  for (const receipt of invalid) {
    const f = fixture(action, { receipt }); await assert.rejects(() => action.call(action.input(), f.factory), action.name);
    assert.equal(f.events.at(-1), 'close'); assert.equal(f.opens(), 1);
  }
});

test('v402 client receipt parsers accept reviewed duplicate, retry, dead-letter and missing states', async () => {
  const variants = [
    ['claim', { status: 'claimed', leaseNonce: NONCE, items: [] }],
    ...['published', 'retry_scheduled', 'dead_letter', 'already_consumed', 'lease_lost'].map(status => ['finish', { status, eventId: EVENT, attemptCount: status === 'dead_letter' ? 7 : 1 }]),
    ['consume', { status: 'already_consumed', ...consumedFields(), consumedAt: '2026-09-27T00:00:30+00:00' }],
    ['observe', { status: 'missing', eventId: EVENT, receipt: null, job: null }],
    ['observe', { status: 'consumed', eventId: EVENT, receipt: consumedFields(), job: null }],
    ['requeue', { status: 'already_consumed', eventId: EVENT, restoreCount: 0 }],
  ];
  for (const [name, receipt] of variants) {
    const action = actions.find(item => item.name === name);
    const input = action.input();
    if (name === 'finish' && ['retry_scheduled', 'dead_letter'].includes(receipt.status)) input.outcome = 'failed';
    const f = fixture(name === 'finish' ? { ...action, values: () => [EVENT, NONCE, input.outcome] } : action, { receipt });
    const result = await action.call(input, f.factory); assert.equal(result.status, receipt.status);
    assert.equal(f.opens(), 1); assert.equal(f.events.at(-1), 'close');
  }
});

test('v402 failed-publish receipts retain the retry limit and dead-letter boundary', async () => {
  const action = actions[2], input = { ...action.input(), outcome: 'failed' };
  for (const receipt of [{ status: 'published', eventId: EVENT, attemptCount: 1 },
    { status: 'retry_scheduled', eventId: EVENT, attemptCount: 7 }, { status: 'dead_letter', eventId: EVENT, attemptCount: 6 }]) {
    const f = fixture({ ...action, values: () => [EVENT, NONCE, 'failed'] }, { receipt });
    await assert.rejects(() => action.call(input, f.factory)); assert.equal(f.events.at(-1), 'close');
  }
});

for (const action of actions) test(`v402 actual ${action.name} COMMIT acknowledgement loss is not retried`, async () => {
  const failure = new Error('fixture COMMIT acknowledgement unknown'), f = fixture(action, { commitError: failure });
  await assert.rejects(() => action.call(action.input(), f.factory), error => error === failure);
  assert.deepEqual(f.events, ['begin', 'roles', 'action', 'commit', 'close']); assert.equal(f.opens(), 1);
});

test('v402 cleanup rejection preserves unknown close ownership even after a COMMIT error', async () => {
  for (const commitError of [undefined, new Error('fixture COMMIT unknown')]) {
    const action = actions[3], closeError = new Error('fixture close unknown'), f = fixture(action, { commitError, closeError });
    await assert.rejects(() => action.call(action.input(), f.factory), error => {
      assert.ok(error instanceof PostgresPlatformEventCleanupUnconfirmedV402);
      if (commitError) assert.deepEqual(error.cause.errors, [commitError, closeError]); else assert.equal(error.cause, closeError);
      return true;
    });
    assert.equal(f.events.at(-1), 'close'); assert.equal(f.opens(), 1);
  }
});

test('v402 actual client captures scalar inputs before a delayed SQL action', async () => {
  const action = actions[2], entered = deferred(), release = deferred(), input = action.input();
  const f = fixture(action, { beforeAction: async () => { entered.resolve(); await release.promise; } });
  const pending = action.call(input, f.factory); await entered.promise;
  Object.assign(input, { connectionString: 'changed', eventId: OTHER, leaseNonce: OTHER, outcome: 'failed' });
  release.resolve(); const result = await pending; assert.equal(result.eventId, EVENT); assert.equal(result.status, 'published');
  assert.equal(f.opens(), 1);
});

test('v402 observation reader supports both dedicated publisher and consumer LOGINs', async () => {
  for (const role of [PUBLISHER, CONSUMER]) {
    const action = { ...actions[4], role }, f = fixture(action);
    const result = await action.call({ ...action.input(), connectionString: connection(role) }, f.factory);
    assert.equal(result.status, 'pending'); assert.equal(f.opens(), 1);
  }
});
