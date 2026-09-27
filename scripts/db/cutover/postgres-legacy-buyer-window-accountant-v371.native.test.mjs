// Owned PostgreSQL 18.6 proof for v371's window-creation serialization.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';

const g = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const oldSqlUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-held-writer-v368.sql', import.meta.url);
const proposalUrl = new URL('../../../packages/core/migrations-proposals/postgres/complete-text-legacy-buyer-window-accountant-v371.sql', import.meta.url);
const reportUrl = new URL('../../../docs/developers/architecture/implementation-evidence/C04-legacy-buyer-window-accountant-v371-report.json', import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const dayStart = new Date(Date.now());
dayStart.setUTCHours(0, 0, 0, 0);
const periodStart = dayStart.toISOString();
const periodEnd = new Date(dayStart.getTime() + 86_400_000).toISOString();
const accountedAt = new Date(dayStart.getTime() + 12 * 3_600_000).toISOString();
const expiresAt = new Date(Date.now() + 60_000).toISOString();

function connection(cluster, name, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: name, password, ssl: false, max: 1, prepare: false,
    fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: false, onnotice() {},
    connection: { application_name: `v371-${label}`, search_path: `${g},public` } });
}
async function rejected(work, code, constraint) {
  await assert.rejects(work, error => {
    const cause = error?.cause ?? error;
    assert.equal(cause.code, code, String(error));
    if (constraint) assert.equal(cause.constraint_name, constraint);
    return true;
  });
}
async function waitForBlock(admin, blockedPid, blockerPid) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await admin.unsafe(`SELECT pg_catalog.pg_blocking_pids($1) AS blockers`,
      [blockedPid]);
    if (row.blockers.includes(blockerPid)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Expected backend ${blockedPid} to wait for ${blockerPid}`);
}

test('v371 held plus unreserved accounting covers both window creation orders',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      limitations: [
        'Review-only PG73-local SQL proposal; no formal migration, remote SQL, Worker, Provider or production credential changed.',
        'The native fixture installs the exact v368 function body on full PG73 tables with a minimal v362 grant table, but does not install every v351–v368 proposal or the real economic event producer.',
        'The buyer log and its actual charge are still caller supplied; no immutable final result or trusted Provider bill authenticates the amount.',
        'The global SHARE ROW EXCLUSIVE window-table lock serializes all writers and may cause capacity loss or deadlock retries. Production-scale contention and complete writer cutover remain unproven.',
        'Only the narrow non-grant, current-epoch, charged-basis held actual path is covered; reserved, old-epoch, late actual, BYOK, recovery, no-hold and event replay need successors.'
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const passwords = Object.fromEntries(['migrator', 'buyer', 'runtime'].map(x =>
        [x, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN
          PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT
          PASSWORD '${passwords.buyer}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN NOINHERIT
          PASSWORD '${passwords.runtime}';
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_buyer_settlement,cinatoken_gateway_runtime;
        GRANT USAGE ON SCHEMA ${g} TO cinatoken_gateway_buyer_settlement,
          cinatoken_gateway_runtime;`).simple();
      const migrator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'migrator');
      const buyer = connection(cluster, 'cinatoken_gateway_buyer_settlement',
        passwords.buyer, 'buyer');
      const creator = connection(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'creator');
      const runtime = connection(cluster, 'cinatoken_gateway_runtime',
        passwords.runtime, 'runtime');
      clients.push(migrator, buyer, creator, runtime);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const names = (await readdir(migrations)).filter(x => x.endsWith('.sql')).sort();
      assert.equal(names.length, 73);
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES($1)`,
            [name]);
        });
      }
      report.sourceSha256.formalMigrations = sha(corpus.join('\n'));
      stage('full-formal-pg73-schema-installed');

      // The v368 function's runtime body is exact. The preceding fixture
      // already proves the full v368 proposal installation and ACL policy.
      await migrator.unsafe(`CREATE TABLE ${g}.complete_text_attempt_grants_v362
        (request_id text PRIMARY KEY)`);
      const oldSource = await readFile(oldSqlUrl, 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-held-writer-v368.sql'] = sha(oldSource);
      const begin = oldSource.indexOf(`CREATE FUNCTION ${g}.settle_legacy_buyer_held_v368(`);
      const end = oldSource.indexOf('$settle$;', begin) + '$settle$;'.length;
      assert.ok(begin >= 0 && end > begin);
      await migrator.unsafe(oldSource.slice(begin, end)).simple();
      await migrator.unsafe(`REVOKE ALL ON FUNCTION
          ${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION
          ${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)
          TO cinatoken_gateway_buyer_settlement;
        GRANT INSERT ON ${g}.api_key_request_logs
          TO cinatoken_gateway_buyer_settlement;
        GRANT SELECT ON ${g}.api_keys
          TO cinatoken_gateway_buyer_settlement;`).simple();
      const [sourcePin] = await migrator.unsafe(`SELECT
        pg_catalog.md5(pg_catalog.replace(p.prosrc,
          pg_catalog.chr(13)||pg_catalog.chr(10),pg_catalog.chr(10))) AS digest
        FROM pg_catalog.pg_proc p WHERE p.oid=
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)'
            ::pg_catalog.regprocedure`);
      assert.equal(sourcePin.digest, 'abeb0cc33ab91be53a41e42c8f8aeb16');
      stage('exact-v368-held-body-and-restricted-buyer-log-writer-installed');

      const successor = await readFile(proposalUrl, 'utf8');
      report.sourceSha256['complete-text-legacy-buyer-window-accountant-v371.sql'] =
        sha(successor);
      report.sourceSha256.fixture = sha(await readFile(new URL(import.meta.url)));
      await rejected(migrator.begin(tx => tx.unsafe(successor).simple()), 'P0001');
      const [beforeInstall] = await migrator.unsafe(`SELECT
        pg_catalog.to_regprocedure('${g}.settle_legacy_buyer_windowed_v371(text,text)')
          IS NULL AS no_wrapper,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS old_callable`);
      assert.deepEqual(beforeInstall, { no_wrapper: true, old_callable: true });
      await migrator.begin(async tx => {
        await tx.unsafe(`SET LOCAL
          cinatoken.legacy_buyer_window_accountant_v371_activation='reviewed-v1'`);
        await tx.unsafe(successor).simple();
      });
      const [acl] = await migrator.unsafe(`SELECT
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_windowed_v371(text,text)','EXECUTE') AS new_call,
        pg_catalog.has_function_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.settle_legacy_buyer_held_v368(text,bigint,bigint,text)',
          'EXECUTE') AS old_call,
        pg_catalog.has_table_privilege('cinatoken_gateway_buyer_settlement',
          '${g}.guardrail_budget_windows','UPDATE') AS raw_update,
        (SELECT count(*)::integer FROM pg_catalog.pg_trigger
          WHERE tgname='seed_guardrail_window_unreserved_v371'
            AND tgenabled='O' AND NOT tgisinternal) AS seed_triggers`);
      assert.deepEqual(acl, { new_call: true, old_call: false,
        raw_update: false, seed_triggers: 1 });
      await rejected(buyer.unsafe(`UPDATE ${g}.guardrail_budget_windows
        SET unreserved_micros=unreserved_micros+1 WHERE false`), '42501');
      await rejected(buyer.unsafe(`SELECT ${g}.settle_legacy_buyer_held_v368(
        'missing',1,1,'bypass')`), '42501');
      await rejected(runtime.unsafe(`SELECT ${g}.settle_legacy_buyer_windowed_v371(
        'missing','bypass')`), '42501');
      stage('default-off-and-successor-ACL-revoke-raw-old-bypass', { acl });

      const insertWindow = async (sql, scenario, scopeType, scopeId) =>
        sql.unsafe(`INSERT INTO ${g}.guardrail_budget_windows
          (workspace_id,scope_type,scope_id,period,period_start,period_end,
            unreserved_micros,settled_micros,reserved_micros,seeded_at,updated_at)
          VALUES($1,$2,$3,'daily',$4,$5,0,0,0,now(),now())`,
        [scenario.workspace, scopeType, scopeId, periodStart, periodEnd]);
      const seed = async label => {
        const scenario = { requestId: `v371-${label}`, user: `v371-user-${label}`,
          key: `v371-key-${label}`, workspace: `v371-workspace-${label}` };
        const keyHash = `sha256:${sha(`v371-${label}-bearer`)}`;
        await migrator.unsafe(`INSERT INTO ${g}.users
          (id,email,budget_max,budget_reserved_micros)
          VALUES($1,$2,10,10)`,
        [scenario.user, `${label}@example.invalid`]);
        await migrator.unsafe(`INSERT INTO ${g}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES($1,'personal',$2,$3,$4,'active')`,
        [scenario.workspace, scenario.user, label, label]);
        await migrator.unsafe(`INSERT INTO ${g}.api_keys
          (id,key,key_hash,user_id,workspace_id,status)
          VALUES($1,$2,$3,$4,$5,'active')`,
        [scenario.key, `hashref:${keyHash}`, keyHash, scenario.user,
          scenario.workspace]);
        await insertWindow(migrator, scenario, 'user', scenario.user);
        await migrator.unsafe(`UPDATE ${g}.guardrail_budget_windows
          SET reserved_micros=10 WHERE workspace_id=$1 AND scope_type='user'
            AND scope_id=$2`, [scenario.workspace, scenario.user]);
        await insertWindow(migrator, scenario, 'workspace', scenario.workspace);
        await insertWindow(migrator, scenario, 'user', `unrelated-${label}`);
        await migrator.unsafe(`INSERT INTO ${g}.user_budget_reservations
          (request_id,user_id,api_key_id,budget_epoch,limit_micros,
            reserved_micros,settled_micros,state,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,0,1000000,10,0,'reserved',$4,now(),now())`,
        [scenario.requestId, scenario.user, scenario.key, expiresAt]);
        await migrator.unsafe(`INSERT INTO ${g}.guardrail_budget_reservations
          (id,workspace_id,request_id,assignment_id,guardrail_id,
            guardrail_version,scope_type,scope_id,period,period_start,
            period_end,limit_micros,reserved_micros,settled_micros,
            settlement_basis,state,expires_at,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,1,'user',$6,'daily',$7,$8,
            1000000,10,0,'charged','reserved',$9,now(),now())`,
        [`hold-${label}`, scenario.workspace, scenario.requestId,
          `assignment-${label}`, `guardrail-${label}`, scenario.user,
          periodStart, periodEnd, expiresAt]);
        return scenario;
      };
      const insertLog = (sql, scenario, overrides = {}) => sql.unsafe(`INSERT INTO
        ${g}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,
          budget_charged_micros,budget_accounted_at,is_byok,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [scenario.requestId, scenario.user, scenario.key, scenario.workspace,
        overrides.chargedCost ?? '0.000001', overrides.micros ?? 1,
        accountedAt, overrides.isByok ?? false, overrides.status ?? 'success']);
      const settle = async (sql, scenario) => {
        const [row] = await sql.unsafe(`SELECT
          ${g}.settle_legacy_buyer_windowed_v371($1,'native_actual') AS value`,
        [scenario.requestId]);
        assert.equal(row.value.status, 'windowed_legacy_settled');
        assert.equal(row.value.chargeMicros, 1);
        assert.equal(row.value.guardrailRows, 1);
        return row.value;
      };
      const snapshot = async scenario => {
        const [row] = await migrator.unsafe(`SELECT
          (SELECT budget_spent::text FROM ${g}.users WHERE id=$1) AS spent,
          (SELECT budget_reserved_micros::text FROM ${g}.users WHERE id=$1)
            AS reserved,
          (SELECT state FROM ${g}.user_budget_reservations WHERE request_id=$2)
            AS ordinary,
          (SELECT state FROM ${g}.guardrail_budget_reservations WHERE request_id=$2)
            AS guardrail,
          (SELECT count(*)::integer FROM ${g}.api_key_request_logs WHERE id=$2)
            AS logs`, [scenario.user, scenario.requestId]);
        const windows = await migrator.unsafe(`SELECT scope_type,scope_id,
          unreserved_micros::text AS unreserved,
          settled_micros::text AS settled,reserved_micros::text AS reserved
          FROM ${g}.guardrail_budget_windows WHERE workspace_id=$1
          ORDER BY scope_type,scope_id`, [scenario.workspace]);
        return { ...row, windows };
      };
      const [buyerPid] = await buyer.unsafe('SELECT pg_catalog.pg_backend_pid() AS pid');
      const [creatorPid] = await creator.unsafe('SELECT pg_catalog.pg_backend_pid() AS pid');

      const before = await seed('creator-before-lock');
      let creatorReady;
      const creatorStarted = new Promise(resolve => { creatorReady = resolve; });
      let releaseCreator;
      const creatorGate = new Promise(resolve => { releaseCreator = resolve; });
      const heldCreator = creator.begin(async tx => {
        await insertWindow(tx, before, 'api_key', before.key);
        creatorReady();
        await creatorGate;
      });
      await creatorStarted;
      const waitingBuyer = buyer.begin(async tx => {
        await insertLog(tx, before);
        return settle(tx, before);
      });
      try { await waitForBlock(cluster.admin, buyerPid.pid, creatorPid.pid); }
      finally { releaseCreator(); }
      const [, beforeValue] = await Promise.all([heldCreator, waitingBuyer]);
      assert.equal(beforeValue.unreservedWindowRows, 2);
      const beforeState = await snapshot(before);
      assert.equal(beforeState.ordinary, 'settled');
      assert.equal(beforeState.guardrail, 'settled');
      assert.equal(beforeState.logs, 1);
      assert.deepEqual(beforeState.windows.map(w =>
        [w.scope_type, w.scope_id, w.unreserved, w.settled]), [
        ['api_key', before.key, '1', '0'],
        ['user', `unrelated-creator-before-lock`, '0', '0'],
        ['user', before.user, '0', '1'],
        ['workspace', before.workspace, '1', '0'],
      ]);
      stage('creator-commits-before-lock-buyer-sees-and-accounts-window',
        { blockedBuyerPid: buyerPid.pid, unreservedWindowRows: 2 });

      const after = await seed('creator-after-lock');
      let buyerReady;
      const buyerStarted = new Promise(resolve => { buyerReady = resolve; });
      let releaseBuyer;
      const buyerGate = new Promise(resolve => { releaseBuyer = resolve; });
      const heldBuyer = buyer.begin(async tx => {
        await insertLog(tx, after);
        const value = await settle(tx, after);
        buyerReady(value);
        await buyerGate;
      });
      const afterValue = await buyerStarted;
      assert.equal(afterValue.unreservedWindowRows, 1);
      const waitingCreator = insertWindow(creator, after, 'api_key', after.key);
      try { await waitForBlock(cluster.admin, creatorPid.pid, buyerPid.pid); }
      finally { releaseBuyer(); }
      await Promise.all([heldBuyer, waitingCreator]);
      const afterState = await snapshot(after);
      assert.deepEqual(afterState.windows.map(w =>
        [w.scope_type, w.scope_id, w.unreserved, w.settled]), [
        ['api_key', after.key, '1', '0'],
        ['user', `unrelated-creator-after-lock`, '0', '0'],
        ['user', after.user, '0', '1'],
        ['workspace', after.workspace, '1', '0'],
      ]);
      stage('creator-after-lock-waits-for-commit-and-seeds-from-buyer-log',
        { blockedCreatorPid: creatorPid.pid, unreservedWindowRows: 1 });

      const stable = await snapshot(before);
      await rejected(buyer.begin(async tx => settle(tx, before)), '23514',
        'legacy_buyer_hold_v368');
      assert.deepEqual(await snapshot(before), stable);
      stage('terminal-replay-cannot-double-debit-held-or-unreserved-windows');

      const rollback = await seed('rollback');
      const beforeRollback = await snapshot(rollback);
      await assert.rejects(buyer.begin(async tx => {
        await insertLog(tx, rollback);
        await settle(tx, rollback);
        throw new Error('v371-deliberate-outer-rollback');
      }), /v371-deliberate-outer-rollback/u);
      assert.deepEqual(await snapshot(rollback), beforeRollback);
      stage('outer-rollback-restores-log-account-holds-and-windows');

      const wrong = await seed('wrong-amount');
      const beforeWrong = await snapshot(wrong);
      await rejected(buyer.begin(async tx => {
        await insertLog(tx, wrong, { chargedCost: '0.000002' });
        await settle(tx, wrong);
      }), '23514', 'legacy_buyer_log_v371');
      assert.deepEqual(await snapshot(wrong), beforeWrong);
      const byok = await seed('byok');
      const beforeByok = await snapshot(byok);
      await rejected(buyer.begin(async tx => {
        await insertLog(tx, byok, { isByok: true });
        await settle(tx, byok);
      }), '23514', 'legacy_buyer_log_v371');
      assert.deepEqual(await snapshot(byok), beforeByok);
      stage('wrong-charge-and-byok-rejected-before-financial-writes');

      await rejected(insertWindow(migrator, after, 'workspace',
        'spoofed-workspace-scope'), '23514', 'guardrail_window_seed_v371');
      const mismatch = await seed('mismatched-history');
      await migrator.unsafe(`INSERT INTO ${g}.api_key_request_logs
        (id,user_id,api_key_id,workspace_id,charged_cost,
          budget_charged_micros,budget_accounted_at,is_byok,status)
        VALUES($1,$2,$3,$4,0.000002,1,$5,false,'success')`,
      [`history-${mismatch.requestId}`, mismatch.user, mismatch.key,
        mismatch.workspace, accountedAt]);
      await rejected(insertWindow(migrator, mismatch, 'api_key', mismatch.key),
        '23514', 'guardrail_window_seed_v371');
      stage('workspace-scope-spoof-and-mismatched-positive-history-denied');

      const timeout = await seed('lock-timeout');
      const beforeTimeout = await snapshot(timeout);
      let creatorLockReady;
      const locked = new Promise(resolve => { creatorLockReady = resolve; });
      let releaseCreatorLock;
      const creatorLockGate = new Promise(resolve => { releaseCreatorLock = resolve; });
      const tableHolder = creator.begin(async tx => {
        await tx.unsafe(`LOCK TABLE ${g}.guardrail_budget_windows
          IN ROW EXCLUSIVE MODE`);
        creatorLockReady();
        await creatorLockGate;
      });
      await locked;
      try {
        await rejected(buyer.begin(async tx => {
          await insertLog(tx, timeout);
          await settle(tx, timeout);
        }), '55P03');
      } finally { releaseCreatorLock(); }
      await tableHolder;
      assert.deepEqual(await snapshot(timeout), beforeTimeout);
      stage('contended-window-table-lock-times-out-and-rolls-back-buyer');

      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 5000) };
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL';
        report.cleanupError = String(error).slice(0, 1500);
        failure ??= error; }
      await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`legacy-buyer-window-accountant-v371-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
  });
