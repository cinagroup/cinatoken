import assert from 'node:assert/strict';
import test from 'node:test';
import { runSharedEarningScannerClient,
	runDedicatedSharedEarningScanner,
} from './postgres-shared-earning-scanner.ts';
import sharedEarningScannerWorker from './shared-earning-scanner-worker.ts';

const token = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const deliveryRole = 'cinatoken_gateway_shared_earning_delivery';
const consumerRole = 'cinatoken_gateway_shared_earning_consumer';
const authority = role => ({ current_role: role, session_role: role,
  transaction_timeout_ms: '30000', statement_timeout_ms: '15000',
  lock_timeout_ms: '5000', idle_transaction_timeout_ms: '10000' });
const wrap = raw => ({ driver: 'postgres', raw, drizzle: {} });

function fixture(options = {}) {
  const durable = { status: 'pending', attempts: 0, marker: false, credits: 0,
    leaseExpired: false, claims: 0, acks: 0, consumed: 0 };
  let deliveryTransactions = 0;
  let housekeepingMisses = options.housekeepingMisses ?? 0;
  const delivery = wrap({
    async begin(run) {
      const txNumber = ++deliveryTransactions;
      let touchedDueRow = false;
      const value = await run({ unsafe(query, params) {
        if (query === 'SET TRANSACTION READ ONLY') return Promise.resolve([]);
        if (query.startsWith('SELECT current_user AS current_role,'))
          return Promise.resolve([authority(options.deliveryRole ?? deliveryRole)]);
        if (query === 'SELECT * FROM cinatoken_economic_delivery.observe_backlog($1::integer)') {
          assert.deepEqual(params, [1000]);
          if (options.observationError) throw new Error('backlog query unavailable');
          return Promise.resolve(options.observationRows ?? [{
            out_observed_at: new Date('2030-01-01T00:00:00Z'), out_cap: 1000,
            out_pending_count: 1, out_pending_saturated: false,
            out_due_count: 1, out_due_saturated: false,
            out_leased_count: 0, out_leased_saturated: false,
            out_dead_letter_count: 0, out_dead_letter_saturated: false,
            out_oldest_pending_due_age_seconds: '0',
          }]);
        }
        if (query === 'SELECT * FROM cinatoken_economic_delivery.claim_events($1::integer,$2::integer)') {
          assert.deepEqual(params, [1, 300]);
          if (housekeepingMisses > 0) {
            housekeepingMisses--;
            touchedDueRow = true;
            return Promise.resolve([]);
          }
          if (durable.status === 'leased' && durable.leaseExpired && durable.marker) {
            durable.status = 'completed';
            touchedDueRow = true;
            return Promise.resolve([]);
          }
          if (durable.status !== 'pending' && !(durable.status === 'leased' && durable.leaseExpired))
            return Promise.resolve([]);
          durable.status = 'leased'; durable.attempts++; durable.claims++;
          durable.leaseExpired = false;
          return Promise.resolve([{ out_event_id: 'event-1', out_claim_token: token,
            out_attempt_count: durable.attempts,
            out_lease_until: new Date('2030-01-01T00:00:00Z') }]);
        }
        if (query === 'SELECT pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL AS touched_due_row')
          return Promise.resolve([{ touched_due_row: touchedDueRow }]);
        if (query === 'SELECT cinatoken_economic_delivery.ack_event($1::text,$2::uuid) AS disposition') {
          assert.deepEqual(params, ['event-1', token]);
          if (!durable.marker) throw new Error('consumer marker required');
          durable.acks++;
          durable.status = 'completed';
          return Promise.resolve([{ disposition: 'completed' }]);
        }
        throw new Error(`Unexpected delivery SQL: ${query}`);
      } });
      if (options.loseClaimCommit && txNumber === 1) throw new Error('claim COMMIT ACK lost');
      if (options.loseObservationCommit && txNumber === 1)
        throw new Error('backlog COMMIT ACK lost');
      if (options.loseAckCommit && txNumber === 2 && durable.acks === 1)
        throw new Error('ACK COMMIT response lost');
      return value;
    },
  });
  const consumer = wrap({
    async begin(run) {
      const value = await run({ unsafe(query, params) {
        if (query.startsWith('SELECT current_user AS current_role,'))
          return Promise.resolve([authority(options.consumerRole ?? consumerRole)]);
        if (query === 'SELECT * FROM cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)') {
          assert.deepEqual(params, ['event-1']);
          durable.consumed++;
          if (!durable.marker) { durable.marker = true; durable.credits++; }
          return Promise.resolve([{ out_event_id: 'event-1', out_decision: 'credited',
            out_credited_attempts: 1, out_pending_attempts: 0,
            out_net_micros: '5625000' }]);
        }
        throw new Error(`Unexpected consumer SQL: ${query}`);
      } });
      if (options.loseConsumerCommit) throw new Error('consumer COMMIT ACK lost');
      return value;
    },
  });
  const counters = { opened: 0, retired: 0 };
  const run = () => runSharedEarningScannerClient({
    deliveryClient: delivery,
    async openEarningClient() { counters.opened++; return consumer; },
    async retireConfirmedEarningClient(client) { assert.equal(client, consumer); counters.retired++; },
  });
  return { durable, counters, run, delivery, consumer };
}

