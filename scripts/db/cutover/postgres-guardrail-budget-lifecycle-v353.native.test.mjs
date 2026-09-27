// Owned PostgreSQL 18.6 proof of Guardrail terminal lifecycle functions under a direct LOGIN.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { openPostgresGuardrailBudgetLifecycleOwnerV353 } from '../../../packages/proxy/src/services/postgres-guardrail-budget-lifecycle-v353.ts';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { grantPostgresBuyerSplitV348 } from './grant-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerSplitV348 } from './activate-postgres-buyer-split-v348.ts';
import { activatePostgresBuyerGuardrailSplitV349 } from './activate-postgres-buyer-guardrail-split-v349.ts';
import { grantPostgresBuyerGuardrailSplitV349 } from './grant-postgres-buyer-guardrail-split-v349.ts';

const gateway = 'cinatoken_gateway';
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = new URL('../../../packages/core/migrations-proposals/postgres/', import.meta.url);
const prerequisites = [
  ['shared-key-quote-versions.sql', 'shared_key_quote_versions_activation', 'reviewed-v2'],
  ['shared-key-dispatch-quote-attempts.sql', 'shared_quote_attempt_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox.sql', 'shared_key_economic_outbox_activation', 'reviewed-v1'],
  ['shared-key-economic-outbox-producer.sql', 'shared_key_economic_producer_activation', 'reviewed-v1'],
  ['shared-key-snapshot-earning-consumer.sql', 'shared_key_snapshot_consumer_activation', 'reviewed-v1'],
  ['shared-key-buyer-debit-v2.sql', 'shared_key_buyer_debit_v2_activation', 'reviewed-v1'],
  ['shared-key-economic-producer-v2.sql', 'shared_key_economic_producer_v2_activation', 'reviewed-v1'],
  ['shared-key-buyer-budget-receipt-v2.sql', 'shared_key_buyer_budget_receipt_activation', 'reviewed-v1'],
];
const hash = value => createHash('sha256').update(value).digest('hex');

function client(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `guardrail-lifecycle-v353-${label}` } });
}

async function expectCode(work, code) {
  await assert.rejects(work, error => {
    assert.equal((error?.cause ?? error)?.code, code, String(error));
    return true;
  });
}

