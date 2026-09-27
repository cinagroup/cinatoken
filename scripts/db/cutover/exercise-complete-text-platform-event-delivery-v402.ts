import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { PostgresDatabaseClient } from '../../../packages/core/src/storage/database-client';
import { startJournalCommitAckDropProxyV381 } from '../../../packages/core/src/test-support/postgres-journal-commit-ack-proxy-v381.mjs';
import * as delivery from './postgres-complete-text-platform-event-delivery-v402.mjs';
import * as runners from './complete-text-platform-event-delivery-runner-v402.mjs';

type Sql = PostgresDatabaseClient['raw'];
type Item = { eventId: string; attemptCount: number; leaseUntil: string };
type Claim = { leaseNonce: string; items: Item[] };
type Params = {
 auditor: Sql; publisherConnectionString: string; consumerConnectionString: string; operatorConnectionString: string;
 /** Exact installed catalog equality, including guards, is required after every artificial time advance. */
 assertCatalog(): Promise<void>;
 stage(name: string, detail?: Record<string, unknown>): void;
 providerPostCount(): number;
 jobsGuardSignature: string;
};
const g = 'cinatoken_gateway', d = 'cinatoken_platform_delivery';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

/** Runs after all 143 frozen v400/v401 stages, using only their actual immutable
 * v388 events. The local queue stores UUIDs; it is not a Cloudflare broker. */
