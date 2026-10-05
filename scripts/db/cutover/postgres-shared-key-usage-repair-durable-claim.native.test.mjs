// Review-only PG18.6 multi-session fixture. Own loopback cluster, no ambient URL.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { listPg73Migrations } from './pg73-native-fixture.mjs';

const schema = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposal = name => new URL(`../../../packages/core/migrations-proposals/postgres/${name}.sql`, import.meta.url);
const history = proposal('shared-key-earnings-history-guard');
const jobs = proposal('shared-key-usage-repair-jobs');
const isolation = proposal('shared-key-usage-repair-failure-isolation');
const durable = proposal('shared-key-usage-repair-durable-claim');
const sha = source => createHash('sha256').update(source).digest('hex');

function client(cluster, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: 'cinatoken_gateway_migrator', password, ssl: false, max: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-durable-claim-${label}` } });
}
async function install(sql, url, setting, version) {
  await sql.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting}='${version}'`);
    await tx.unsafe(await readFile(url, 'utf8')).simple();
  });
}
async function earn(sql, key, label, tokens) {
  await sql.unsafe(`INSERT INTO ${schema}.api_key_request_logs
    (id,user_id,api_key_id,workspace_id)
    VALUES ($1,'buyer','buyer-key','buyer-workspace')`, [`log-${label}`]);
  await sql.unsafe(`INSERT INTO ${schema}.shared_key_earnings
    (id,request_log_id,shared_key_id,seller_user_id,input_tokens,output_tokens,gross_amount,net_amount)
    VALUES ($1,$2,$3,'seller',$4,0,0.05,0.04)`,
  [`earning-${label}`, `log-${label}`, key, tokens]);
}
async function claim(sql) {
  const rows = await sql.unsafe(`SELECT * FROM ${schema}.claim_one_shared_key_usage_repair()`);
  assert.equal(rows.length, 1);
  return rows[0];
}
async function finish(sql, key, token) {
  const rows = await sql.unsafe(`SELECT * FROM ${schema}.finish_claimed_shared_key_usage_repair($1::text,$2::uuid)`,
    [key, token]);
  assert.equal(rows.length, 1);
  return rows[0];
}
async function speedRetry(sql, key) {
  await sql.unsafe(`UPDATE ${schema}.shared_key_usage_repair_jobs
    SET retry_after=pg_catalog.clock_timestamp()-interval '1 second',
      claim_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
    WHERE shared_key_id=$1`, [key]);
}

