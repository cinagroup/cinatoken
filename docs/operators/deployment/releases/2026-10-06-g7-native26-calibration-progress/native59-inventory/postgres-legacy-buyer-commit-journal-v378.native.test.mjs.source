// Owned PG18.6 contract test for the review-only durable buyer COMMIT journal.
// The terminal function below is a controlled v375-signature stub. The exact
// v375 financial reader is independently exercised by its v375/v376 fixtures.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import {
  recheckLegacyBuyerJournalOnceV378,
  runLegacyBuyerRecheckBatchV378,
  runLegacyBuyerJournaledWriteV378,
} from '../../../packages/core/src/db/postgres/legacy-buyer-commit-journal-v378.ts';

const sqlUrl = new URL('../../../packages/core/migrations-proposals/postgres/legacy-buyer-commit-journal-v378.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-legacy-buyer-commit-journal-v378-report.json', import.meta.url);
const sha = body => createHash('sha256').update(body).digest('hex');
const deadline = () => new Date(Date.now() + 3_600_000).toISOString();
const expectation = requestId => ({
  requestId, userId: 'buyer-v378', apiKeyId: 'key-v378',
  workspaceId: 'workspace-v378', chargeMicros: 1,
  inputTokens: 10, outputTokens: 5, cacheReadTokens: 0,
  cacheWriteTokens: 0, reason: 'v372_actual',
  outcomes: [{ attempt_id: randomUUID(), attempt_index: 1,
    shared_key_id: 'shared-v378', transition_id: 'transition-v378',
    quote_version_id: 'quote-v378', usage_certainty: 'actual',
    input_tokens: 10, output_tokens: 5, cache_read_tokens: 0,
    cache_write_tokens: 0, provider_cost_certainty: 'unknown',
    provider_cost_micros: null, evidence_kind: 'provider_usage',
    evidence_sha256: 'b'.repeat(64), observed_at: new Date().toISOString() }],
});
const intent = requestId => ({ intentId: randomUUID(),
  fullRequestSha256: 'a'.repeat(64), deadlineAt: deadline(),
  expectedFinancialFacts: expectation(requestId) });

function connection(cluster, name, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: name, password, ssl: false, max: 1, prepare: false,
    fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: false, onnotice() {},
    connection: { application_name: `v378-${label}` } });
}

async function rejected(work, code) {
  await assert.rejects(work, error => {
    assert.equal((error?.cause ?? error).code, code, String(error));
    return true;
  });
}