export async function exerciseCompleteTextPlatformEventDeliveryV402(p: Params) {
 const beforePosts = p.providerPostCount(); assert.equal(beforePosts, 15);
 const source = await p.auditor.unsafe(`SELECT event_id::text,terminal_id::text,request_id,payload_sha256
  FROM ${g}.complete_text_platform_outbox_v388 ORDER BY created_at,event_id`);
 // Five original closures plus the later actual v400 auth-reset closure.
 assert.equal(source.length, 6); const sourceIds = new Set(source.map(x => x.event_id));
 const financial = async () => {
  const [row] = await p.auditor.unsafe(`SELECT jsonb_build_object(
   'users',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM ${g}.users x),
   'keys',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM ${g}.api_keys x),
   'logs',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM ${g}.api_key_request_logs x),
   'ordinary',(SELECT jsonb_agg(to_jsonb(x) ORDER BY request_id) FROM ${g}.user_budget_reservations x),
   'guardrails',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM ${g}.guardrail_budget_reservations x),
   'windows',(SELECT jsonb_agg(to_jsonb(x) ORDER BY workspace_id,scope_type,scope_id,period,period_start) FROM ${g}.guardrail_budget_windows x),
   'quotes',(SELECT jsonb_agg(to_jsonb(x) ORDER BY quote_id) FROM ${g}.complete_text_quotes_v360 x),
   'grants',(SELECT jsonb_agg(to_jsonb(x) ORDER BY grant_id) FROM ${g}.complete_text_attempt_grants_v362 x),
   'starts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY send_start_id) FROM ${g}.complete_text_send_starts_v365 x),
   'facts',(SELECT jsonb_agg(to_jsonb(x) ORDER BY fact_id) FROM ${g}.complete_text_result_facts_v366 x),
   'resolutions',(SELECT jsonb_agg(to_jsonb(x) ORDER BY resolution_id) FROM ${g}.complete_text_no_fetch_resolutions_v370 x),
   'terminals',(SELECT jsonb_agg(to_jsonb(x) ORDER BY terminal_id) FROM ${g}.complete_text_platform_terminals_v388 x),
   'source',(SELECT jsonb_agg(to_jsonb(x) ORDER BY event_id) FROM ${g}.complete_text_platform_outbox_v388 x)
   ) AS value`);
  return row!.value;
 };
 const beforeFinancial = await financial();
 const publisher = p.publisherConnectionString, consumer = p.consumerConnectionString;
 let authorityDenials = 0;
 for (const connection of [publisher, consumer]) {
  const roleSql = postgres(connection, { max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
   idle_timeout: 0, max_lifetime: 0, backoff: false, onnotice() {} });
  try {
   for (const statement of [
    `SELECT api_key FROM ${g}.providers LIMIT 1`,
    `SELECT key_hash FROM ${g}.api_keys LIMIT 1`,
    `UPDATE ${g}.users SET budget_spent=budget_spent WHERE false`,
    `UPDATE ${d}.jobs_v402 SET attempt_count=attempt_count WHERE false`,
    `INSERT INTO ${d}.receipts_v402(event_id,projection_sha256,consumed_at,writer_xid) VALUES('${randomUUID()}','${'0'.repeat(64)}',now(),pg_current_xact_id())`,
    `SELECT ${g}.authenticate_personal_gateway_key_v395('untrusted')`,
    `SELECT ${g}.requeue_complete_text_platform_event_v402('${randomUUID()}','unauthorized restore')`,
   ]) {
    await assert.rejects(roleSql.unsafe(statement), (error: unknown) => (error as { code?: string }).code === '42501');
    authorityDenials++;
   }
  } finally { await roleSql.end({ timeout: 1 }); }
 }
 p.stage('v402-actual-publisher-consumer-LOGIN-denies-raw-secret-financial-receipt-and-unrelated-function-authority', { sqlstate: '42501', authorityDenials });
 const observe = (eventId: string) => delivery.observePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId });
 const claim = async (limit = 1): Promise<Claim> => {
  const leaseNonce = randomUUID();
  const result = await delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit, leaseNonce });
  assert.equal(result.status, 'claimed'); assert.equal(result.leaseNonce, leaseNonce);
  assert.ok(result.items.length <= limit);
  for (const item of result.items) { assert.ok(sourceIds.has(item.eventId)); assert.ok(item.attemptCount >= 1 && item.attemptCount <= 7); }
  return result;
 };
 const finish = (eventId: string, leaseNonce: string, outcome: 'published' | 'failed') =>
  delivery.finishPostgresCompleteTextPlatformPublishV402({ connectionString: publisher, eventId, leaseNonce, outcome });
 const counts = async () => {
  const [row] = await p.auditor.unsafe(`SELECT
   (SELECT count(*)::integer FROM ${d}.projections_v402) AS projections,
   (SELECT count(*)::integer FROM ${d}.receipts_v402) AS receipts,
   (SELECT count(*)::integer FROM ${d}.jobs_v402) AS jobs`); return row!;
 };
 const jobsImage = async () => {
  const [row] = await p.auditor.unsafe(`SELECT jsonb_agg(to_jsonb(j) ORDER BY event_id) AS value FROM ${d}.jobs_v402 j`);
  return row!.value;
 };
 const queueIds: string[] = []; let messageAcks = 0;
 const consumeMessage = (eventId: string) => runners.consumeCompleteTextPlatformMessageV402({ connectionString: consumer,
  message: { body: eventId, ack() { messageAcks++; } } });
 const queue = { async send(eventId: string) { assert.equal(typeof eventId, 'string'); assert.match(eventId, UUID); assert.ok(sourceIds.has(eventId)); queueIds.push(eventId); } };

 // Fault injection affects only mutable scheduling times in the NEW jobs table.
 // All triggers remain enabled. Guard and deferred companion get the same
 // narrow time-only branch; the companion is evaluated IMMEDIATE, both bodies
 // are restored before COMMIT, then the complete catalog is compared.
 let artificialAdvances = 0;
 const advance = async (eventId: string, field: 'next_attempt_at' | 'lease_until') => {
  const [job] = await p.auditor.unsafe(`SELECT status FROM ${d}.jobs_v402 WHERE event_id=$1`, [eventId]);
  assert.ok(job); assert.ok(field === 'lease_until' ? ['publishing', 'published'].includes(job!.status) : ['pending', 'published'].includes(job!.status));
  const contracts: { definition: string; patched: string }[] = [];
  for (const [signature, result] of [[p.jobsGuardSignature, 'NEW'], [`${d}.verify_companions_v402()`, 'NULL']]) {
   const [fn] = await p.auditor.unsafe(`SELECT pg_get_functiondef($1::regprocedure) AS definition,
    prosrc AS source FROM pg_proc WHERE oid=$1::regprocedure`, [signature!]);
   assert.ok(fn); const oldSource = String(fn!.source), definition = String(fn!.definition);
   const injection = `BEGIN\n IF TG_TABLE_SCHEMA='${d}' AND TG_TABLE_NAME='jobs_v402' AND TG_OP='UPDATE'
   AND SESSION_USER='cinatoken_gateway_migrator' AND CURRENT_USER='cinatoken_gateway_migrator'
   AND (to_jsonb(NEW)-ARRAY['next_attempt_at','lease_until']) IS NOT DISTINCT FROM (to_jsonb(OLD)-ARRAY['next_attempt_at','lease_until'])
   AND (NEW.next_attempt_at IS NOT DISTINCT FROM OLD.next_attempt_at OR NEW.next_attempt_at<clock_timestamp())
   AND (NEW.lease_until IS NOT DISTINCT FROM OLD.lease_until OR (NEW.lease_until IS NOT NULL AND NEW.lease_until<clock_timestamp()))
   AND ((NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at AND NEW.next_attempt_at<clock_timestamp())
     OR (NEW.lease_until IS DISTINCT FROM OLD.lease_until AND NEW.lease_until<clock_timestamp()))
  THEN RETURN ${result}; END IF;`;
   assert.match(oldSource, /\bBEGIN\b/iu); assert.equal(definition.split(oldSource).length, 2);
   contracts.push({ definition, patched: definition.replace(oldSource, oldSource.replace(/\bBEGIN\b/iu, injection)) });
  }
  try {
   await p.auditor.begin(async tx => {
    for (const contract of contracts) await tx.unsafe(contract.patched).simple();
    try {
     // Active jobs require next_attempt_at=lease_until. Move both to the same
     // single server timestamp while leaving a pending job's NULL lease alone.
     const changed = await tx.unsafe(`WITH at_time AS MATERIALIZED
      (SELECT clock_timestamp()-interval '1 second' AS value)
      UPDATE ${d}.jobs_v402 SET next_attempt_at=at_time.value,
       lease_until=CASE WHEN lease_until IS NULL THEN NULL ELSE at_time.value END
      FROM at_time WHERE event_id=$1 RETURNING event_id`, [eventId]); assert.equal(changed.length, 1);
     await tx.unsafe(`SET CONSTRAINTS ${d}.jobs_v402_companion IMMEDIATE`);
    } finally { for (const contract of [...contracts].reverse()) await tx.unsafe(contract.definition).simple(); }
   });
  } finally { await p.assertCatalog(); }
  artificialAdvances++;
 };
 const lostAck = async (connection: string, work: (connection: string) => Promise<unknown>) => {
  const url = new URL(connection);
  const proxyOptions = { upstreamHost: '127.0.0.1', upstreamPort: Number(url.port) };
  const proxy = await startJournalCommitAckDropProxyV381(proxyOptions);
  url.port = String(proxy.port);
  try {
   await assert.rejects(work(url.toString())); await proxy.waitForDrop();
   assert.equal(proxy.facts.commitCommands, 1); assert.equal(proxy.facts.backendCommitCompletes, 1);
   assert.equal(proxy.facts.droppedCommitAcks, 1); assert.equal(proxy.facts.connections, 1);
   return { ...proxy.facts };
  } finally { await proxy.close(); }
 };

 const firstId = String(source[0]!.event_id);
 const first = await delivery.consumePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId: firstId });
 assert.equal(first.status, 'consumed'); assert.equal(first.terminalId, source[0]!.terminal_id);
 assert.equal(first.payloadSha256, source[0]!.payload_sha256); assert.equal((await observe(firstId)).job, null);
 assert.deepEqual(await counts(), { projections: 1, receipts: 1, jobs: 0 });
 p.stage('v402-actual-consumer-before-scan-projects-real-v388-source-without-financial-write', { eventId: firstId });
 const firstObserved = await observe(firstId);
 for (const timezone of ['Asia/Singapore', 'America/New_York']) {
  // An actual postgres.js factory changes only fresh LOGIN TimeZone. SQL,
  // transaction/COMMIT/close and all receipt validation remain the real client.
  const nonUtcFactory = (connection: string) => postgres(connection, { max: 1, prepare: false, fetch_types: false,
   connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false, connection: { TimeZone: timezone }, onnotice() {} });
  const probe = nonUtcFactory(consumer);
  try { const [setting] = await probe.unsafe('SHOW TimeZone'); assert.equal(setting!.TimeZone, timezone); }
  finally { await probe.end({ timeout: 1 }); }
  const replay = await delivery.consumePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId: firstId }, nonUtcFactory);
  assert.deepEqual({ ...replay, status: 'consumed' }, first);
  const state = await delivery.observePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId: firstId }, nonUtcFactory);
  assert.deepEqual(state, firstObserved);
 }
 assert.deepEqual(await counts(), { projections: 1, receipts: 1, jobs: 0 });
 p.stage('v402-real-non-UTC-consumer-LOGIN-replay-and-observe-preserve-source-projection-hash-and-receipt', { timezones: ['Asia/Singapore', 'America/New_York'] });
 const scan = await delivery.scanPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 20 });
 assert.equal(scan.status, 'scanned'); assert.equal(scan.enqueued, 6);
 assert.equal((await delivery.scanPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 20 })).enqueued, 0);
 assert.equal((await observe(firstId)).job.status, 'delivered'); assert.equal((await observe(firstId)).job.attemptCount, 0);
 p.stage('v402-unwatermarked-scan-discovers-six-existing-events-idempotent-and-already-consumed-job');

 const beforeBad = await counts();
 for (const body of [randomUUID(), 'bad-event-id', { eventId: firstId }, { eventId: firstId, payload: source[0] }]) {
  let acks = 0;
  await assert.rejects(runners.consumeCompleteTextPlatformMessageV402({ connectionString: consumer, message: { body, ack() { acks++; } } }));
  assert.equal(acks, 0); assert.deepEqual(await counts(), beforeBad);
 }
 p.stage('v402-malformed-payload-and-unknown-ID-message-never-ACK-or-project');

 const uncertainNonce = randomUUID();
 const claimProxy = await lostAck(publisher, connectionString => delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString, limit: 1, leaseNonce: uncertainNonce }));
 const uncertain = await p.auditor.unsafe(`SELECT event_id::text FROM ${d}.jobs_v402 WHERE lease_nonce=$1`, [uncertainNonce]);
 assert.equal(uncertain.length, 1); const uncertainId = String(uncertain[0]!.event_id);
 assert.equal((await observe(uncertainId)).job.status, 'publishing'); assert.equal((await observe(uncertainId)).job.attemptCount, 1);
 const replayedClaim = await delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: uncertainNonce });
 assert.equal(replayedClaim.items.length, 1); assert.equal(replayedClaim.items[0].eventId, uncertainId); assert.equal(replayedClaim.items[0].attemptCount, 1);
 const beforeConflict = await jobsImage();
 await assert.rejects(delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 2, leaseNonce: uncertainNonce }),
  (error: unknown) => (error as { code?: string }).code === '22023');
 assert.deepEqual(await jobsImage(), beforeConflict); assert.equal(queueIds.length, 0);
 p.stage('v402-real-claim-COMMIT-response-loss-independent-job-read-no-queue-publication', { proxyFacts: claimProxy, queuedIds: queueIds.length });
 p.stage('v402-real-uncertain-claim-nonce-replay-same-live-ID-attempt-and-wrong-limit-22023-no-job-change');

 const published = await runners.publishCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: randomUUID(), queue });
 assert.equal(published.publications.length, 1); const publishedId = published.publications[0].eventId;
 assert.equal(published.publications[0].outcome, 'published'); assert.equal((await observe(publishedId)).status, 'pending');
 assert.equal((await observe(publishedId)).job.status, 'published'); assert.equal((await observe(publishedId)).receipt, null);
 p.stage('v402-actual-publisher-runner-UUID-only-queue-broker-ACK-is-not-consumption', { eventId: publishedId });

 let heldId = '';
 const consumeClaim = await p.auditor.begin(async tx => {
  const locked = await tx.unsafe(`SELECT event_id::text FROM ${d}.jobs_v402 WHERE status='pending' AND next_attempt_at<=clock_timestamp()
   ORDER BY next_attempt_at,event_id LIMIT 1 FOR UPDATE`);
  assert.equal(locked.length, 1); heldId = String(locked[0]!.event_id);
  const result = await claim(); assert.equal(result.items.length, 1); assert.notEqual(result.items[0]!.eventId, heldId);
  const [unchanged] = await tx.unsafe(`SELECT status,attempt_count FROM ${d}.jobs_v402 WHERE event_id=$1`, [heldId]);
  assert.deepEqual(unchanged, { status: 'pending', attempt_count: 0 }); return result;
 });
 p.stage('v402-actual-claim-SKIP-LOCKED-skips-owned-held-due-row-and-leases-another', { heldEventId: heldId, leasedEventId: consumeClaim.items[0]!.eventId });
 const consumeId = consumeClaim.items[0]!.eventId;
 let uncertainMessageAcks = 0;
 const consumerProxy = await lostAck(consumer, connectionString => runners.consumeCompleteTextPlatformMessageV402({ connectionString,
  message: { body: consumeId, ack() { uncertainMessageAcks++; } } }));
 assert.equal(uncertainMessageAcks, 0);
 const durable = await observe(consumeId); assert.equal(durable.status, 'consumed'); assert.ok(durable.receipt);
 const beforeReplayAcks = messageAcks; const replay = await consumeMessage(consumeId); assert.equal(messageAcks, beforeReplayAcks + 1);
 assert.equal(replay.status, 'already_consumed'); assert.deepEqual({ ...replay, status: 'consumed' }, durable.receipt ? { ...durable.receipt, status: 'consumed' } : null);
 assert.equal((await finish(consumeId, consumeClaim.leaseNonce, 'published')).status, 'already_consumed');
 assert.deepEqual((await delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: consumeClaim.leaseNonce })).items, []);
 p.stage('v402-real-consumer-runner-COMMIT-response-loss-no-ACK-new-LOGIN-replay-ACK-one-durable-projection-receipt',
  { eventId: consumeId, proxyFacts: consumerProxy, uncertainMessageAcks, replayMessageAcks: messageAcks - beforeReplayAcks });

 const [left, right] = await Promise.all([claim(), claim()]); assert.equal(left.items.length, 1); assert.equal(right.items.length, 1);
 assert.notEqual(left.items[0]!.eventId, right.items[0]!.eventId);
 const raceId = left.items[0]!.eventId;
 const [raced, publicationRace] = await Promise.all([Promise.all([delivery.consumePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId: raceId }),
  delivery.consumePostgresCompleteTextPlatformEventV402({ connectionString: consumer, eventId: raceId })]), finish(raceId, left.leaseNonce, 'published')]);
 assert.deepEqual(raced.map((x: { status: string }) => x.status).sort(), ['already_consumed', 'consumed']);
 assert.ok(['published', 'already_consumed'].includes(publicationRace.status)); assert.equal((await observe(raceId)).job.status, 'delivered');
 assert.equal((await finish(raceId, left.leaseNonce, 'published')).status, 'already_consumed');
 p.stage('v402-concurrent-real-publishers-distinct-leases-publish-finish-and-duplicate-consumers-one-receipt', { publicationRaceStatus: publicationRace.status });

 await advance(uncertainId, 'lease_until');
 const beforeExpiredReplay = await jobsImage();
 assert.deepEqual((await delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: uncertainNonce })).items, []);
 assert.deepEqual(await jobsImage(), beforeExpiredReplay);
 const reacquired = await claim();
 assert.equal(reacquired.items[0]!.eventId, uncertainId); assert.equal(reacquired.items[0]!.attemptCount, 2);
 await queue.send(uncertainId);
 const finishProxy = await lostAck(publisher, connectionString => delivery.finishPostgresCompleteTextPlatformPublishV402({ connectionString, eventId: uncertainId, leaseNonce: reacquired.leaseNonce, outcome: 'published' }));
 assert.equal((await observe(uncertainId)).job.status, 'published'); assert.equal((await observe(uncertainId)).status, 'pending');
 p.stage('v402-real-publish-finish-COMMIT-response-loss-independent-read-retains-pending-consumption', { eventId: uncertainId, proxyFacts: finishProxy });
 await advance(uncertainId, 'next_attempt_at');
 const redelivery = await runners.publishCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: randomUUID(), queue });
 assert.equal(redelivery.publications[0].eventId, uncertainId); assert.equal(redelivery.claim.items[0].attemptCount, 3);
 const consumed = await consumeMessage(uncertainId), consumedAgain = await consumeMessage(uncertainId);
 assert.equal(consumed.status, 'consumed'); assert.equal(consumedAgain.status, 'already_consumed');
 assert.equal(queueIds.filter(x => x === uncertainId).length, 2);
 const beforeConsumedReplay = await jobsImage();
 assert.deepEqual((await delivery.claimPostgresCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: uncertainNonce })).items, []);
 assert.deepEqual(await jobsImage(), beforeConsumedReplay);
 p.stage('v402-published-visibility-expiry-republishes-same-ID-consumer-duplicates-ACK-after-one-receipt');

 await advance(publishedId, 'next_attempt_at');
 const queueAckLost = await runners.publishCompleteTextPlatformEventsV402({ connectionString: publisher, limit: 1, leaseNonce: randomUUID(),
  queue: { async send(eventId: string) { await queue.send(eventId); throw new Error('Owned queue accepted ID but publication ACK was lost'); } } });
 assert.equal(queueAckLost.publications[0].eventId, publishedId); assert.equal(queueAckLost.publications[0].outcome, 'failed');
 assert.equal((await observe(publishedId)).job.status, 'pending'); assert.equal((await observe(publishedId)).receipt, null);
 assert.equal((await consumeMessage(publishedId)).status, 'consumed');
 assert.equal((await finish(publishedId, queueAckLost.claim.leaseNonce, 'failed')).status, 'already_consumed');
 p.stage('v402-broker-publication-ACK-loss-and-delayed-consumer-never-create-second-effect');

 const deadId = right.items[0]!.eventId; let active = right;
 const backoffs = [5, 15, 45, 135, 405, 1215];
 const exhaust = async (expireSeventh: boolean) => {
  for (let attempt = 1; attempt <= 7; attempt++) {
   assert.equal(active.items[0]!.eventId, deadId); assert.equal(active.items[0]!.attemptCount, attempt);
   if (expireSeventh && attempt === 7) {
    // One actual 30-second server lease expiry is proved without artificial
    // time advancement; the longer retry ladder above uses the bounded probe.
    const leaseUntil = Date.parse(active.items[0]!.leaseUntil), started = performance.now(); let actualServerNow = 0;
    while (actualServerNow < leaseUntil) {
     assert.ok(performance.now() - started <= 35000, 'real lease expiry must be observed within 35 seconds');
     const [clock] = await p.auditor.unsafe('SELECT clock_timestamp() AS now'); actualServerNow = new Date(clock!.now).getTime();
     if (actualServerNow < leaseUntil) await new Promise(resolve => setTimeout(resolve, Math.min(1000, leaseUntil - actualServerNow)));
    }
    const afterExpiry = await claim(); assert.equal(afterExpiry.items.length, 0);
    assert.equal((await observe(deadId)).job.status, 'dead_letter');
    p.stage('v402-real-server-thirty-second-seventh-lease-expiry-reaches-dead-letter-without-time-probe',
     { eventId: deadId, leaseUntil: active.items[0]!.leaseUntil, actualServerNow: new Date(actualServerNow).toISOString(), elapsedMs: Math.round(performance.now() - started) });
    assert.equal((await finish(deadId, active.leaseNonce, 'failed')).status, 'lease_lost'); break;
   }
   const [clock] = await p.auditor.unsafe('SELECT clock_timestamp() AS now');
   const result = await finish(deadId, active.leaseNonce, 'failed');
   assert.equal(result.status, attempt === 7 ? 'dead_letter' : 'retry_scheduled');
   assert.equal(result.attemptCount, attempt);
   if (attempt < 7) {
    const waiting = await observe(deadId); assert.equal(waiting.job.status, 'pending');
    const delay = Date.parse(waiting.job.nextAttemptAt) - Date.parse(String(clock!.now));
    assert.ok(delay >= backoffs[attempt - 1]! * 1000 && delay < backoffs[attempt - 1]! * 1000 + 5000);
    assert.equal((await claim()).items.length, 0, 'backoff prevents a premature publication lease');
    await advance(deadId, 'next_attempt_at'); active = await claim(); assert.equal(active.items.length, 1);
   }
  }
 };
 await exhaust(false);
 p.stage('v402-seven-real-failed-publications-finite-server-backoff-and-visible-dead-letter', { eventId: deadId, backoffSeconds: backoffs });
 for (let restore = 1; restore <= 3; restore++) {
  const restored = await delivery.requeuePostgresCompleteTextPlatformEventV402({ connectionString: p.operatorConnectionString,
   operatorLogin: 'cinatoken_gateway_migrator', eventId: deadId, reason: `Owned finite restoration ${restore}` });
  assert.equal(restored.status, 'requeued'); assert.equal(restored.restoreCount, restore); active = await claim();
  assert.equal(active.items.length, 1); await exhaust(restore === 3);
 }
 const beforeRestoreDenied = await observe(deadId);
 await assert.rejects(delivery.requeuePostgresCompleteTextPlatformEventV402({ connectionString: p.operatorConnectionString,
  operatorLogin: 'cinatoken_gateway_migrator', eventId: deadId, reason: 'Fourth restoration must be refused' }));
 assert.deepEqual(await observe(deadId), beforeRestoreDenied);
 p.stage('v402-three-reasoned-restores-bounded-history-fourth-refused-seventh-expired-lease-dead-letter');
 assert.equal((await consumeMessage(deadId)).status, 'consumed');
 const restoredConsumed = await delivery.requeuePostgresCompleteTextPlatformEventV402({ connectionString: p.operatorConnectionString,
  operatorLogin: 'cinatoken_gateway_migrator', eventId: deadId, reason: 'Late queued ID already consumed' });
 assert.equal(restoredConsumed.status, 'already_consumed');

 assert.deepEqual(await counts(), { projections: 6, receipts: 6, jobs: 6 });
 for (const row of source) {
  const state = await observe(String(row.event_id)); assert.equal(state.status, 'consumed'); assert.equal(state.job.status, 'delivered');
  assert.equal(state.receipt.terminalId, row.terminal_id); assert.equal(state.receipt.requestId, row.request_id);
  assert.equal(state.receipt.payloadSha256, row.payload_sha256); assert.equal(state.receipt.eventType, 'platform_text_no_fetch_closed'); assert.equal(state.receipt.eventVersion, 1);
 }
 assert.equal(p.providerPostCount(), beforePosts); assert.deepEqual(await financial(), beforeFinancial); await p.assertCatalog();
 p.stage('v402-all-six-real-source-events-delivered-one-projection-receipt-each-no-financial-or-Provider-write',
  { sourceEvents: 6, receipts: 6, projections: 6, providerPosts: beforePosts, addedPosts: 0, messageAcks, artificialSchedulingAdvances: artificialAdvances });
}