test('native PG18 committed claim prevents repeated 57014 starvation without double credit',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-usage-claim-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18.6; 73 formal migrations; four review-only proposals',
      stages: [], sourceSha256: {}, limitations: [
        'No formal migration, remote SQL, deployment, actual Workers Cron or Hyperdrive run.',
        'The fixture accelerates retry/lease timestamps and does not prove production queue throughput.',
        'A fifth admitted attempt is quarantined even if cancellation leaves its outcome unknown.',
        'The direct migrator is trusted; dedicated LOGIN and ACLs are checked by a separate fixture.',
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
      const sql = client(cluster, password, 'operator-a');
      const peer = client(cluster, password, 'operator-b');
      clients.push(sql, peer);
      await sql.unsafe(`CREATE TABLE ${schema}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
const files = await listPg73Migrations();
      assert.equal(files.length, 73);
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        await sql.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      for (const [name, url] of Object.entries({ history, jobs, isolation, durable })) {
        report.sourceSha256[name] = sha(await readFile(url));
      }
      report.sourceSha256.nativeFixture = sha(await readFile(new URL(import.meta.url)));
      await install(sql, history,
        'cinatoken.shared_key_earnings_history_guard_activation', 'reviewed-v1');
      await install(sql, jobs, 'cinatoken.shared_key_usage_repair_activation', 'reviewed-v1');
      await install(sql, isolation,
        'cinatoken.shared_key_usage_repair_failure_activation', 'reviewed-v2');
      stage('formal-73-and-v337-installed');

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
      await earn(sql, 'bad-key', 'bad', 100);
      await earn(sql, 'good-key', 'good', 40);
      await sql.unsafe(`CREATE FUNCTION ${schema}.slow_bad_projection() RETURNS trigger
        LANGUAGE plpgsql AS $slow$ BEGIN IF NEW.id='bad-key' THEN
          PERFORM pg_catalog.pg_sleep(1); END IF; RETURN NEW; END; $slow$;
        CREATE TRIGGER slow_bad_projection BEFORE UPDATE ON ${schema}.shared_keys
          FOR EACH ROW EXECUTE FUNCTION ${schema}.slow_bad_projection();`).simple();
      for (let n = 0; n < 2; n++) {
        await assert.rejects(sql.begin(async tx => {
          await tx.unsafe(`SET LOCAL statement_timeout='200ms'`);
          await tx.unsafe(`SELECT * FROM ${schema}.attempt_one_shared_key_usage_repair()`);
        }), error => error?.code === '57014');
      }
      const [v337] = await sql.unsafe(`SELECT
        (SELECT attempt_count FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key') AS attempts,
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='good-key') AS healthy`);
      assert.deepEqual(v337, { attempts: 0, healthy: '0' });
      stage('negative-control-v337-repeats-head-cancellation-and-starves-healthy-key');

      await assert.rejects(install(sql, durable,
        'cinatoken.shared_key_usage_repair_claim_activation', 'wrong'),
      /durable-claim preflight differs/u);
      assert.equal((await sql.unsafe(`SELECT pg_catalog.to_regprocedure(
        '${schema}.claim_one_shared_key_usage_repair()') AS fn`))[0].fn, null);
      await sql.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        DISABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await assert.rejects(install(sql, durable,
        'cinatoken.shared_key_usage_repair_claim_activation', 'reviewed-v3'),
      /durable-claim preflight differs/u);
      await sql.unsafe(`ALTER TABLE ${schema}.shared_key_earnings
        ENABLE TRIGGER shared_key_earnings_credit_after_insert`);
      await sql.unsafe(`DROP TRIGGER shared_key_earnings_enqueue_usage_repair
        ON ${schema}.shared_key_earnings;
        CREATE TRIGGER shared_key_earnings_enqueue_usage_repair
        AFTER INSERT ON ${schema}.shared_key_earnings
        FOR EACH ROW WHEN (false)
        EXECUTE FUNCTION ${schema}.enqueue_shared_key_usage_repair();`).simple();
      await assert.rejects(install(sql, durable,
        'cinatoken.shared_key_usage_repair_claim_activation', 'reviewed-v3'),
      /durable-claim preflight differs/u);
      await sql.unsafe(`DROP TRIGGER shared_key_earnings_enqueue_usage_repair
        ON ${schema}.shared_key_earnings;
        CREATE TRIGGER shared_key_earnings_enqueue_usage_repair
        AFTER INSERT ON ${schema}.shared_key_earnings
        FOR EACH ROW EXECUTE FUNCTION ${schema}.enqueue_shared_key_usage_repair();`).simple();
      await install(sql, durable,
        'cinatoken.shared_key_usage_repair_claim_activation', 'reviewed-v3');
      stage('exact-v338-activation-trigger-predicate-guard-and-atomic-install');

      const badClaim = await claim(sql);
      assert.equal(badClaim.shared_key_id, 'bad-key');
      assert.equal(badClaim.attempt_count, 1);
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL statement_timeout='200ms'`);
        await tx.unsafe(`SELECT * FROM ${schema}.finish_claimed_shared_key_usage_repair($1::text,$2::uuid)`,
          [badClaim.shared_key_id, badClaim.claim_token]);
      }), error => error?.code === '57014');
      const [afterCancel] = await sql.unsafe(`SELECT attempt_count,
        retry_after > pg_catalog.clock_timestamp() AS deferred,
        claim_token::text AS token,last_sqlstate
        FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key'`);
      assert.deepEqual(afterCancel, { attempt_count: 1, deferred: true,
        token: badClaim.claim_token, last_sqlstate: 'PZL01' });
      await earn(sql, 'bad-key', 'new-while-deferred', 50);
      const [afterNewEarning] = await sql.unsafe(`SELECT attempt_count,
        retry_after > pg_catalog.clock_timestamp() AS deferred,
        claim_token::text AS token FROM ${schema}.shared_key_usage_repair_jobs
        WHERE shared_key_id='bad-key'`);
      assert.deepEqual(afterNewEarning, { attempt_count: 1, deferred: true,
        token: badClaim.claim_token });
      const goodClaim = await claim(sql);
      assert.equal(goodClaim.shared_key_id, 'good-key');
      assert.equal((await finish(sql, goodClaim.shared_key_id, goodClaim.claim_token)).outcome, 'repaired');
      assert.equal((await finish(sql, goodClaim.shared_key_id, goodClaim.claim_token)).outcome, 'stale');
      const [afterGood] = await sql.unsafe(`SELECT
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='good-key') AS healthy,
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT lifetime_earned::text FROM ${schema}.user_earnings WHERE user_id='seller') AS seller_total`);
      assert.deepEqual(afterGood, { healthy: '40', earnings: 3, seller_total: '0.120000' });
      stage('cancel-propagates-earning-preserves-backoff-and-next-run-repairs-healthy-key');

      await sql.unsafe(`INSERT INTO ${schema}.shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('race-a','seller','openai','synthetic-secret-3','fingerprint-3'),
          ('race-b','seller','openai','synthetic-secret-4','fingerprint-4')`);
      await earn(sql, 'race-a', 'race-a', 12);
      await earn(sql, 'race-b', 'race-b', 15);
      const [a, b] = await Promise.all([claim(sql), claim(peer)]);
      assert.deepEqual(new Set([a.shared_key_id, b.shared_key_id]), new Set(['race-a','race-b']));
      assert.equal((await finish(sql, a.shared_key_id, randomUUID())).outcome, 'stale');
      assert.equal((await finish(sql, a.shared_key_id, a.claim_token)).outcome, 'repaired');
      assert.equal((await finish(peer, b.shared_key_id, b.claim_token)).outcome, 'repaired');
      stage('two-operators-claim-distinct-keys-and-stale-token-cannot-mutate');

      await sql.unsafe(`INSERT INTO ${schema}.shared_keys(id,seller_user_id,channel_type,api_key,key_fingerprint)
        VALUES ('ack-lost','seller','openai','synthetic-secret-5','fingerprint-5')`);
      await earn(sql, 'ack-lost', 'ack-lost', 25);
      const abandoned = await claim(sql); // Simulate a lost claim COMMIT ACK: caller never finishes.
      assert.equal(abandoned.shared_key_id, 'ack-lost');
      assert.equal((await claim(peer)).shared_key_id, null);
      await speedRetry(sql, 'ack-lost');
      const retried = await claim(peer);
      assert.equal(retried.shared_key_id, 'ack-lost');
      assert.notEqual(retried.claim_token, abandoned.claim_token);
      assert.equal((await finish(sql, abandoned.shared_key_id, abandoned.claim_token)).outcome, 'stale');
      assert.equal((await finish(peer, retried.shared_key_id, retried.claim_token)).outcome, 'repaired');
      const [ackState] = await sql.unsafe(`SELECT
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='ack-lost') AS projected,
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='ack-lost') AS jobs`);
      assert.deepEqual(ackState, { projected: '25', jobs: 0 });
      stage('lost-claim-ack-and-expired-lease-retry-once-without-double-projection');

      for (let expected = 2; expected <= 5; expected++) {
        await speedRetry(sql, 'bad-key');
        const next = await claim(sql);
        assert.equal(next.shared_key_id, 'bad-key');
        assert.equal(next.attempt_count, expected);
        await assert.rejects(sql.begin(async tx => {
          await tx.unsafe(`SET LOCAL statement_timeout='200ms'`);
          await tx.unsafe(`SELECT * FROM ${schema}.finish_claimed_shared_key_usage_repair($1::text,$2::uuid)`,
            [next.shared_key_id, next.claim_token]);
        }), error => error?.code === '57014');
      }
      const [dead] = await sql.unsafe(`SELECT attempt_count,dead_lettered_at IS NOT NULL AS dead,
        claim_token IS NOT NULL AS pending,
        pg_catalog.md5(pg_catalog.to_char(last_failed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD HH24:MI:SS.US')) AS failure_token
        FROM ${schema}.shared_key_usage_repair_jobs WHERE shared_key_id='bad-key'`);
      assert.deepEqual({ attempts: dead.attempt_count, dead: dead.dead, pending: dead.pending },
        { attempts: 5, dead: true, pending: true });
      assert.equal((await claim(sql)).shared_key_id, null);
      await assert.rejects(sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_requeue_activation='reviewed-v3'`);
        await tx.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter('bad-key',$1)`,
          [dead.failure_token]);
      }), /dead letter changed/u);
      stage('fifth-cancelled-claim-is-quarantined-and-live-lease-blocks-manual-requeue');

      await sql.unsafe(`UPDATE ${schema}.shared_key_usage_repair_jobs
        SET claim_expires_at=pg_catalog.clock_timestamp()-interval '1 second'
        WHERE shared_key_id='bad-key'`);
      await sql.begin(async tx => {
        await tx.unsafe(`SET LOCAL cinatoken.shared_key_usage_repair_requeue_activation='reviewed-v3'`);
        assert.equal((await tx.unsafe(`SELECT ${schema}.requeue_shared_key_usage_repair_dead_letter(
          'bad-key',$1) AS recovered`, [dead.failure_token]))[0].recovered, true);
      });
      await sql.unsafe(`DROP TRIGGER slow_bad_projection ON ${schema}.shared_keys;
        DROP FUNCTION ${schema}.slow_bad_projection();`).simple();
      const recovered = await claim(sql);
      assert.equal(recovered.shared_key_id, 'bad-key');
      assert.equal((await finish(sql, recovered.shared_key_id, recovered.claim_token)).outcome, 'repaired');
      const [final] = await sql.unsafe(`SELECT
        (SELECT served_input_tokens::text FROM ${schema}.shared_keys WHERE id='bad-key') AS projected,
        (SELECT count(*)::int FROM ${schema}.shared_key_usage_repair_jobs) AS jobs,
        (SELECT count(*)::int FROM ${schema}.shared_key_earnings) AS earnings,
        (SELECT lifetime_earned::text FROM ${schema}.user_earnings WHERE user_id='seller') AS seller_total`);
      assert.deepEqual(final, { projected: '150', jobs: 0, earnings: 6,
        seller_total: '0.240000' });
      stage('expired-dead-letter-requeue-recovers-projection-without-credit-replay');
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
      console.log('Native shared-key usage repair durable-claim report: ' + reportPath);
    }
    if (failure) throw failure;
  });