test('v378 journal persists before writer and bounds authenticated rechecks',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, stages: [], sourceSha256: {},
      limitations: [
        'Review-only proposal and direct TS caller; no production integration, formal migration, remote SQL, Worker, Provider, or production credential is changed.',
        'This fixture uses a controlled v375-signature stub to vary terminal observations. The exact v375 SQL reader and real v372 buyer transaction were proved by separate v375-v377 native fixtures; this fixture does not repeat that full integration.',
        'fullRequestSha256 is caller supplied and not compared with a database-bound complete request/response digest; financial_facts_confirmed is only the v375 checked financial subset.',
        'The journal cannot independently authenticate Provider billing or prove Guardrail, audit, stats, and unreserved window changes share the writer transaction.',
        'The fixture uses privileged local time warps and row locks to test long schedules and lease expiry without waiting 600 seconds.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name,
      result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator','journal','reader'].map(x =>
        [x, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_buyer_commit_journal LOGIN NOINHERIT
          PASSWORD '${passwords.journal}';
        CREATE ROLE cinatoken_gateway_buyer_terminal_reader LOGIN NOINHERIT
          PASSWORD '${passwords.reader}';
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'migrator');
      const journal = connection(cluster,
        'cinatoken_gateway_buyer_commit_journal', passwords.journal, 'journal');
      const secondJournal = connection(cluster,
        'cinatoken_gateway_buyer_commit_journal', passwords.journal, 'second-journal');
      const reader = connection(cluster,
        'cinatoken_gateway_buyer_terminal_reader', passwords.reader, 'reader');
      clients.push(migrator,journal,secondJournal,reader);
      const openJournal = async () => {
        const raw = connection(cluster,
          'cinatoken_gateway_buyer_commit_journal', passwords.journal,
          `fresh-journal-${clients.length}`);
        clients.push(raw);
        return { client: { driver: 'postgres', raw },
          close: () => raw.end({ timeout: 1 }) };
      };
      let readerOpens = 0;
      const readerBackendPids = [];
      const openReader = async () => {
        const raw = connection(cluster,
          'cinatoken_gateway_buyer_terminal_reader', passwords.reader,
          `fresh-reader-${readerOpens++}`);
        clients.push(raw);
        readerBackendPids.push((await raw.unsafe(`SELECT
          pg_catalog.pg_backend_pid() AS pid`))[0].pid);
        return { client: { driver: 'postgres', raw },
          close: () => raw.end({ timeout: 1 }) };
      };
      await migrator.unsafe(`CREATE SCHEMA cinatoken_gateway
          AUTHORIZATION cinatoken_gateway_migrator;
        CREATE SCHEMA cinatoken_economic_outbox
          AUTHORIZATION cinatoken_gateway_migrator;
        CREATE SCHEMA cinatoken_buyer_terminal
          AUTHORIZATION cinatoken_gateway_migrator;
        CREATE TABLE cinatoken_gateway.schema_migrations(version text PRIMARY KEY);
        CREATE TABLE cinatoken_buyer_terminal.probe_control(
          request_id text PRIMARY KEY,status text NOT NULL);
        REVOKE ALL ON SCHEMA cinatoken_gateway FROM PUBLIC;
        REVOKE ALL ON SCHEMA cinatoken_economic_outbox FROM PUBLIC;
        REVOKE ALL ON SCHEMA cinatoken_buyer_terminal FROM PUBLIC;
        CREATE FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
          p_request_id text,p_user_id text,p_api_key_id text,
          p_workspace_id text,p_charge_micros bigint,p_input_tokens bigint,
          p_output_tokens bigint,p_cache_read_tokens bigint,
          p_cache_write_tokens bigint,p_reason text,p_outcomes jsonb)
        RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER
        SET search_path TO pg_catalog,pg_temp AS $stub$
        DECLARE result text;
        BEGIN
          IF SESSION_USER<>'cinatoken_gateway_buyer_terminal_reader' THEN
            RAISE EXCEPTION 'terminal reader login required' USING ERRCODE='42501';
          END IF;
          SELECT c.status INTO result
            FROM cinatoken_buyer_terminal.probe_control c
            WHERE c.request_id=p_request_id;
          RETURN COALESCE(result,'unconfirmed');
        END;
        $stub$;
        REVOKE ALL ON FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
          text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)
          FROM PUBLIC;
        GRANT USAGE ON SCHEMA cinatoken_buyer_terminal
          TO cinatoken_gateway_buyer_terminal_reader;
        GRANT EXECUTE ON FUNCTION cinatoken_buyer_terminal.read_windowed_v375(
          text,text,text,text,bigint,bigint,bigint,bigint,bigint,text,jsonb)
          TO cinatoken_gateway_buyer_terminal_reader;`).simple();
      const source = await readFile(sqlUrl, 'utf8');
      report.sourceSha256['legacy-buyer-commit-journal-v378.sql'] = sha(source);
      report.sourceSha256['legacy-buyer-commit-journal-v378.ts'] = sha(await readFile(
        new URL('../../../packages/core/src/db/postgres/legacy-buyer-commit-journal-v378.ts',
          import.meta.url)));
      report.sourceSha256.fixture = sha(await readFile(new URL(import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(source).simple()), 'P0001');
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_commit_journal_v378_activation='reviewed-v1'`);
        await tx.unsafe(source).simple();
      });
      stage('default-off-install-preflight-and-pg18-schema');

      const prepare = async (client, item) => client.unsafe(`SELECT
        cinatoken_buyer_commit_journal.prepare_v378(
          $1::uuid,$2::text,$3::text,$4::jsonb,$5::timestamptz) AS pid`,
        [item.intentId,item.expectedFinancialFacts.requestId,
          item.fullRequestSha256,client.json(item.expectedFinancialFacts),
          item.deadlineAt]);
      const mark = async (client,id,outcome) => client.unsafe(`SELECT
        cinatoken_buyer_commit_journal.mark_write_v378(
          $1::uuid,$2::text) AS state`, [id,outcome]);
      const claim = client => client.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.claim_due_v378(30)`);
      const state = async id => (await migrator.unsafe(`SELECT state,
        probe_count,claim_count,
        write_ack_at IS NOT NULL AS caller_reported_ack,
        quarantine_reason,lease_token FROM
        cinatoken_buyer_commit_journal.intents_v378 WHERE intent_id=$1`,
        [id]))[0];
      const setStatus = async (requestId,status) => migrator.unsafe(`INSERT INTO
        cinatoken_buyer_terminal.probe_control(request_id,status)
        VALUES($1,$2) ON CONFLICT(request_id) DO UPDATE SET status=$2`,
        [requestId,status]);
      const dueNow = async id => migrator.unsafe(`UPDATE
        cinatoken_buyer_commit_journal.intents_v378
        SET next_probe_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE intent_id=$1 AND state='pending'`, [id]);
      const timeWarpImmutable = async (id,field,expression) => {
        assert.ok(['prepared_at','deadline_at'].includes(field));
        assert.ok(["pg_catalog.clock_timestamp()-INTERVAL '31 seconds'",
          "pg_catalog.clock_timestamp()-INTERVAL '1 second'"].includes(expression));
        await cluster.admin.unsafe(`ALTER TABLE
          cinatoken_buyer_commit_journal.intents_v378
          DISABLE TRIGGER keep_intent_v378;
          UPDATE cinatoken_buyer_commit_journal.intents_v378
          SET ${field}=${expression} WHERE intent_id='${id}';
          ALTER TABLE cinatoken_buyer_commit_journal.intents_v378
          ENABLE TRIGGER keep_intent_v378;`).simple();
      };

      await rejected(journal.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.intents_v378`), '42501');
      await rejected(journal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.apply_probe_v378(
          $1::uuid,$2::uuid,'confirmed',NULL)`,
        [randomUUID(),randomUUID()]), '42501');
      await rejected(journal.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`, [randomUUID(),randomUUID()]), '42501');
      await rejected(reader.unsafe(`SELECT
        cinatoken_buyer_commit_journal.mark_write_v378(
          $1::uuid,'acknowledged')`, [randomUUID()]), '42501');
      stage('journal-and-reader-logins-have-no-cross-authority-or-table-access');

      const invalid = intent('invalid-v378');
      invalid.expectedFinancialFacts.chargeMicros = null;
      await rejected(prepare(journal,invalid), '23514');
      const fraction = intent('fraction-v378');
      fraction.expectedFinancialFacts.chargeMicros = 1.5;
      await rejected(prepare(journal,fraction), '23514');
      const nestedFraction = intent('nested-fraction-v378');
      nestedFraction.expectedFinancialFacts.outcomes[0].input_tokens = 1.5;
      await rejected(prepare(journal,nestedFraction), '23514');
      const malformedOutcome = intent('malformed-outcome-v378');
      malformedOutcome.expectedFinancialFacts.outcomes = [null];
      await assert.rejects(prepare(journal,malformedOutcome));
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        cinatoken_buyer_commit_journal.intents_v378`))[0].n,0);
      stage('null-fractional-and-malformed-financial-facts-rejected-before-writer');

      const sameBackend = intent('same-backend-v378');
      await prepare(journal,sameBackend);
      const [selfVerify] = await journal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.verify_prepared_v378(
          $1::uuid,$2::text) AS committed`,
        [sameBackend.intentId,sameBackend.fullRequestSha256]);
      const [otherVerify] = await secondJournal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.verify_prepared_v378(
          $1::uuid,$2::text) AS committed`,
        [sameBackend.intentId,sameBackend.fullRequestSha256]);
      assert.equal(selfVerify.committed,false);
      assert.equal(otherVerify.committed,true);
      await rejected(migrator.unsafe(`UPDATE
        cinatoken_buyer_commit_journal.intents_v378
        SET expected_financial_facts='{}'::jsonb WHERE intent_id=$1`,
        [sameBackend.intentId]), '23514');
      await rejected(prepare(journal,sameBackend), '23505');
      // Isolate this verification-only row from the global due queue.
      await migrator.unsafe(`UPDATE cinatoken_buyer_commit_journal.intents_v378
        SET state='quarantined',quarantined_at=pg_catalog.clock_timestamp(),
          quarantine_reason='deadline'
        WHERE intent_id=$1`,[sameBackend.intentId]);
      stage('second-backend-commit-visibility-and-immutable-intent');

      const acked = intent('acked-v378');
      let writerCalls = 0;
      const ackObservation = await runLegacyBuyerJournaledWriteV378(
        acked,openJournal,async () => { writerCalls++; },'review-only');
      assert.equal(ackObservation.kind,'write_acknowledged');
      assert.equal(writerCalls,1);
      assert.equal((await state(acked.intentId)).state,'pending');
      assert.equal((await state(acked.intentId)).caller_reported_ack,true);
      const ackProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.deepEqual([ackProbe.kind,ackProbe.intentId,ackProbe.financialFacts,
        ackProbe.journalState],['probed',acked.intentId,'unconfirmed','pending']);
      await setStatus(acked.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(acked.intentId);
      const ackConfirmed = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.deepEqual([ackConfirmed.kind,ackConfirmed.journalState],
        ['probed','financial_facts_confirmed']);
      assert.equal(writerCalls,1);
      stage('caller-reported-ack-remains-due-and-reader-login-uses-v375-stub');

      const rejectedUndefined = intent('reject-undefined-v378');
      const undefinedObservation = await runLegacyBuyerJournaledWriteV378(
        rejectedUndefined,openJournal,async () => {
          writerCalls++; return Promise.reject(undefined);
        },'review-only');
      assert.equal(undefinedObservation.kind,'write_unacknowledged');
      assert.equal(undefinedObservation.writeError,undefined);
      assert.equal((await state(rejectedUndefined.intentId)).state,'pending');
      const undefinedProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.equal(undefinedProbe.financialFacts,'unconfirmed');
      assert.equal(writerCalls,2);
      await setStatus(rejectedUndefined.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(rejectedUndefined.intentId);
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).journalState,
        'financial_facts_confirmed');
      stage('undefined-rejection-is-uncertain-and-never-replays-writer');

      const falseAck = intent('false-ack-v378');
      await prepare(journal,falseAck);
      assert.equal((await mark(journal,falseAck.intentId,'acknowledged'))[0].state,
        'pending');
      const falseAckProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.equal(falseAckProbe.financialFacts,'unconfirmed');
      assert.equal((await state(falseAck.intentId)).caller_reported_ack,true);
      await setStatus(falseAck.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(falseAck.intentId);
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).journalState,
        'financial_facts_confirmed');
      stage('false-ack-cannot-suppress-recheck');

      const crashed = intent('crashed-prepared-v378');
      await prepare(journal,crashed);
      await timeWarpImmutable(crashed.intentId,'prepared_at',
        "pg_catalog.clock_timestamp()-INTERVAL '31 seconds'");
      const staleProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.equal(staleProbe.intentId,crashed.intentId);
      assert.equal(staleProbe.financialFacts,'unconfirmed');
      assert.equal(writerCalls,2);
      await setStatus(crashed.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(crashed.intentId);
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).journalState,
        'financial_facts_confirmed');
      stage('stale-prepared-is-swept-without-any-writer-call');

      const lostPrepareResponse = intent('lost-prepare-response-v378');
      let firstPrepare=true;
      const openWithLostPrepareResponse = async () => {
        const session=await openJournal();
        if (!firstPrepare) return session;
        firstPrepare=false;
        const actual=session.client.raw;
        return { ...session, client: { driver:'postgres',
          raw: { json: value => actual.json(value),
            unsafe: async (...args) => {
              const rows=await actual.unsafe(...args);
              if (String(args[0]).includes('prepare_v378')) {
                throw new Error('simulated prepare response loss');
              }
              return rows;
            } } } };
      };
      await assert.rejects(runLegacyBuyerJournaledWriteV378(
        lostPrepareResponse,openWithLostPrepareResponse,
        async () => { writerCalls++; },'review-only'),
        /simulated prepare response loss/u);
      assert.equal(writerCalls,2);
      const [visibleAfterLostResponse] = await secondJournal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.verify_prepared_v378(
          $1::uuid,$2::text) AS committed`,
        [lostPrepareResponse.intentId,lostPrepareResponse.fullRequestSha256]);
      assert.equal(visibleAfterLostResponse.committed,true);
      await timeWarpImmutable(lostPrepareResponse.intentId,'prepared_at',
        "pg_catalog.clock_timestamp()-INTERVAL '31 seconds'");
      const recoveredAfterLostResponse = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.equal(recoveredAfterLostResponse.intentId,lostPrepareResponse.intentId);
      assert.equal(recoveredAfterLostResponse.financialFacts,'unconfirmed');
      await setStatus(lostPrepareResponse.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(lostPrepareResponse.intentId);
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).journalState,
        'financial_facts_confirmed');
      stage('synthetic-lost-prepare-response-keeps-committed-intent-and-skips-writer');

      const competing = intent('competing-v378');
      await prepare(journal,competing);
      await mark(journal,competing.intentId,'uncertain');
      const [first,second] = await Promise.all([claim(journal),claim(secondJournal)]);
      assert.equal(first.length+second.length,1);
      const held = (first[0] ?? second[0]);
      await migrator.unsafe(`UPDATE cinatoken_buyer_commit_journal.intents_v378
        SET lease_until=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE intent_id=$1`, [competing.intentId]);
      const [reclaimed] = await claim(secondJournal);
      assert.equal(reclaimed.intent_id,competing.intentId);
      assert.notEqual(reclaimed.lease_token,held.lease_token);
      assert.equal((await reader.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`,[competing.intentId,held.lease_token])).length,0);
      await setStatus(competing.expectedFinancialFacts.requestId,'confirmed');
      const [completion] = await reader.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`,[competing.intentId,reclaimed.lease_token]);
      assert.equal(completion.journal_state,'financial_facts_confirmed');
      stage('one-lease-at-a-time-expiry-reclaim-and-stale-token-rejection');

      const lostCompletionResponse = intent('lost-completion-response-v378');
      await prepare(journal,lostCompletionResponse);
      await mark(journal,lostCompletionResponse.intentId,'uncertain');
      await setStatus(lostCompletionResponse.expectedFinancialFacts.requestId,
        'confirmed');
      const [completionClaim] = await claim(journal);
      assert.equal(completionClaim.intent_id,lostCompletionResponse.intentId);
      // Deliberately discard the committed completion response.
      await reader.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`,
        [lostCompletionResponse.intentId,completionClaim.lease_token]);
      assert.equal((await reader.unsafe(`SELECT * FROM
        cinatoken_buyer_commit_journal.complete_from_reader_v378(
          $1::uuid,$2::uuid)`,
        [lostCompletionResponse.intentId,completionClaim.lease_token])).length,0);
      const [completionRows] = await migrator.unsafe(`SELECT count(*)::int AS n
        FROM cinatoken_buyer_commit_journal.probes_v378
        WHERE intent_id=$1`,[lostCompletionResponse.intentId]);
      assert.equal(completionRows.n,1);
      assert.equal((await state(lostCompletionResponse.intentId)).state,
        'financial_facts_confirmed');
      stage('discarded-completion-response-cannot-repeat-terminal-probe');

      const errors = intent('reader-error-v378');
      await prepare(journal,errors);
      await mark(journal,errors.intentId,'uncertain');
      const errorProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,async () => { throw new Error('simulated reader outage'); },
        'review-only');
      assert.deepEqual([errorProbe.financialFacts,errorProbe.journalState],
        ['reader_error','pending']);
      await setStatus(errors.expectedFinancialFacts.requestId,'confirmed');
      await dueNow(errors.intentId);
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).journalState,
        'financial_facts_confirmed');
      stage('reader-error-stays-pending-until-authenticated-later-read');

      const exhausted = intent('exhausted-v378');
      await prepare(journal,exhausted);
      await mark(journal,exhausted.intentId,'uncertain');
      for (let n=1;n<=7;n++) {
        if (n>1) await dueNow(exhausted.intentId);
        const result = await recheckLegacyBuyerJournalOnceV378(
          openJournal,openReader,'review-only');
        assert.equal(result.intentId,exhausted.intentId);
        assert.equal(result.probeNumber,n);
        assert.equal(result.financialFacts,'unconfirmed');
        assert.equal(result.journalState,n===7 ? 'quarantined' : 'pending');
      }
      const exhaustedState = await state(exhausted.intentId);
      assert.equal(exhaustedState.probe_count,7);
      assert.equal(exhaustedState.quarantine_reason,'probe_exhausted');
      const exhaustedProbes = await migrator.unsafe(`SELECT probe_number,
        observation,lease_generation FROM
        cinatoken_buyer_commit_journal.probes_v378
        WHERE intent_id=$1 ORDER BY probe_number`,[exhausted.intentId]);
      assert.deepEqual(exhaustedProbes.map(p => p.probe_number),
        [1,2,3,4,5,6,7]);
      assert.ok(exhaustedProbes.every(p => p.observation==='unconfirmed'));
      report.exhaustedProbes=exhaustedProbes;
      stage('seven-unconfirmed-probes-end-in-durable-operator-quarantine');

      const abandonedLeases = intent('abandoned-leases-v378');
      await prepare(journal,abandonedLeases);
      await mark(journal,abandonedLeases.intentId,'uncertain');
      for (let n=1;n<=7;n++) {
        if (n>1) await migrator.unsafe(`UPDATE
          cinatoken_buyer_commit_journal.intents_v378 SET
          lease_until=pg_catalog.clock_timestamp()-INTERVAL '1 second'
          WHERE intent_id=$1`,[abandonedLeases.intentId]);
        const [abandoned] = await claim(journal);
        assert.equal(abandoned.intent_id,abandonedLeases.intentId);
        assert.equal(abandoned.probe_number,n);
      }
      await migrator.unsafe(`UPDATE
        cinatoken_buyer_commit_journal.intents_v378 SET
        lease_until=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE intent_id=$1`,[abandonedLeases.intentId]);
      assert.equal((await claim(journal)).length,0);
      assert.deepEqual([(await state(abandonedLeases.intentId)).claim_count,
        (await state(abandonedLeases.intentId)).probe_count,
        (await state(abandonedLeases.intentId)).quarantine_reason],
        [7,0,'probe_exhausted']);
      stage('seven-abandoned-leases-bound-total-reader-opportunities');

      const conflicted = intent('conflict-v378');
      await prepare(journal,conflicted);
      await mark(journal,conflicted.intentId,'uncertain');
      await setStatus(conflicted.expectedFinancialFacts.requestId,'conflict');
      const conflictProbe = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.deepEqual([conflictProbe.financialFacts,conflictProbe.journalState],
        ['conflict','quarantined']);
      assert.equal((await state(conflicted.intentId)).quarantine_reason,'conflict');
      stage('conflict-quarantines-immediately');

      const expired = intent('expired-v378');
      await prepare(journal,expired);
      await timeWarpImmutable(expired.intentId,'prepared_at',
        "pg_catalog.clock_timestamp()-INTERVAL '31 seconds'");
      await timeWarpImmutable(expired.intentId,'deadline_at',
        "pg_catalog.clock_timestamp()-INTERVAL '1 second'");
      assert.equal((await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only')).kind,'no_due_entry');
      assert.equal((await state(expired.intentId)).quarantine_reason,'deadline');
      stage('deadline-quarantines-unattended-prepared-intent');

      const lockExpiry = intent('lock-expiry-v378');
      await prepare(journal,lockExpiry);
      await mark(journal,lockExpiry.intentId,'uncertain');
      const [lockedClaim] = await claim(journal);
      assert.equal(lockedClaim.intent_id,lockExpiry.intentId);
      const holder = cluster.client('v378-row-lock');
      const holderPid = (await holder.unsafe(`SELECT
        pg_catalog.pg_backend_pid() AS pid`))[0].pid;
      const blockedPid = (await secondJournal.unsafe(`SELECT
        pg_catalog.pg_backend_pid() AS pid`))[0].pid;
      let release;
      const released = new Promise(resolve => { release=resolve; });
      let locked;
      const lockedReady = new Promise(resolve => { locked=resolve; });
      const holding = holder.begin(async tx => {
        await tx.unsafe(`UPDATE cinatoken_buyer_commit_journal.intents_v378
          SET lease_until=pg_catalog.clock_timestamp()+INTERVAL '150 milliseconds'
          WHERE intent_id=$1`,[lockExpiry.intentId]);
        locked();
        await released;
      });
      await lockedReady;
      const delayedCompletion = secondJournal.unsafe(`SELECT
        cinatoken_buyer_commit_journal.record_reader_error_v378(
          $1::uuid,$2::uuid,'reader_error') AS state`,
        [lockExpiry.intentId,lockedClaim.lease_token]).then(rows => rows);
      try {
        let observedBlock=false;
        for (let n=0;n<100;n++) {
          const [blocking] = await cluster.admin.unsafe(`SELECT
            pg_catalog.pg_blocking_pids($1) AS pids`,[blockedPid]);
          if (blocking.pids.includes(holderPid)) { observedBlock=true; break; }
          await new Promise(resolve => setTimeout(resolve,10));
        }
        assert.equal(observedBlock,true);
        await new Promise(resolve => setTimeout(resolve,250));
      } finally { release(); }
      await holding;
      assert.equal((await delayedCompletion)[0].state,null);
      assert.equal((await state(lockExpiry.intentId)).state,'leased');
      await setStatus(lockExpiry.expectedFinancialFacts.requestId,'confirmed');
      const reclaimedAfterLock = await recheckLegacyBuyerJournalOnceV378(
        openJournal,openReader,'review-only');
      assert.equal(reclaimedAfterLock.journalState,'financial_facts_confirmed');
      stage('post-lock-clock-rejects-expired-lease-completion');

      assert.deepEqual(await runLegacyBuyerRecheckBatchV378(
        openJournal,openReader,3,'review-only'),[]);
      await assert.rejects(runLegacyBuyerRecheckBatchV378(
        openJournal,openReader,33,'review-only'),TypeError);
      stage('batch-runner-stops-when-no-entry-is-due-and-rejects-unbounded-work');

      report.readerBackendPids=readerBackendPids;
      assert.ok(readerBackendPids.length>=13);

      report.status='PASS';
    } catch (error) {
      failure=error;
      report.status='FAIL';
      report.failedAfterStage=report.stages.at(-1)?.name ?? null;
      const cause=error?.cause ?? error;
      report.failure={ code:cause?.code ?? null,
        message:String(error?.stack ?? error).slice(0,5000) };
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup='PASS'; }
      catch (error) { report.cleanup='FAIL';
        report.cleanupError=String(error).slice(0,1500);
        failure ??= error; }
      await writeFile(reportUrl,JSON.stringify(report,null,2)+'\n');
      process.stdout.write(`legacy-buyer-commit-journal-v378-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
  });