test('dedicated scanner Worker exposes no HTTP financial action and defaults off', async () => {
  const response = sharedEarningScannerWorker.fetch();
  assert.equal(response.status,404);
  assert.equal(response.headers.get('cache-control'),'no-store');
  let scheduled;
  sharedEarningScannerWorker.scheduled({cron:'17 * * * *'}, {}, {
    waitUntil(value) { scheduled=value; },
  });
  assert.deepEqual(await scheduled,
    {claimed:0,completed:0,housekeeping:0,stopReason:'disabled'});
  await assert.rejects(runDedicatedSharedEarningScanner({cron:'17 * * * *'},
    { HYPERDRIVE:{connectionString:'postgresql://runtime:secret@db.local/gateway'} },
    () => { throw new Error('SQL opened with HTTP binding'); }),
  /HTTP or unknown authority/);
  await assert.rejects(runDedicatedSharedEarningScanner({cron:'17 * * * *'},
    { SHARED_EARNING_SCANNER_ENABLED:'reviewed-v1' },
    () => { throw new Error('SQL opened with old activation'); }),
  /Invalid dedicated/);
});

test('dedicated scanner composes only two financial origins and keeps lease/ACK flow', async () => {
  const f=fixture();
  const deliveryUrl='postgresql://delivery:secret@delivery.local/gateway?sslmode=disable';
  const consumerUrl='postgresql://consumer:secret@consumer.local/gateway?sslmode=disable';
  const opened=[];
  const closed=[];
  f.delivery.raw.end=async()=>{closed.push('delivery');};
  f.consumer.raw.end=async()=>{closed.push('consumer');};
  const createSql=(connectionString,options)=>{
    opened.push([connectionString,options.max]);
    if(connectionString===deliveryUrl)return f.delivery.raw;
    if(connectionString===consumerUrl)return f.consumer.raw;
    throw new Error('non-financial origin opened');
  };
  const env={SHARED_EARNING_SCANNER_ENABLED:'dedicated-v1',
    EARNING_DELIVERY_HYPERDRIVE:{connectionString:deliveryUrl},
    EARNING_CONSUMER_HYPERDRIVE:{connectionString:consumerUrl}};
  const logs=[];
  const originalLog=console.log;
  let result;
  try {
    console.log=value=>logs.push(JSON.parse(value));
    result=await runDedicatedSharedEarningScanner({cron:'17 * * * *'},env,createSql);
  } finally { console.log=originalLog; }
  assert.deepEqual(result,
    {claimed:1,completed:1,housekeeping:0,stopReason:'no_claim'});
  assert.deepEqual(logs.map(item=>item.event),
    ['gateway.shared_earning_scan.backlog','gateway.shared_earning_scan.completed']);
  assert.deepEqual(logs[0],{
    event:'gateway.shared_earning_scan.backlog',cron:'17 * * * *',
    observedAt:'2030-01-01T00:00:00.000Z',cap:1000,
    pending:1,pendingSaturated:false,due:1,dueSaturated:false,
    leased:0,leasedSaturated:false,deadLetter:0,deadLetterSaturated:false,
    oldestPendingDueAgeSeconds:'0',
  });
  assert.deepEqual(opened,[[deliveryUrl,1],[consumerUrl,1]]);
  assert.deepEqual(closed,['consumer','delivery']);
  assert.equal(f.durable.credits,1);
  for(const [name,bad,error] of [
    ['duplicate URL',{...env,EARNING_CONSUMER_HYPERDRIVE:{connectionString:deliveryUrl}},/must be distinct/],
    ['HTTP origin',{...env,HYPERDRIVE:{connectionString:'postgresql://runtime:secret@db.local/gateway'}},/HTTP or unknown authority/],
    ['URL override',{...env,EARNING_CONSUMER_HYPERDRIVE:{connectionString:consumerUrl+'&user=runtime'}},/Invalid EARNING_CONSUMER_HYPERDRIVE/],
  ]){
    await assert.rejects(runDedicatedSharedEarningScanner({cron:'17 * * * *'},bad,
      ()=>{throw new Error('SQL opened after invalid '+name);}),error,name);
  }
});

