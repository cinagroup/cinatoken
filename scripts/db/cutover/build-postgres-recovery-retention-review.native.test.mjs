// Opt-in, owned loopback PostgreSQL 18 fixture for read-only retention review.
// Historical case rows are synthetic: this test does not propose a DELETE path.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { buildPostgresRecoveryRetentionReview } from './build-postgres-recovery-retention-review.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_parent_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url)],
];
const digest = text => createHash('sha256').update(text).digest('hex');
const context = 'a'.repeat(64);
const requestHash = 'b'.repeat(64);
const leaseToken = '22222222-2222-4222-8222-222222222222';

function migratorClient(cluster, password) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {} });
}

async function reviewSnapshot(sql, review) {
  return sql.begin(async tx => {
    await tx.unsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY').simple();
    await tx.unsafe(review.preflightSql).simple();
    return {
      parents: await tx.unsafe(review.parentSql),
      orphans: await tx.unsafe(review.orphanSql),
    };
  });
}

test('native PG18 retention review blocks claim, unknown, incomplete, leased and financial history',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-retention-review-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18, 73 formal migrations and optional parent proposal; read-only review only',
      limitations: [
        'Synthetic old rows are inserted by an isolated fixture superuser with triggers disabled, then scanned with normal triggers restored.',
        'No deletion, approved duration, durable tombstone, representative old database, lock/capacity study, archive or production grant is provided.',
        'No remote database, Worker, Hyperdrive, Queue, provider or financial charge is contacted.',
      ], stages: [], sourceSha256: {} };
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const [server] = await cluster.admin.unsafe(`SELECT current_setting('listen_addresses') AS address,
        current_setting('server_version_num')::integer AS version`);
      assert.equal(server.address, '127.0.0.1');
      assert.ok(server.version >= 180000 && server.version < 190000);
      for (const [name, url] of [['generator', new URL('./build-postgres-recovery-retention-review.mjs', import.meta.url)],
        ['test', new URL(import.meta.url)],
        ['parentProposal', proposals[2][1]]]) {
        report.sourceSha256[name] = digest(await readFile(url));
      }
      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = migratorClient(cluster, password); clients.push(migrator);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations(
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      assert.equal(files.at(-1), '0073_recovery_api_key_workspace_lock.sql');
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = digest(corpus.join('\n'));
      for (const [setting, url] of proposals) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      stage('formal-migrations-and-parent-proposal', { migrations: files.length });

      const now = Number((await cluster.admin.unsafe(`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms`))[0].ms);
      const cutoffMs = now - 1_000;
      const review = buildPostgresRecoveryRetentionReview({ cutoffMs, limit: 20 });
      await assert.rejects(cluster.admin.unsafe(review.preflightSql).simple(),
        /requires a READ ONLY transaction/);
      await assert.rejects(reviewSnapshot(cluster.admin,
        buildPostgresRecoveryRetentionReview({ cutoffMs: now + 60_000, limit: 20 })),
      /cutoff is in the future/);
      stage('read-only-and-future-cutoff-preflight-reject');

      // The fixture models historical states, including a legacy pre-parent intent.
      // session_replication_role is LOCAL to this one superuser transaction; all
      // production trigger/FK definitions remain installed and enabled afterward.
      const cases = [
        { id: 'retention-clean', state: 'expired_before_dispatch' },
        { id: 'retention-prepared', state: 'prepared' },
        { id: 'retention-claimed', state: 'dispatch_claimed', claimed: true },
        { id: 'retention-unknown', state: 'outcome_unknown', claimed: true },
        { id: 'retention-leased', state: 'dispatch_claimed', claimed: true },
        { id: 'retention-financial', state: 'dispatch_claimed', claimed: true },
        { id: 'retention-missing', missingAttempt: true },
        { id: 'retention-orphan', state: 'expired_before_dispatch', orphan: true },
      ].map(item => ({ ...item, claimId: item.claimed ? randomUUID() : null }));
      const claimById = Object.fromEntries(cases.map(item => [item.id, item.claimId]));
      await cluster.admin.begin(async tx => {
        await tx.unsafe(`SET LOCAL session_replication_role = 'replica'`);
        for (const item of cases) {
          if (!item.orphan) {
            await tx.unsafe(`INSERT INTO ${schema}.request_dispatch_requests
              (request_id,user_id,api_key_id,workspace_id,operation,request_sha256,
               original_created_at_ms,expires_at_ms,max_attempts,prepared_count,claim_count,first_claim_id)
              VALUES ($1,'retention-user','retention-key','retention-workspace','images.generations',
                $2,$3,$4,1,1,$5,$6)`, [item.id, requestHash, now - 30_000, now - 10_000,
              item.claimed ? 1 : 0, item.claimId]);
          }
          if (!item.missingAttempt) {
            await tx.unsafe(`INSERT INTO ${schema}.request_dispatch_intents
              (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,
               state,revision,dispatch_claim_id,expires_at_ms,created_at_ms,updated_at_ms,claimed_at_ms)
              VALUES ($1,1,'retention-user','retention-key','retention-workspace','images.generations',
                $2,$3,$4,$5,$6,$7,$8,$9)`, [item.id, context, item.state,
              item.state === 'prepared' ? 0 : 1, item.claimId,
              now - 10_000, now - 30_000,
              item.state === 'prepared' ? now - 30_000 : now - 9_000,
              item.claimed ? now - 20_000 : null]);
          }
        }
        const payload = '{}', payloadHash = digest(payload);
        for (const [id, state] of [['retention-leased', 'leased'], ['retention-financial', 'committed']]) {
          await tx.unsafe(`INSERT INTO ${schema}.request_usage_settlements
            (request_id,attempt_index,user_id,api_key_id,workspace_id,operation,context_sha256,
             dispatch_claim_id,payload_version,payload_json,payload_sha256,recorded_at,created_at_ms)
            VALUES ($1,1,'retention-user','retention-key','retention-workspace','images.generations',
              $2,$3,1,$4,$5,'2025-01-01T00:00:00.000Z',$6)`,
          [id, context, claimById[id], payload, payloadHash, now - 8_000]);
          await tx.unsafe(`INSERT INTO ${schema}.request_usage_settlement_outbox
            (request_id,payload_sha256,created_at_ms) VALUES ($1,$2,$3)`,
          [id, payloadHash, now - 8_000]);
          await tx.unsafe(`INSERT INTO ${schema}.request_usage_recovery_jobs
            (request_id,payload_sha256,fact_created_at_ms,user_id,workspace_id,state,revision,
             attempts,last_transition,lease_token,lease_seconds,lease_expires_at_ms,
             available_at_ms,created_at_ms,updated_at_ms)
            VALUES ($1,$2,$3,'retention-user','retention-workspace',$4,$5,1,$6,$7,$8,$9,$10,$11,$12)`,
          [id, payloadHash, now - 8_000, state, state === 'leased' ? 1 : 2,
            state === 'leased' ? 'claimed' : 'committed', state === 'leased' ? leaseToken : null,
            state === 'leased' ? 300 : null, state === 'leased' ? now + 299_000 : null,
            state === 'leased' ? now + 299_000 : null, now - 8_000, now - 1_000]);
        }
        await tx.unsafe(`INSERT INTO ${schema}.api_key_request_logs(id) VALUES ('retention-financial')`);
        await tx.unsafe(`INSERT INTO ${schema}.request_usage_commit_receipts
          (request_id,payload_sha256,user_id,workspace_id,fact_created_at_ms,recorded_at,
           lease_token,lease_revision,lease_attempts,lease_expires_at_ms,created_at_ms)
          VALUES ('retention-financial',$1,'retention-user','retention-workspace',$2,
           '2025-01-01T00:00:00.000Z',$3,1,1,$4,$5)`,
        [payloadHash, now - 8_000, leaseToken, now + 100_000, now - 1_000]);
      });
      const [triggerSetting] = await cluster.admin.unsafe(`SELECT current_setting('session_replication_role') AS value`);
      assert.equal(triggerSetting.value, 'origin');
      stage('synthetic-historical-graph', { parentRows: 7, orphanRows: 1 });

      const { parents, orphans } = await reviewSnapshot(cluster.admin, review);
      assert.equal(parents.length, 7);
      assert.equal(orphans.length, 1);
      assert.ok([...parents, ...orphans].every(row => row.delete_allowed === false));
      const byId = Object.fromEntries(parents.map(row => [row.request_id, row]));
      assert.equal(byId['retention-clean'].review_bucket, 'pre_dispatch_expired_policy_review');
      assert.equal(byId['retention-clean'].observed_blockers, '{}');
      assert.ok(byId['retention-prepared'].observed_blockers.includes('prepared_attempt'));
      assert.ok(byId['retention-missing'].observed_blockers.includes('attempt_history_incomplete_or_nonterminal'));
      assert.ok(byId['retention-claimed'].observed_blockers.includes('parent_claim_consumed'));
      assert.ok(byId['retention-unknown'].observed_blockers.includes('claimed_or_unknown_attempt'));
      assert.ok(byId['retention-leased'].observed_blockers.includes('recovery_job'));
      assert.ok(byId['retention-financial'].observed_blockers.includes('immutable_financial_receipt'));
      assert.ok(byId['retention-financial'].observed_blockers.includes('legacy_financial_log'));
      assert.equal(orphans[0].request_id, 'retention-orphan');
      stage('bounded-read-only-blocker-report', { parentRows: parents.length, orphanRows: orphans.length,
        deletedRows: 0, deleteAllowedRows: 0 });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { name: error?.name ?? null, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 600) };
    } finally {
      for (const client of clients) await client.end({ timeout: 1 }).catch(() => {});
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error).slice(0, 400); }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ reportFile, status: report.status, cleanup: report.cleanup,
        stages: report.stages }, null, 2));
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS', 'Owned native cluster cleanup failed');
  });
