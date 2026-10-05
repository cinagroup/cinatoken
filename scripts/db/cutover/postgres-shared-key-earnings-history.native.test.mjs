// Review-only PostgreSQL 18.6 fixture. The cluster is private loopback and
// disposable; no ambient database URL, provider, cloud ledger or deployment.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guard = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null, constraint: error?.constraint ?? null,
  message: String(error?.message ?? error).slice(0, 300) });

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-earning-history-${label}` } });
}

async function activate(sql, body, enabled = true) {
  return sql.begin(async tx => {
    if (enabled) await tx.unsafe("SET LOCAL cinatoken.shared_key_earnings_history_guard_activation = 'reviewed-v1'");
    await tx.unsafe(body).simple();
  });
}

async function totals(sql) {
  const [row] = await sql.unsafe(`SELECT
    (SELECT count(*)::int FROM ${schema}.shared_keys WHERE id='history-key') AS keys,
    (SELECT count(*)::int FROM ${schema}.shared_key_earnings WHERE id='history-earning') AS earnings,
    (SELECT count(*)::int FROM ${schema}.portal_ledger_entries WHERE reference_id='history-earning') AS ledger,
    (SELECT balance_micros::text FROM ${schema}.user_earnings WHERE user_id='history-seller') AS balance`);
  return row;
}

test('native PG18 credited shared-key earnings reject cascade and direct history mutation',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-earning-history-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, 73 formal migrations and review-only earnings history guard',
      limitations: [
        'The proposal is not a formal migration or deployed on a production database.',
        'Only PostgreSQL is protected here; D1 and MySQL marketplace cascade policies remain open.',
        'No immutable seller quote, price snapshot, economic outbox, adjustment or recovery consumer exists in this fixture.',
      ], stages: [], sourceSha256: {} };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime NOLOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, password, 'migrator');
      const holder = client(cluster, password, 'holder');
      clients.push(migrator, holder);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      const body = await readFile(guard, 'utf8');
      report.sourceSha256 = {
        formalMigrationCorpus: hash(corpus.join('\n')),
        nativeTest: hash(await readFile(new URL(import.meta.url))),
        historyGuardProposal: hash(body),
      };
      stage('formal-schema-and-history-credit-trigger-installed', { migrations: files.length });

      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('history-seller','history-seller@example.invalid'),
          ('history-buyer','history-buyer@example.invalid');
        INSERT INTO ${schema}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('history-space','personal','history-buyer','History Buyer','history-buyer','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('history-api-key','synthetic-gateway-key','history-buyer','history-space');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('history-seller');
        INSERT INTO ${schema}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint)
          VALUES ('history-key','history-seller','openai','synthetic-secret','fingerprint-one');
        INSERT INTO ${schema}.api_key_request_logs(id,user_id,api_key_id,workspace_id)
          VALUES ('history-log','history-buyer','history-api-key','history-space');
        INSERT INTO ${schema}.shared_key_earnings
          (id,request_log_id,shared_key_id,seller_user_id,gross_amount,net_amount)
          VALUES ('history-earning','history-log','history-key','history-seller',0.05,0.04);`).simple();
      const initial = await totals(migrator);
      assert.deepEqual(initial, { keys: 1, earnings: 1, ledger: 1, balance: '40000' });
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe(`DELETE FROM ${schema}.shared_keys WHERE id='history-key'`);
        const inside = await totals(tx);
        assert.deepEqual(inside, { keys: 0, earnings: 0, ledger: 1, balance: '40000' });
        throw new Error('rollback unprotected cascade control');
      }), /rollback unprotected cascade control/);
      assert.deepEqual(await totals(migrator), initial);
      stage('pre-guard-cascade-negative-control-rolled-back', { insideKeys: 0,
        insideEarnings: 0, insideLedger: 1, insideBalanceMicros: '40000' });

      await assert.rejects(activate(migrator, body, false),
        /Shared-key earning history activation or owner contract differs/);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.shared_key_earnings'::regclass
          AND tgname='shared_key_earnings_history_immutable'`))[0].n, 0);
      let releaseHolder;
      let holderReady;
      const ready = new Promise(resolve => { holderReady = resolve; });
      const hold = new Promise(resolve => { releaseHolder = resolve; });
      const holding = holder.begin(async tx => {
        await tx.unsafe(`LOCK TABLE ${schema}.shared_key_earnings IN ROW EXCLUSIVE MODE`);
        holderReady();
        await hold;
      });
      await ready;
      const started = performance.now();
      try {
        await assert.rejects(activate(migrator, body), error => error?.code === '55P03');
      } finally { releaseHolder(); await holding; }
      const blockedMs = Math.round(performance.now() - started);
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.shared_key_earnings'::regclass
          AND tgname='shared_key_earnings_history_immutable'`))[0].n, 0);
      await activate(migrator, body);
      stage('activation-gated-lock-timeout-rollback-and-retry', { blockedMs });

      const forbidden = [
        [`DELETE FROM ${schema}.shared_keys WHERE id='history-key'`, 'shared-key-cascade'],
        [`DELETE FROM ${schema}.users WHERE id='history-seller'`, 'seller-cascade'],
        [`DELETE FROM ${schema}.shared_key_earnings WHERE id='history-earning'`, 'earning-delete'],
        [`UPDATE ${schema}.shared_key_earnings SET net_amount=0.08 WHERE id='history-earning'`, 'earning-update'],
        [`TRUNCATE ${schema}.shared_key_earnings`, 'earning-truncate'],
      ];
      for (const [sql, label] of forbidden) {
        await assert.rejects(migrator.unsafe(sql), error => {
          assert.equal(error?.code, '23514', label);
          assert.match(String(error?.message), /Credited shared-key earning history is immutable/, label);
          return true;
        });
        assert.deepEqual(await totals(migrator), initial, label);
      }
      stage('credited-history-and-parent-cascade-mutations-refused',
        { refused: forbidden.map(([, label]) => label), durable: initial });

      const duplicate = await migrator.unsafe(`INSERT INTO ${schema}.shared_key_earnings
        (id,request_log_id,shared_key_id,seller_user_id,gross_amount,net_amount)
        VALUES ('history-duplicate','history-log','history-key','history-seller',0.10,0.08)
        ON CONFLICT (request_log_id) DO NOTHING RETURNING id`);
      assert.equal(duplicate.length, 0);
      assert.deepEqual(await totals(migrator), initial);
      await migrator.unsafe(`INSERT INTO ${schema}.shared_keys
        (id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('unused-key','history-seller','openai','synthetic-unused','fingerprint-two')`);
      assert.equal((await migrator.unsafe(`DELETE FROM ${schema}.shared_keys
        WHERE id='unused-key' RETURNING id`)).length, 1);
      stage('duplicate-does-not-credit-and-unused-key-remains-deletable');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL'; report.error = errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorInfo(error); failure ??= error; }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key earning history report: ' + reportFile);
    }
    if (failure) throw failure;
  });
