// Review-only owned PG18.6 loopback fixture. Synthetic keys, quote and request
// IDs only; no ambient database URL, remote SQL or production credentials.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { claimPostgresSharedKeyQuoteAttempt } from '../../../packages/proxy/src/services/shared-key-quote-attempt.ts';

const gateway = 'cinatoken_gateway';
const quotes = 'cinatoken_economic_quotes';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const quoteProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-quote-versions.sql', import.meta.url);
const attemptProposal = new URL('../../../packages/core/migrations-proposals/postgres/shared-key-dispatch-quote-attempts.sql', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const errorInfo = error => ({ code: error?.code ?? null, constraint: error?.constraint_name ?? null,
  message: String(error?.message ?? error).slice(0, 350) });

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `cinatoken-quote-attempt-v339-${label}` } });
}

async function rejectCode(work, code, constraint) {
  await assert.rejects(work, error => {
    assert.equal(error?.code, code, String(error?.message ?? error));
    if (constraint) assert.equal(error?.constraint_name, constraint);
    return true;
  });
}

async function install(sql, body, setting, enabled = true) {
  await sql.begin(async tx => {
    if (enabled) await tx.unsafe(`SET LOCAL ${setting}`);
    await tx.unsafe(body).simple();
  });
}

test('native PG18 direct quote LOGIN captures exact pre-send references and fences late claims',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-shared-key-quote-attempt-v339-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'private PG18.6, 73 formal migrations, v338 quotes, v339 pre-send claim; review only',
      stages: [], limitations: [
        'A captured quote is not proof of network send, billable usage or completed buyer log.',
        'The opt-in Chat route requires a separate economic producer; shipped production options provide none.',
        'An ACK-unknown claim cannot be retried after reprice/revoke to recover an old row; stop dispatch and inspect as migrator.',
        'No typed outbox/consumer, D1/MySQL equivalent, Workers/Hyperdrive or production deployment is proven here.',
      ], sourceSha256: {} };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      const migratorPassword = randomBytes(24).toString('hex');
      const runtimePassword = randomBytes(24).toString('hex');
      const producerPassword = randomBytes(24).toString('hex');
      const otherPassword = randomBytes(24).toString('hex');
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${migratorPassword}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${runtimePassword}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${producerPassword}';
        CREATE ROLE quote_other LOGIN PASSWORD '${otherPassword}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime, cinatoken_gateway_shared_quote_attempt_producer, quote_other;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'migrator');
      const competing = client(cluster, 'cinatoken_gateway_migrator', migratorPassword, 'competing');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', runtimePassword, 'runtime');
      const producer = client(cluster, 'cinatoken_gateway_shared_quote_attempt_producer', producerPassword, 'producer');
      const other = client(cluster, 'quote_other', otherPassword, 'other');
      clients.push(migrator, competing, runtime, producer, other);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations (
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      stage('all-formal-migrations-installed', { migrations: files.length });
      await migrator.unsafe(`INSERT INTO ${gateway}.users(id,email) VALUES
        ('quote-seller-a','seller-a@example.invalid'),
        ('quote-seller-b','seller-b@example.invalid');
        INSERT INTO ${gateway}.shared_keys
          (id,seller_user_id,channel_type,api_key,key_fingerprint,status)
          VALUES ('quote-key-a','quote-seller-a','openai','synthetic-a','fingerprint-a','active');`).simple();
      const quoteBody = await readFile(quoteProposal, 'utf8');
      const attemptBody = await readFile(attemptProposal, 'utf8');
      report.sourceSha256 = { quoteProposal: sha(quoteBody), attemptProposal: sha(attemptBody),
        nativeTest: sha(await readFile(new URL(import.meta.url))),
        formalMigrationCorpus: sha(corpus.join('\n')) };
      await install(migrator, quoteBody,
        "cinatoken.shared_key_quote_versions_activation = 'reviewed-v2'");
      const version = 'quote-version-a';
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_versions
        (version_id,shared_key_id,seller_user_id,input_price_per_million,
          output_price_per_million,cache_read_price_per_million,
          cache_write_price_per_million,commission_rate,currency,price_unit,
          billing_mode,entitlement_version)
        VALUES ($1,'quote-key-a','quote-seller-a',1.25,2.5,0.1,0.2,0.1,
          'USD','per_million_tokens','shared_seller_key','entitlement-v1')`, [version]);
      await migrator.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('transition-a','quote-key-a',NULL,'activate',$1,'quote-seller-a')`, [version]);
      stage('reviewed-quote-proposal-installed-with-synthetic-active-head');

      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'", false),
      /activation or role contract differs/);
      await migrator.unsafe(`ALTER TABLE ${quotes}.shared_key_quote_versions
        DISABLE TRIGGER shared_key_quote_versions_no_change`);
      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'"),
      /trigger catalog differs/);
      await migrator.unsafe(`ALTER TABLE ${quotes}.shared_key_quote_versions
        ENABLE TRIGGER shared_key_quote_versions_no_change`);
      const immutableFunction = (await migrator.unsafe(`SELECT
        pg_catalog.pg_get_functiondef(
          '${quotes}.reject_shared_key_quote_mutation()'::pg_catalog.regprocedure) AS ddl`))[0].ddl;
      await migrator.unsafe(`CREATE OR REPLACE FUNCTION
        ${quotes}.reject_shared_key_quote_mutation()
        RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY INVOKER
        SET search_path TO pg_catalog, pg_temp AS $$
        BEGIN RETURN NULL; END;
        $$;`).simple();
      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'"),
      /function catalog differs/);
      await migrator.unsafe(immutableFunction).simple();
      stage('activation-disabled-trigger-and-noop-body-rejected');
      await migrator.unsafe(`GRANT SELECT ON ${quotes}.shared_key_quote_versions
        TO quote_other`);
      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'"),
      /quote private ACL differs/);
      await migrator.unsafe(`REVOKE SELECT ON ${quotes}.shared_key_quote_versions
        FROM quote_other`);
      stage('third-role-access-to-quote-dependency-rejected');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        GRANT SELECT ON TABLES TO quote_other;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        GRANT EXECUTE ON FUNCTIONS TO quote_other;`).simple();
      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'"),
      /attempt ACL is wider than reviewed contract/);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        REVOKE SELECT ON TABLES FROM quote_other;
        ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        REVOKE EXECUTE ON FUNCTIONS FROM quote_other;`).simple();
      stage('hostile-third-role-default-table-and-function-acl-roll-back-install');
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        GRANT EXECUTE ON FUNCTIONS TO
          cinatoken_gateway_shared_quote_attempt_producer WITH GRANT OPTION`);
      await assert.rejects(install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'"),
      /attempt ACL is wider than reviewed contract/);
      await migrator.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotes}
        REVOKE EXECUTE ON FUNCTIONS FROM
          cinatoken_gateway_shared_quote_attempt_producer`);
      stage('producer-grant-option-default-acl-rolls-back-install');
      await install(migrator, attemptBody,
        "cinatoken.shared_quote_attempt_activation = 'reviewed-v1'");
      stage('dedicated-claim-contract-installed');

      const acl = (await migrator.unsafe(`SELECT
        pg_catalog.has_schema_privilege('cinatoken_gateway_shared_quote_attempt_producer',
          '${quotes}','USAGE') AS schema_usage,
        pg_catalog.has_table_privilege('cinatoken_gateway_shared_quote_attempt_producer',
          '${quotes}.shared_key_dispatch_quote_attempts','SELECT') AS direct_select,
        pg_catalog.has_table_privilege('cinatoken_gateway_shared_quote_attempt_producer',
          '${quotes}.shared_key_dispatch_quote_attempts','INSERT') AS direct_insert,
        pg_catalog.has_schema_privilege('cinatoken_gateway_runtime',
          '${quotes}','USAGE') AS ordinary_runtime_usage`))[0];
      assert.deepEqual(acl, { schema_usage: true, direct_select: false,
        direct_insert: false, ordinary_runtime_usage: false });
      await rejectCode(runtime.unsafe(`SELECT * FROM ${quotes}.shared_key_dispatch_quote_attempts`), '42501');
      await rejectCode(producer.unsafe(`SELECT * FROM ${quotes}.shared_key_dispatch_quote_attempts`), '42501');
      await rejectCode(other.unsafe(`SELECT * FROM ${quotes}.claim_shared_key_dispatch_quote_attempt(
        $1::uuid,$2::text,$3::integer,$4::text,$5::text)`,
      [randomUUID(), 'request-other', 1, 'quote-key-a', 'target-a']), '42501');
      stage('direct-login-execute-only-and-runtime-table-denial', { acl });

      const attemptId = randomUUID();
      const input = { attemptId, requestLogId: 'request-a', attemptIndex: 1,
        sharedKeyId: 'quote-key-a', routeTargetId: 'target-a' };
      const captured = await claimPostgresSharedKeyQuoteAttempt(producer, input);
      assert.equal(captured.requestLogId, 'request-a');
      assert.equal(captured.transitionId, 'transition-a');
      assert.equal(captured.quoteVersionId, version);
      assert.equal(captured.sellerUserId, 'quote-seller-a');
      assert.equal(captured.attemptIndex, 1);
      const replay = await claimPostgresSharedKeyQuoteAttempt(producer, input);
      assert.deepEqual(replay, captured);
      stage('one-transaction-claim-and-immutable-exact-reference-idempotency');
      await rejectCode(claimPostgresSharedKeyQuoteAttempt(producer,
        { ...input, routeTargetId: 'target-other' }), '23514', 'shared_quote_attempt_identity');
      await rejectCode(claimPostgresSharedKeyQuoteAttempt(producer,
        { ...input, attemptId: randomUUID() }), '23505', 'shared_quote_attempt_request_index');
      assert.equal((await migrator.unsafe(`SELECT count(*)::int AS n FROM
        ${quotes}.shared_key_dispatch_quote_attempts`))[0].n, 1);
      stage('same-attempt-mismatch-and-request-index-swap-rejected');

      let lockedResolve;
      let releaseClaim;
      const locked = new Promise(resolve => { lockedResolve = resolve; });
      const hold = new Promise(resolve => { releaseClaim = resolve; });
      const transaction = producer.begin(async tx => {
        await tx.unsafe(`SELECT * FROM ${quotes}.claim_shared_key_dispatch_quote_attempt(
          $1::uuid,$2::text,$3::integer,$4::text,$5::text)`,
        [randomUUID(), 'request-race', 1, 'quote-key-a', 'target-race']);
        lockedResolve();
        await hold;
      });
      await locked;
      const revoke = Promise.resolve(competing.unsafe(`INSERT INTO ${quotes}.shared_key_quote_transitions
        (transition_id,shared_key_id,supersedes_transition_id,transition_kind,
          quote_version_id,seller_user_id)
        VALUES ('transition-revoke','quote-key-a','transition-a','revoke',NULL,
          'quote-seller-a')`));
      let sawWait = false;
      try {
        for (let i = 0; i < 50; i++) {
          const waiting = await migrator.unsafe(`SELECT wait_event_type
            FROM pg_catalog.pg_stat_activity
            WHERE application_name = 'cinatoken-quote-attempt-v339-competing'
            AND wait_event_type = 'Lock'`);
          if (waiting.length > 0) { sawWait = true; break; }
          await delay(20);
        }
      } finally {
        releaseClaim();
      }
      await transaction;
      await revoke;
      assert.equal(sawWait, true, 'revoke must wait behind the claimed Key lock');
      await rejectCode(claimPostgresSharedKeyQuoteAttempt(producer,
        { attemptId: randomUUID(), requestLogId: 'request-revoked',
          attemptIndex: 1, sharedKeyId: 'quote-key-a', routeTargetId: 'target-a' }),
      '23514', 'shared_quote_attempt_unavailable');
      await rejectCode(claimPostgresSharedKeyQuoteAttempt(producer, input),
        '23514', 'shared_quote_attempt_unavailable');
      assert.equal((await migrator.unsafe(`SELECT quote_version_id FROM
        ${quotes}.shared_key_dispatch_quote_attempts WHERE attempt_id=$1`,
      [attemptId]))[0].quote_version_id, version);
      stage('revoke-serializes-after-capture-and-old-reference-remains-readable');

      await migrator.unsafe(`INSERT INTO ${gateway}.workspaces
        (id,scope_type,personal_owner_user_id,name,slug,is_default,default_scope_key)
        VALUES ('personal:quote-seller-a','personal','quote-seller-a','Default',
          'default',true,'personal:quote-seller-a');
        INSERT INTO ${gateway}.api_keys(id,key,key_hash,user_id,workspace_id)
        VALUES ('synthetic-gateway-key','hashref:sha256:synthetic','synthetic',
          'quote-seller-a','personal:quote-seller-a');
        INSERT INTO ${gateway}.api_key_request_logs
          (id,user_id,api_key_id,workspace_id)
        VALUES ('request-after-log','quote-seller-a','synthetic-gateway-key',
          'personal:quote-seller-a');`).simple();
      await rejectCode(claimPostgresSharedKeyQuoteAttempt(producer,
        { attemptId: randomUUID(), requestLogId: 'request-after-log',
          attemptIndex: 1, sharedKeyId: 'quote-key-a', routeTargetId: 'target-a' }),
      '23514', 'shared_quote_attempt_after_log');
      stage('post-log-claim-rejected-before-quote-selection');
      for (const command of [
        `UPDATE ${quotes}.shared_key_dispatch_quote_attempts SET route_target_id=route_target_id WHERE attempt_id='${attemptId}'`,
        `DELETE FROM ${quotes}.shared_key_dispatch_quote_attempts WHERE attempt_id='${attemptId}'`,
      ]) await rejectCode(migrator.unsafe(command), '23514', 'shared_quote_attempts_append_only');
      stage('captured-attempt-reference-is-append-only');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL'; report.error = errorInfo(error);
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = errorInfo(error); failure ??= error; }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native shared-key dispatch quote attempt report: ' + reportPath);
    }
    if (failure) throw failure;
  });