test('dedicated scanner requires a confirmed bounded backlog snapshot before claiming', async () => {
  const deliveryUrl='postgresql://delivery:secret@delivery.local/gateway?sslmode=disable';
  const consumerUrl='postgresql://consumer:secret@consumer.local/gateway?sslmode=disable';
  const env={SHARED_EARNING_SCANNER_ENABLED:'dedicated-v1',
    EARNING_DELIVERY_HYPERDRIVE:{connectionString:deliveryUrl},
    EARNING_CONSUMER_HYPERDRIVE:{connectionString:consumerUrl}};
  for(const [name,options,error] of [
    ['missing function',{observationError:true},/backlog query unavailable/],
    ['malformed response',{observationRows:[{out_cap:1000}]},/backlog observation differs/],
    ['lost observation COMMIT',{loseObservationCommit:true},/backlog COMMIT ACK lost/],
    ['wrong delivery role',{deliveryRole:'cinatoken_gateway_runtime'},/Dedicated PostgreSQL shared earning delivery LOGIN/],
  ]) {
    const f=fixture(options);
    f.delivery.raw.end=async()=>{};
    const createSql=(url)=>{
      if(url===deliveryUrl)return f.delivery.raw;
      throw new Error('Consumer opened after '+name);
    };
    await assert.rejects(runDedicatedSharedEarningScanner({cron:'17 * * * *'},env,createSql),error,name);
    assert.equal(f.durable.claims,0,name);
    assert.equal(f.durable.credits,0,name);
  }
});

test('durable scan claims one ID, consumes once, then marker-gated ACKs', async () => {
  const f = fixture();
  assert.deepEqual(await f.run(), { claimed: 1, completed: 1, housekeeping: 0, stopReason: 'no_claim' });
  assert.deepEqual(f.durable, { status: 'completed', attempts: 1, marker: true,
    credits: 1, leaseExpired: false, claims: 1, acks: 1, consumed: 1 });
  assert.deepEqual(f.counters, { opened: 1, retired: 1 });
  assert.deepEqual(await f.run(), { claimed: 0, completed: 0, housekeeping: 0, stopReason: 'no_claim' });
});