test('Guardrail lifecycle LOGIN conservatively terminates multi-intent holds without raw DML',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-guardrail-budget-lifecycle-v353-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; PG73 plus v348/v349/v350/v351/v353 review-only proposals',
      limitations: [
        'No route, coordinator, Worker, Hyperdrive, formal migration, production credential, remote SQL, or deployment changed.',
        'Expiry is forced by a privileged migrator in this fixture; real elapsed lease time is not tested.',
        'Lost acknowledgement is simulated after a committed mark; no TCP connection loss is injected.',
        'Independent authenticated request identity, quote amount and route binding remain open.',
        'Dispatched BYOK-to-paid extension and buyer settlement are outside this fixture.',
        'The 200-per-state candidate result cap and matching PG73 index do not prove bounded physical I/O; a busy early prefix can defer later expiry.',
        'Held buyer-row tests are not an end-to-end critical-writer settlement/forfeit race; persistent owner retry and multi-intent lock-order review remain open.',
        'D1/MySQL parity, Linux CI and real UTC period-boundary execution are not tested.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let owner;
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const names = ['migrator', 'runtime', 'buyer_settlement', 'budget_admission',
        'shared_quote_attempt_producer', 'shared_earning_consumer'];
      const passwords = Object.fromEntries(names.map(name => [name,
        randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        CREATE ROLE cinatoken_gateway_buyer_settlement LOGIN NOINHERIT PASSWORD '${passwords.buyer_settlement}';
        CREATE ROLE cinatoken_gateway_budget_admission LOGIN NOINHERIT PASSWORD '${passwords.budget_admission}';
        CREATE ROLE cinatoken_gateway_shared_quote_attempt_producer LOGIN PASSWORD '${passwords.shared_quote_attempt_producer}';
        CREATE ROLE cinatoken_gateway_shared_earning_consumer LOGIN PASSWORD '${passwords.shared_earning_consumer}';
        CREATE SCHEMA ${gateway} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${names.map(name =>
          `cinatoken_gateway_${name}`).join(',')};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = client(cluster, 'cinatoken_gateway_migrator', passwords.migrator, 'migrator');
      const runtime = client(cluster, 'cinatoken_gateway_runtime', passwords.runtime, 'runtime');
      const buyer = client(cluster, 'cinatoken_gateway_buyer_settlement',
        passwords.buyer_settlement, 'buyer');
      const admission = client(cluster, 'cinatoken_gateway_budget_admission',
        passwords.budget_admission, 'admission');
      clients.push(migrator, runtime, buyer, admission);
      await migrator.unsafe(`CREATE TABLE ${gateway}.schema_migrations
        (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrationNames = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(migrationNames.length, 73);
      const corpus = [];
      for (const name of migrationNames) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${gateway}.schema_migrations(version) VALUES($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrations = hash(corpus.join('\n'));
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${passwords.migrator}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      const runtimeUrl = `postgres://cinatoken_gateway_runtime:${passwords.runtime}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      const admissionUrl = `postgres://cinatoken_gateway_budget_admission:${passwords.budget_admission}`
        + `@127.0.0.1:${cluster.port}/postgres`;
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      for (const [name, setting, value] of prerequisites) {
        const body = await readFile(new URL(name, proposals), 'utf8');
        report.sourceSha256[name] = hash(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='${value}'`);
          await tx.unsafe(body).simple();
        });
      }
      await activatePostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      await grantPostgresBuyerSplitV348({ DATABASE_URL: migratorUrl });
      await activatePostgresBuyerGuardrailSplitV349({ DATABASE_URL: migratorUrl });
      await grantPostgresBuyerGuardrailSplitV349({ DATABASE_URL: migratorUrl });
      for (const [name, setting] of [
        ['budget-admission-login-v350.sql', 'budget_admission_login_activation'],
        ['guardrail-budget-admission-login-v351.sql', 'guardrail_budget_admission_v351_activation'],
      ]) {
        const body = await readFile(new URL(name, proposals), 'utf8');
        report.sourceSha256[name] = hash(body);
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL cinatoken.${setting}='reviewed-v1'`);
          await tx.unsafe(body).simple();
        });
      }
      stage('pg73-and-reviewed-v348-through-v351-prerequisites-installed');

      const proposal = await readFile(new URL('guardrail-budget-lifecycle-login-v353.sql', proposals), 'utf8');
      report.sourceSha256.lifecycleProposal = hash(proposal);
      report.sourceSha256.fixture = hash(await readFile(new URL(import.meta.url)));
      report.sourceSha256.lifecycleAdapter = hash(await readFile(new URL(
        '../../../packages/proxy/src/services/postgres-guardrail-budget-lifecycle-v353.ts',
        import.meta.url)));
      await assert.rejects(migrator.begin(tx => tx.unsafe(proposal).simple()),
        /activation|dependency/u);
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_lifecycle_v353_activation='reviewed-v1'");
        await tx.unsafe(proposal).simple();
      });
      const forfeitSignature = `${gateway}.forfeit_guardrail_budgets_v353(text,text)`;
      const expireSignature = `${gateway}.expire_guardrail_budgets_v353(integer)`;
      const acl = await migrator.unsafe(`SELECT roles.role_name,
          pg_catalog.has_function_privilege(roles.role_name,$1,'EXECUTE') AS forfeit_execute,
          pg_catalog.has_function_privilege(roles.role_name,$2,'EXECUTE') AS expire_execute,
          pg_catalog.has_table_privilege(roles.role_name,
            '${gateway}.guardrail_budget_windows','UPDATE') AS window_update,
          pg_catalog.has_table_privilege(roles.role_name,
            '${gateway}.guardrail_budget_reservations','UPDATE') AS reservation_update
        FROM (VALUES ('cinatoken_gateway_budget_admission'),
          ('cinatoken_gateway_runtime'),
          ('cinatoken_gateway_buyer_settlement')) AS roles(role_name)`,
      [forfeitSignature, expireSignature]);
      assert.equal(acl.length, 3);
      const byRole = Object.fromEntries(acl.map(row => [row.role_name, row]));
      assert.deepEqual(byRole.cinatoken_gateway_budget_admission,
        { role_name: 'cinatoken_gateway_budget_admission',
          forfeit_execute: true, expire_execute: true,
          window_update: false, reservation_update: false });
      for (const role of ['cinatoken_gateway_runtime', 'cinatoken_gateway_buyer_settlement']) {
        assert.equal(byRole[role].forfeit_execute, false);
        assert.equal(byRole[role].expire_execute, false);
      }
      await expectCode(runtime.unsafe(`SELECT ${gateway}.forfeit_guardrail_budgets_v353(
        'forged','usage_unknown')`), '42501');
      await expectCode(buyer.unsafe(`SELECT ${gateway}.expire_guardrail_budgets_v353(1)`), '42501');
      for (const sql of [admission, runtime]) {
        await expectCode(sql.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
          SET reserved_micros=reserved_micros WHERE false`), '42501');
        await expectCode(sql.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
          SET state=state WHERE false`), '42501');
      }
      stage('default-off-install-and-function-only-ACL-for-direct-admission-LOGIN', { acl });

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent)
          VALUES('v353-user','v353-user@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v353-workspace','personal','v353-user','V353','v353','active');
        INSERT INTO ${gateway}.api_keys
          (id,key,user_id,workspace_id,limit_micros,limit_reset)
          VALUES('v353-key','synthetic-v353-key','v353-user','v353-workspace',
            2000000,'daily');
        INSERT INTO ${gateway}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v353-budget','v353-workspace','daily',2000000);`).simple();
      const at = new Date();
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      const end = new Date(start.getTime() + 86_400_000);
      const common = { workspaceId: 'v353-workspace', guardrailVersion: 1,
        period: 'daily', periodStart: start.toISOString(), periodEnd: end.toISOString(),
        limitMicros: 2_000_000 };
      const intents = [
        { ...common, assignmentId: 'workspace-budget:v353-budget',
          guardrailId: 'workspace-budget:v353-budget', scopeType: 'workspace', scopeId: 'v353-workspace' },
        { ...common, assignmentId: 'gateway-key-limit:v353-key',
          guardrailId: 'gateway-key-limit:v353-key', scopeType: 'api_key', scopeId: 'v353-key' },
      ];
      const now = () => new Date();
      const reserve = async (requestId, amount) => {
        const instant = now();
        const [row] = await admission.unsafe(`SELECT ${gateway}.reserve_guardrail_budgets_v351(
          $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,
        [requestId, 'v353-user', 'v353-key', admission.json(intents), amount, 'charged',
          instant.toISOString(), new Date(instant.getTime() + 120_000).toISOString()]);
        assert.deepEqual(row.result, { status: 'reserved', reservationCount: 2 });
      };
      const mark = async (requestId, expiryIso) => {
        const instant = now();
        const [row] = await admission.unsafe(`SELECT ${gateway}.mark_guardrail_budgets_dispatched_v351(
          $1,$2,$3) AS ok`,
        [requestId, instant.toISOString(),
          expiryIso ?? new Date(instant.getTime() + 900_000).toISOString()]);
        return row.ok;
      };
      const release = async requestId => {
        const [row] = await admission.unsafe(`SELECT ${gateway}.release_guardrail_budgets_v351(
          $1,$2,$3) AS count`, [requestId, now().toISOString(), 'pre_send_cancel']);
        return row.count;
      };
      const forfeit = async requestId => {
        const [row] = await admission.unsafe(`SELECT ${gateway}.forfeit_guardrail_budgets_v353(
          $1,$2) AS count`, [requestId, 'usage_unknown']);
        return row.count;
      };
      const expire = async limit => {
        const [row] = await admission.unsafe(`SELECT ${gateway}.expire_guardrail_budgets_v353(
          $1) AS count`, [limit]);
        return row.count;
      };
      const windows = async () => {
        const [row] = await migrator.unsafe(`SELECT count(*)::integer AS rows,
          coalesce(sum(reserved_micros),0)::bigint AS reserved,
          coalesce(sum(settled_micros),0)::bigint AS settled
          FROM ${gateway}.guardrail_budget_windows WHERE workspace_id='v353-workspace'`);
        return { rows: row.rows, reserved: Number(row.reserved), settled: Number(row.settled) };
      };
      const rows = requestId => migrator.unsafe(`SELECT state,
          reserved_micros::bigint AS reserved_micros,
          settled_micros::bigint AS settled_micros,
          terminal_reason FROM ${gateway}.guardrail_budget_reservations
          WHERE request_id=$1 ORDER BY assignment_id`, [requestId]);
      const assertRows = async (requestId, state, amount, settled, reason) => {
        const found = await rows(requestId);
        assert.equal(found.length, 2);
        for (const row of found) {
          assert.equal(row.state, state);
          assert.equal(Number(row.reserved_micros), amount);
          assert.equal(Number(row.settled_micros), settled);
          assert.equal(row.terminal_reason, reason);
        }
      };
      const withBuyerRowLock = async (requestId, count, check) => {
        let unlock;
        let readyResolve;
        let readyReject;
        const gate = new Promise(resolve => { unlock = resolve; });
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve; readyReject = reject;
        });
        const holding = buyer.begin(async tx => {
          await tx.unsafe(`SELECT id FROM ${gateway}.guardrail_budget_reservations
            WHERE request_id=$1 ORDER BY assignment_id LIMIT $2 FOR UPDATE`,
          [requestId, count]);
          readyResolve();
          await gate;
        });
        holding.catch(readyReject);
        await ready;
        try { return await check(); }
        finally { unlock(); await holding; }
      };

      const forfeitId = `v353-forfeit-${randomUUID()}`;
      await reserve(forfeitId, 400_000);
      assert.equal(await mark(forfeitId), true);
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros+1
        WHERE workspace_id='v353-workspace' AND scope_type='workspace'`);
      await expectCode(admission.unsafe(`SELECT ${gateway}.forfeit_guardrail_budgets_v353(
        $1,$2)`, [forfeitId, 'usage_unknown']), '23514');
      await assertRows(forfeitId, 'dispatched', 400_000, 0, null);
      assert.deepEqual(await windows(), { rows: 2, reserved: 800_001, settled: 0 },
        'the earlier key-window update must roll back when a later window is corrupt');
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros-1
        WHERE workspace_id='v353-workspace' AND scope_type='workspace'`);
      await withBuyerRowLock(forfeitId, 2, async () => {
        await admission.unsafe("SET statement_timeout='1500ms'");
        try {
          const started = Date.now();
          await expectCode(admission.unsafe(`SELECT ${gateway}.forfeit_guardrail_budgets_v353(
            $1,$2)`, [forfeitId, 'usage_unknown']), '55P03');
          assert.ok(Date.now() - started < 1500, 'forfeit must not wait on buyer rows');
          await assertRows(forfeitId, 'dispatched', 400_000, 0, null);
        } finally { await admission.unsafe('RESET statement_timeout'); }
      });
      assert.equal(await forfeit(forfeitId), 2);
      assert.equal(await forfeit(forfeitId), 0);
      await assertRows(forfeitId, 'expired', 400_000, 400_000, 'usage_unknown');
      assert.deepEqual(await windows(), { rows: 2, reserved: 0, settled: 800_000 });
      stage('two-dispatched-intents-forfeit-once-and-keep-full-ceiling');

      const reservedExpiryId = `v353-reserved-expiry-${randomUUID()}`;
      await reserve(reservedExpiryId, 300_000);
      await expectCode(admission.unsafe(`SELECT ${gateway}.forfeit_guardrail_budgets_v353(
        $1,$2)`, [reservedExpiryId, 'usage_unknown']), '23514');
      assert.deepEqual(await windows(), { rows: 2, reserved: 600_000, settled: 800_000 });
      const forcedReserved = await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE request_id=$1 RETURNING id`, [reservedExpiryId]);
      assert.equal(forcedReserved.length, 2);
      await withBuyerRowLock(reservedExpiryId, 1, async () => {
        await admission.unsafe("SET statement_timeout='1500ms'");
        try {
          const started = Date.now();
          assert.equal(await expire(1), 1);
          assert.ok(Date.now() - started < 1500, 'expiry must skip buyer-locked row');
          const partial = await rows(reservedExpiryId);
          assert.deepEqual(partial.map(row => row.state).sort(), ['released', 'reserved']);
        } finally { await admission.unsafe('RESET statement_timeout'); }
      });
      assert.equal(await mark(reservedExpiryId), false,
        'a partially expired multi-intent request must not dispatch');
      assert.equal(await expire(1), 1);
      assert.equal(await expire(1), 0);
      await assertRows(reservedExpiryId, 'released', 300_000, 0,
        'lease_expired_before_dispatch');
      assert.deepEqual(await windows(), { rows: 2, reserved: 0, settled: 800_000 });
      stage('bounded-expiry-releases-reserved-intents-and-split-request-mark-fails-closed');

      const dispatchedExpiryId = `v353-dispatched-expiry-${randomUUID()}`;
      await reserve(dispatchedExpiryId, 500_000);
      assert.equal(await mark(dispatchedExpiryId), true);
      const forcedDispatched = await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
        WHERE request_id=$1 RETURNING id`, [dispatchedExpiryId]);
      assert.equal(forcedDispatched.length, 2);
      assert.equal(await expire(50), 2);
      assert.equal(await expire(50), 0);
      await assertRows(dispatchedExpiryId, 'expired', 500_000, 500_000,
        'lease_expired_after_dispatch');
      assert.deepEqual(await windows(), { rows: 2, reserved: 0, settled: 1_800_000 });
      stage('dispatched-expiry-charges-full-ceiling-exactly-once');

      const unknownMarkId = `v353-ack-unknown-${randomUUID()}`;
      await reserve(unknownMarkId, 100_000);
      const ackExpiry=new Date(Date.now()+600_000).toISOString();
      const lostAcknowledgement = async () => {
        assert.equal(await mark(unknownMarkId,ackExpiry), true);
        throw new Error('simulated acknowledgement lost after committed mark');
      };
      await assert.rejects(lostAcknowledgement(), /acknowledgement lost/u);
      assert.equal(await release(unknownMarkId), 0,
        'unknown mark outcome must not release a possibly dispatched hold');
      assert.equal(await mark(unknownMarkId,ackExpiry), true,
        'replayed mark confirms the already-dispatched stored lease');
      assert.equal(await mark(unknownMarkId,
        new Date(new Date(ackExpiry).getTime()+60_000).toISOString()),false,
      'replayed mark cannot claim an unrecorded longer lease');
      assert.deepEqual(await windows(), { rows: 2, reserved: 200_000, settled: 1_800_000 });
      assert.equal(await forfeit(unknownMarkId), 2);
      assert.equal(await forfeit(unknownMarkId), 0);
      await assertRows(unknownMarkId, 'expired', 100_000, 100_000, 'usage_unknown');
      assert.deepEqual(await windows(), { rows: 2, reserved: 0, settled: 2_000_000 });
      stage('simulated-lost-mark-ack-forbids-release-and-forfeit-replay-cannot-double-charge');

      const adapterId = `v353-adapter-${randomUUID()}`;
      owner = await openPostgresGuardrailBudgetLifecycleOwnerV353({
        runtimeClient: { driver: 'postgres', raw: runtime },
        runtimeConnectionString: runtimeUrl, admissionConnectionString: admissionUrl,
        requestId: adapterId, userId: 'v353-user', apiKeyId: 'v353-key',
      });
      const adapterAt = now();
      assert.deepEqual(await owner.reserveAfterRecovery({
        requestId: adapterId, intents, reservedMicros: 50_000,
        nowIso: adapterAt.toISOString(),
        expiresAtIso: new Date(adapterAt.getTime() + 120_000).toISOString(),
      }), { status: 'reserved', reservationCount: 2 });
      const adapterMarkAt = now();
      assert.equal(await owner.admission.markDispatched(adapterId,
        adapterMarkAt.toISOString(),
        new Date(adapterMarkAt.getTime() + 900_000).toISOString()), true);
      assert.equal(await owner.forfeitDispatched('usage_unknown'), 2);
      assert.equal(await owner.forfeitDispatched('usage_unknown'), 0);
      await assertRows(adapterId, 'expired', 50_000, 50_000, 'usage_unknown');
      assert.deepEqual(await windows(), { rows: 2, reserved: 0, settled: 2_100_000 });
      await owner.close();
      owner = null;
      stage('request-owner-adapter-recovers-then-reserves-marks-and-forfeits-through-functions');

      const backlogSize = 220;
      await migrator.begin(async tx => {
        await tx.unsafe(`INSERT INTO ${gateway}.guardrail_budget_reservations (
          id,workspace_id,request_id,assignment_id,guardrail_id,guardrail_version,
          scope_type,scope_id,period,period_start,period_end,limit_micros,
          reserved_micros,settled_micros,settlement_basis,state,expires_at,
          created_at,updated_at)
          SELECT pg_catalog.gen_random_uuid()::text,r.workspace_id,
            'v353-backlog-'||g.n::text,r.assignment_id,r.guardrail_id,
            r.guardrail_version,r.scope_type,r.scope_id,r.period,r.period_start,
            r.period_end,r.limit_micros,1,0,'charged','reserved',
            pg_catalog.clock_timestamp()-INTERVAL '1 second',
            pg_catalog.clock_timestamp()-INTERVAL '5 minutes',
            pg_catalog.clock_timestamp()-INTERVAL '5 minutes'
          FROM ${gateway}.guardrail_budget_reservations r
          CROSS JOIN pg_catalog.generate_series(1,$2::integer) AS g(n)
          WHERE r.request_id=$1 AND r.scope_type='api_key'`, [forfeitId, backlogSize]);
        await tx.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
          SET reserved_micros=reserved_micros+$1
          WHERE workspace_id='v353-workspace' AND scope_type='api_key'`, [backlogSize]);
      });
      const [candidateCap] = await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM (SELECT id FROM ${gateway}.guardrail_budget_reservations
          WHERE state='reserved' AND expires_at<=pg_catalog.clock_timestamp()
          ORDER BY expires_at LIMIT 200) candidates`);
      assert.equal(candidateCap.n, 200);
      const backlogOwnerId = `v353-backlog-adapter-${randomUUID()}`;
      owner = await openPostgresGuardrailBudgetLifecycleOwnerV353({
        runtimeClient: { driver: 'postgres', raw: runtime },
        runtimeConnectionString: runtimeUrl, admissionConnectionString: admissionUrl,
        requestId: backlogOwnerId, userId: 'v353-user', apiKeyId: 'v353-key',
      });
      const backlogAt = now();
      await assert.rejects(owner.reserveAfterRecovery({
        requestId: backlogOwnerId, intents, reservedMicros: 1,
        nowIso: backlogAt.toISOString(),
        expiresAtIso: new Date(backlogAt.getTime() + 120_000).toISOString(),
      }), /recovery backlog was not drained/u);
      const [remaining] = await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${gateway}.guardrail_budget_reservations
        WHERE request_id LIKE 'v353-backlog-%' AND state='reserved'`);
      assert.equal(remaining.n, 20);
      const [unadmitted] = await migrator.unsafe(`SELECT count(*)::integer AS n
        FROM ${gateway}.guardrail_budget_reservations WHERE request_id=$1`,
      [backlogOwnerId]);
      assert.equal(unadmitted.n, 0);
      await owner.close();
      owner = null;
      stage('candidate-result-prefix-capped-and-four-full-recovery-pages-refuse-new-admission',
        { backlogSize, candidateCap: candidateCap.n, remaining: remaining.n });

      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null,
        constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 4000) };
    } finally {
      if (owner) {
        try { await owner.close(); } catch (error) { failure ??= error; }
      }
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = String(error).slice(0, 1500);
        failure ??= error;
      }
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`guardrail-budget-lifecycle-v353-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });
