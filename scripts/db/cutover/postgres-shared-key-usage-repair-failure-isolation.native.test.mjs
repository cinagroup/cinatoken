// Review-only PG18.6 fixture. Own loopback cluster, no ambient URL or cloud.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const history = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-earnings-history-guard.sql', import.meta.url);
const jobs = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-jobs.sql', import.meta.url);
const isolation = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-usage-repair-failure-isolation.sql', import.meta.url);
const sha = source => createHash('sha256').update(source).digest('hex');

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-repair-failure-${label}` } });
}

async function activate(sql, setting, source) {
  await sql.begin(async tx => {
    if (setting) await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v2'`);
    await tx.unsafe(source).simple();
  });
}

async function earning(sql, key, suffix, tokens = 100) {
  await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id)
    VALUES ($1,'buyer','buyer-key','buyer-workspace')`, [`log-${suffix}`]);
  await sql.unsafe(`INSERT INTO ${schema}.shared_key_earnings
    (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,net_amount)
    VALUES ($1,$2,$3,'seller',$4,0,0.05,0.04)`,
  [`earning-${suffix}`, `log-${suffix}`, key, tokens]);
}

async function attempt(sql) {
  const rows = await sql.unsafe(`SELECT * FROM ${schema}.attempt_one_shared_key_usage_repair()`);
  assert.equal(rows.length, 1);
  return rows[0];
}

test('native PG18 isolates poison repair keys with bounded retry and manual dead-letter recovery',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-failure-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6, 73 formal migrations, three review-only proposals',
      stages: [], sourceSha256: {}, limitations: [
        'No formal migration, remote SQL, deployment or Worker/Hyperdrive runtime was exercised.',
        'The fixture does not establish production backlog size or safe maintenance lock duration.',
        'Failure isolation covers catchable SQL errors; query cancellation can stop the run before later keys.',
        'Independent function DDL still requires trusted migrator serialization.',
      ] };
    const stage = name => report.stages.push({ name, result: 'PASS' });
    let failure;
    const clients = [];
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const password = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${password}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN;
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const sql = client(cluster, password, 'migrator');
      const holder = client(cluster, password, 'held-trigger-ddl');
      clients.push(sql, holder);
      await sql.unsafe(`CREATE TABLE ${schema}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        await sql.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      const historyBody = await readFile(history, 'utf8');
      const jobsBody = await readFile(jobs, 'utf8');
      const isolationBody = await readFile(isolation, 'utf8');
      report.sourceSha256 = { history: sha(historyBody), jobs: sha(jobsBody), isolation: sha(isolationBody),
        nativeFixture: sha(await readFile(new URL(import.meta.url))) };
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_earnings_history_guard_activation='reviewed-v1'`);
        await tx.unsafe(historyBody).simple();
      });
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_activation='reviewed-v1'`);
        await tx.unsafe(jobsBody).simple();
      });
      await assert.rejects(activate(sql, null, isolationBody),
        /Shared-key usage repair failure-isolation preflight differs/u);
      assert.equal((await sql.unsafe(`SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid='${schema}.shared_key_usage_repair_jobs'::regclass
          AND attname='attempt_count' AND NOT attisdropped`)).length, 0);
      let signalReady;
      let releaseHeld;
      const ready = new Promise(resolve => { signalReady = resolve; });
      const held = new Promise(resolve => { releaseHeld = resolve; });
      const holdTransaction = holder.begin(async tx => {
        await tx.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
          DISABLE TRIGGER shared_key_earnings_history_no_truncate`);
        signalReady();
        await held;
      });
      await Promise.race([ready, holdTransaction.then(
        () => { throw new Error('Trigger holder completed before lock probe'); },
        error => { throw error; })]);
      try {
        await assert.rejects(activate(sql,
          'cinatoken.shared_key_usage_repair_failure_activation', isolationBody),
        error => error?.code === '55P03');
        assert.equal((await sql.unsafe(`SELECT 1 FROM pg_catalog.pg_attribute
          WHERE attrelid='${schema}.shared_key_usage_repair_jobs'::regclass
            AND attname='attempt_count' AND NOT attisdropped`)).length, 0);
        assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regprocedure(
          '${schema}.attempt_one_shared_key_usage_repair()') AS fn`))[0].fn, null);
      } finally {
        releaseHeld();
        await holdTransaction;
      }
      assert.equal((await sql.unsafe(`SELECT tgenabled FROM pg_catalog.pg_trigger
        WHERE tgrelid='${schema}.shared_key_earnings'::regclass
          AND tgname='shared_key_earnings_history_no_truncate'`))[0].tgenabled, 'D');
      await assert.rejects(activate(sql,
        'cinatoken.shared_key_usage_repair_failure_activation', isolationBody),
      /Shared-key usage repair failure-isolation preflight differs/u);
      assert.equal((await sql.unsafe(`SELECT 1 FROM pg_catalog.pg_attribute
        WHERE attrelid='${schema}.shared_key_usage_repair_jobs'::regclass
          AND attname='attempt_count' AND NOT attisdropped`)).length, 0);
      await sql.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_history_no_truncate`);
      stage('uncommitted-trigger-drift-times-out-before-preflight-and-committed-drift-rejected');
      await activate(sql, 'cinatoken.shared_key_usage_repair_failure_activation', isolationBody);
      stage('exact-activation-and-atomic-successor-install');

      await sql.unsafe(`INSERT INTO ${schema}.users(id,email) VALUES
          ('seller','seller@example.invalid'),('buyer','buyer@example.invalid');
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('buyer-workspace','personal','buyer','Buyer','buyer','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
          VALUES ('buyer-key','synthetic-hash','buyer','buyer-workspace');
        INSERT INTO ${schema}.user_earnings(user_id) VALUES ('seller');
        INSERT INTO ${schema}.shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
          VALUES ('bad-key','seller','openai','synthetic-secret-1','fingerprint-1'),
            ('good-key','seller','openai','synthetic-secret-2','fingerprint-2');`).simple();
      await earning(sql, 'bad-key', 'bad', 100);
      await earning(sql, 'good-key', 'good', 40);
      await sql.unsafe(`ALTER TABLE ${schema}.shared_keys ADD CONSTRAINT poison_bad_key_projection
        CHECK (id <> 'bad-key' OR served_input_tokens = 0)`);
      const first = await attempt(sql);
      assert.equal(first.shared_key_id, 'bad-key');
      assert.equal(first.outcome, 'deferred');
      assert.equal(first.attempt_count, 1);
      assert.ok(new Date(first.retry_at).getTime() > Date.now());
      const second = await attempt(sql);
      assert.deepEqual({ key: second.shared_key_id, outcome: second.outcome },
        { key: 'good-key', outcome: 'repaired' });
      const [projection] = await sql.unsafe(`SELECT
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='bad-key') AS bad,
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='good-key') AS good,
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs) AS jobs`);
      assert.deepEqual(projection, { bad: '0', good: '40', earnings: 2, jobs: 1 });
      stage('first-poison-attempt-commits-failure-state-and-next-key-repairs');

      await earning(sql, 'bad-key', 'bad-again', 50);
      const [afterFreshEarning] = await sql.unsafe(`SELECT attempt_count,
        retry_after > pg_catalog.clock_timestamp() AS waiting,
        request_log_id FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key'`);
      assert.deepEqual(afterFreshEarning, { attempt_count: 1, waiting: true,
        request_log_id: 'log-bad-again' });
      assert.equal((await attempt(sql)).outcome, 'no_candidate');
      stage('new-earning-does-not-bypass-retry-window');

      for (let expected = 2; expected <= 5; expected++) {
        await sql.unsafe(`UPDATE ${schema}.shared_key_usage_repair_jobs
          SET retry_after=pg_catalog.clock_timestamp()-interval '1 second'
          WHERE shared_key_id='bad-key'`);
        const result = await attempt(sql);
        assert.equal(result.shared_key_id, 'bad-key');
        assert.equal(result.attempt_count, expected);
        assert.equal(result.outcome, expected === 5 ? 'dead_lettered' : 'deferred');
        if (expected < 5) {
          const remaining = new Date(result.retry_at).getTime() - Date.now();
          const intended = 60 * (2 ** (expected - 1)) * 1000;
          assert.ok(remaining >= intended - 5_000 && remaining <= intended + 5_000,
            `attempt ${expected} remaining=${remaining} intended=${intended}`);
        } else assert.equal(result.retry_at, null);
      }
      assert.equal((await attempt(sql)).outcome, 'no_candidate');
      await earning(sql, 'bad-key', 'bad-dead', 25);
      const [dead] = await sql.unsafe(`SELECT attempt_count,dead_lettered_at,
        pg_catalog.md5(pg_catalog.to_char(last_failed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD HH24:MI:SS.US')) AS failure_token,
        retry_after,request_log_id FROM ${schema}.shared_key_usage_repair_jobs
        WHERE shared_key_id='bad-key'`);
      assert.equal(dead.attempt_count, 5);
      assert.ok(dead.dead_lettered_at);
      assert.equal(dead.retry_after, null);
      assert.equal(dead.request_log_id, 'log-bad-dead');
      assert.equal((await attempt(sql)).outcome, 'no_candidate');
      stage('five-attempt-dead-letter-stays-quarantined-after-new-earning');

      const [token] = await sql.unsafe(`SELECT
        pg_catalog.md5(pg_catalog.to_char(last_failed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD HH24:MI:SS.US'))=$1::text AS matches
        FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key'`,
      [dead.failure_token]);
      assert.equal(token.matches, true, JSON.stringify(token));
      await sql.unsafe(`SET TIME ZONE 'UTC'`);
      const [crossZone] = await sql.unsafe(`SELECT
        pg_catalog.md5(pg_catalog.to_char(last_failed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD HH24:MI:SS.US'))=$1::text AS matches
        FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key'`,
      [dead.failure_token]);
      assert.equal(crossZone.matches, true);

      await assert.rejects(sql.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter(
        'bad-key',$1)`, [dead.failure_token]),
      /manual recovery authority differs/u);
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_requeue_activation='reviewed-v2'`);
        await tx.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter(
          'bad-key',$1)`, ['00000000000000000000000000000000']);
      }), /dead letter changed/u);
      assert.equal((await attempt(sql)).outcome, 'no_candidate');
      await sql.unsafe(`ALTER TABLE ${schema}.shared_keys DROP CONSTRAINT poison_bad_key_projection`);
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_requeue_activation='reviewed-v2'`);
        const [row] = await tx.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter(
          'bad-key',$1) AS recovered`, [dead.failure_token]);
        assert.equal(row.recovered, true);
      });
      const restored = await attempt(sql);
      assert.deepEqual({ key: restored.shared_key_id, outcome: restored.outcome },
        { key: 'bad-key', outcome: 'repaired' });
      const [afterRecovery] = await sql.unsafe(`SELECT
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='bad-key') AS input,
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key') AS jobs`);
      assert.deepEqual(afterRecovery, { input: '175', jobs: 0 });
      stage('direct-migrator-explicit-requeue-and-single-projection-repair');

      await sql.unsafe(`INSERT INTO ${schema}.shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('cancel-key','seller','openai','synthetic-secret-3','fingerprint-3')`);
      await earning(sql, 'cancel-key', 'cancel', 10);
      await sql.unsafe(`CREATE FUNCTION ${schema}.slow_cancel_projection() RETURNS trigger
        LANGUAGE plpgsql AS $slow$ BEGIN IF NEW.id='cancel-key' THEN
          PERFORM pg_catalog.pg_sleep(1); END IF; RETURN NEW; END; $slow$;
        CREATE TRIGGER slow_cancel_projection BEFORE UPDATE ON ${schema}.shared_keys
          FOR EACH ROW EXECUTE FUNCTION ${schema}.slow_cancel_projection();`).simple();
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL statement_timeout='200ms'`);
        await tx.unsafe(`SELECT * FROM ${schema}.attempt_one_shared_key_usage_repair()`);
      }), error => error?.code === '57014');
      const [cancel] = await sql.unsafe(`SELECT attempt_count,retry_after,dead_lettered_at
        FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='cancel-key'`);
      assert.deepEqual(cancel, { attempt_count: 0, retry_after: null, dead_lettered_at: null });
      await sql.unsafe(`DROP TRIGGER slow_cancel_projection ON ${schema}.shared_keys;
        DROP FUNCTION ${schema}.slow_cancel_projection();`).simple();
      assert.equal((await attempt(sql)).outcome, 'repaired');
      stage('query-cancellation-propagates-with-job-unchanged');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 400) };
    } finally {
      await Promise.allSettled(clients.map(raw => raw.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.message ?? error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key usage repair failure report: ' + reportPath);
    }
    if (failure) throw failure;
  });