test('lost claim COMMIT response stops before consumer; restart after lease expiry credits once', async () => {
  const f = fixture({ loseClaimCommit: true });
  await assert.rejects(f.run(), /claim COMMIT ACK lost/);
  assert.equal(f.durable.claims, 1);
  assert.equal(f.durable.credits, 0);
  assert.deepEqual(f.counters, { opened: 0, retired: 0 });
  f.durable.leaseExpired = true;
  assert.deepEqual(await f.run(), { claimed: 1, completed: 1, housekeeping: 0, stopReason: 'no_claim' });
  assert.equal(f.durable.credits, 1);
});

test('lost consumer COMMIT response leaves marker for restart reconciliation, never double credits', async () => {
  const f = fixture({ loseConsumerCommit: true });
  await assert.rejects(f.run(), /consumer outcome unconfirmed/);
  assert.equal(f.durable.credits, 1);
  assert.equal(f.durable.acks, 0);
  assert.deepEqual(f.counters, { opened: 1, retired: 0 });
  f.durable.leaseExpired = true;
  assert.deepEqual(await f.run(), { claimed: 0, completed: 0, housekeeping: 1, stopReason: 'no_claim' });
  assert.equal(f.durable.status, 'completed');
  assert.equal(f.durable.credits, 1);
});

test('lost ACK response and restart leave one consumer marker and one credit', async () => {
  const f = fixture({ loseAckCommit: true });
  await assert.rejects(f.run(), /ACK COMMIT response lost/);
  assert.equal(f.durable.status, 'completed');
  assert.equal(f.durable.credits, 1);
  assert.equal(f.durable.acks, 1);
  assert.deepEqual(await f.run(), { claimed: 0, completed: 0, housekeeping: 0, stopReason: 'no_claim' });
  assert.equal(f.durable.credits, 1);
});

test('wrong delivery or consumer LOGIN cannot complete a financial event', async () => {
  const delivery = fixture({ deliveryRole: 'cinatoken_gateway_runtime' });
  await assert.rejects(delivery.run(), /Dedicated PostgreSQL shared earning delivery LOGIN/);
  assert.equal(delivery.durable.claims, 0);
  assert.equal(delivery.durable.credits, 0);
  const consumer = fixture({ consumerRole: 'cinatoken_gateway_runtime' });
  await assert.rejects(consumer.run(), /consumer outcome unconfirmed/);
  assert.equal(consumer.durable.claims, 1);
  assert.equal(consumer.durable.credits, 0);
  assert.equal(consumer.durable.acks, 0);
});

test('bounded admission never starts a claim after its monotonic budget', async () => {
  const f = fixture();
  const result = await runSharedEarningScannerClient({
    deliveryClient: wrap({ async begin() { throw new Error('SQL must remain unopened'); } }),
    async openEarningClient() { throw new Error('consumer must remain unopened'); },
    async retireConfirmedEarningClient() {},
  }, { maxItems: 1, admissionBudgetMs: 25, leaseSeconds: 30 },
  (() => { let calls = 0; return () => calls++ === 0 ? 0 : 25; })());
  assert.deepEqual(result, { claimed: 0, completed: 0, housekeeping: 0, stopReason: 'admission_budget' });
  assert.equal(f.durable.claims, 0);
});

test('housekeeping before a pending job continues in the same invocation', async () => {
  const f = fixture({ housekeepingMisses: 1 });
  assert.deepEqual(await f.run(),
    { claimed: 1, completed: 1, housekeeping: 1, stopReason: 'no_claim' });
  assert.equal(f.durable.credits, 1);
});

test('housekeeping rechecks are bounded without probing a true empty queue repeatedly', async () => {
  const f = fixture({ housekeepingMisses: 21 });
  assert.deepEqual(await f.run(),
    { claimed: 0, completed: 0, housekeeping: 20, stopReason: 'housekeeping_limit' });
  assert.equal(f.durable.claims, 0);
  const empty = fixture();
  empty.durable.status = 'completed';
  assert.deepEqual(await empty.run(),
    { claimed: 0, completed: 0, housekeeping: 0, stopReason: 'no_claim' });
});
