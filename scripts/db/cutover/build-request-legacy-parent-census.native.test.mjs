// Opt-in, owned PostgreSQL 18 fixture. It proves why formal 0069 history
// cannot be silently adopted as a trusted V1 request parent.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildRequestLegacyParentCensus } from './build-request-legacy-parent-census.mjs';

const schema = 'cinatoken_gateway';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
];
const parentProposal = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url);
const digest = input => createHash('sha256').update(input).digest('hex');
const errorSummary = error => ({ code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 350) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function client(cluster, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {} });
}

async function readPage(sql, cursor, limit) {
  const review = buildRequestLegacyParentCensus({ cursor, limit });
  return sql.begin(async tx => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').simple();
    await tx.unsafe(review.preflightSql).simple();
    return tx.unsafe(review.pageSql);
  });
}

test('formal 0069 old intent history has no trustworthy V1 parent backfill',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-legacy-parent-census-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; 73 formal migrations; synthetic legacy intent history; read-only census',
      limitations: [
        'The census is diagnostic. Pages can miss concurrent inserts, so activation needs a locked recensus.',
        'No request digest, original total attempt budget or original request deadline can be reconstructed from 0069 rows.',
        'No parent variant, replay registry, retention policy, production grant, remote database or Worker is activated.',
      ], stages: [], sourceSha256: {} };
    const stages = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const [server] = await cluster.admin.unsafe(`SELECT current_setting('server_version_num')::integer AS version,
        current_setting('listen_addresses') AS address`);
      assert.ok(server.version >= 180000 && server.version < 190000);
      assert.equal(server.address, '127.0.0.1');
      report.serverVersionNum = server.version;
      for (const [name, url] of [
        ['generator', new URL('./build-request-legacy-parent-census.mjs', import.meta.url)],
        ['test', new URL(import.meta.url)], ['parentProposal', parentProposal],
      ]) report.sourceSha256[name] = digest(await readFile(url));

      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const sql = client(cluster, password); clients.push(sql);
      await sql.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrationDir), 'utf8');
        corpus.push(`${name}\n${body}`);
        await sql.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      const [intentShape] = await sql.unsafe(`SELECT
        count(*) FILTER (WHERE column_name='request_sha256')::integer AS request_hash_columns,
        count(*) FILTER (WHERE column_name='max_attempts')::integer AS request_budget_columns,
        count(*) FILTER (WHERE column_name='original_created_at_ms')::integer AS original_time_columns
        FROM information_schema.columns WHERE table_schema='${schema}' AND table_name='request_dispatch_intents'`);
      assert.deepEqual(intentShape, { request_hash_columns: 0, request_budget_columns: 0, original_time_columns: 0 });
      stages('formal-0069-column-provenance', { migrations: files.length, intentShape });

      await sql.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('legacy-parent-user','legacy-parent-native@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('legacy-parent-space','personal','legacy-parent-user','Legacy Parent','legacy-parent','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('legacy-parent-key','legacy-parent-native-key','legacy-parent-user','legacy-parent-space');`).simple();
      const expiry = Date.now() + 1_200;
      await sql.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('legacy-a',1,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations',$1,$2)`, ['a'.repeat(64), expiry]);
      const claimId = '11111111-1111-4111-8111-111111111111';
      const [claimed] = await sql.unsafe(`UPDATE ${schema}.request_dispatch_intents
        SET state='dispatch_claimed',revision=revision+1,dispatch_claim_id=$1
        WHERE request_id='legacy-a' AND attempt_index=1 RETURNING state`, [claimId]);
      assert.equal(claimed.state, 'dispatch_claimed');
      await sleep(Math.max(0, expiry - Date.now() + 50));
      const [unknown] = await sql.unsafe(`UPDATE ${schema}.request_dispatch_intents
        SET state='outcome_unknown',revision=revision+1
        WHERE request_id='legacy-a' AND attempt_index=1 RETURNING state`);
      assert.equal(unknown.state, 'outcome_unknown');
      await sql.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
        (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,expires_at_ms)
        VALUES ('legacy-a',4,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.edits',$1,$2),
          ('legacy-b',1,'legacy-parent-user','legacy-parent-key','legacy-parent-space',
          'images.generations',$3,$2)`, ['b'.repeat(64), Date.now() + 60_000, 'c'.repeat(64)]);
      const [countsBefore] = await sql.unsafe(`SELECT count(*)::integer AS intents,
        count(*) FILTER (WHERE state='outcome_unknown')::integer AS unknowns
        FROM ${schema}.request_dispatch_intents`);
      assert.deepEqual(countsBefore, { intents: 3, unknowns: 1 });
      stages('legal-0069-counterexample', { countsBefore,
        oldRequest: 'legacy-a', observedMaxAttemptIndex: 4,
        operationVariants: 2, priorClaim: claimId });

      for (const [activation, url] of proposals) {
        await sql.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${activation} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
        report.sourceSha256[activation] = digest(await readFile(url));
      }
      const [claimIndex] = await sql.unsafe(`SELECT pg_catalog.to_regclass(
        '${schema}.request_dispatch_intents_one_claim_per_request') IS NOT NULL AS installed`);
      assert.equal(claimIndex.installed, true);
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.request_dispatch_parent_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(parentProposal, 'utf8')).simple();
      }), /Existing dispatch intents need separately reviewed request backfill/);
      const [postReject] = await sql.unsafe(`SELECT
        pg_catalog.to_regclass('${schema}.request_dispatch_requests') IS NULL AS parent_absent,
        (SELECT count(*)::integer FROM ${schema}.request_dispatch_intents) AS old_intents`);
      assert.deepEqual(postReject, { parent_absent: true, old_intents: 3 });
      stages('existing-parent-activation-atomically-refused', { claimIndex, postReject });

      await assert.rejects(sql.unsafe(buildRequestLegacyParentCensus().preflightSql).simple(),
        /Legacy parent census requires a READ ONLY transaction/);
      const first = await readPage(sql, '', 1);
      const second = await readPage(sql, first.at(-1).request_id, 1);
      assert.equal(first.length, 1);
      assert.equal(second.length, 1);
      assert.equal((await readPage(sql, second.at(-1).request_id, 1)).length, 0);
      assert.equal(first[0].request_id, 'legacy-a');
      assert.equal(first[0].attempt_rows, 2);
      assert.equal(first[0].max_attempt_index, 4);
      assert.equal(first[0].scope_variants, 2);
      assert.equal(first[0].unknown_rows, 1);
      assert.equal(first[0].prepared_rows, 1);
      assert.equal(first[0].original_request_sha256, null);
      assert.equal(first[0].original_request_digest_recoverable, false);
      assert.equal(first[0].original_total_attempt_budget_recoverable, false);
      assert.equal(first[0].original_request_deadline_recoverable, false);
      assert.equal(first[0].require_permanent_replay_reservation, true);
      assert.deepEqual(first[0].observed_barriers.split('|').sort(), [
        'claim_consumed_or_unknown', 'exceeds_v1_parent_attempt_ceiling',
        'inconsistent_legacy_scope', 'prepared_attempt_still_present',
      ].sort());
      assert.equal(second[0].request_id, 'legacy-b');
      const [countsAfter] = await sql.unsafe(`SELECT count(*)::integer AS intents,
        count(*) FILTER (WHERE state='outcome_unknown')::integer AS unknowns
        FROM ${schema}.request_dispatch_intents`);
      assert.deepEqual(countsAfter, countsBefore);
      stages('read-only-keyset-census-resumes-without-mutation', { pageLimit: 1,
        first: first[0], second: second[0], countsAfter });
      report.status = 'PASS';
    } catch (error) {
      report.status = 'FAIL'; report.fatal = errorSummary(error);
      throw error;
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { report.cleanupDetails = await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorSummary(error); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      assert.equal(report.cleanup, 'PASS', `owned fixture cleanup failed; report=${reportFile}`);
    }
  });
