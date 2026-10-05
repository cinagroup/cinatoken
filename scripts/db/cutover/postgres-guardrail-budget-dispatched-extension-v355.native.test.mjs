// Owned PostgreSQL 18.6 proof of dispatched private BYOK to paid Guardrail extension.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { openPostgresGuardrailBudgetExtensionOwnerV355 } from '../../../packages/proxy/src/services/postgres-guardrail-budget-extension-v355.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';
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

test('Guardrail extension LOGIN atomically adds paid intents to a dispatched BYOK hold',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned),
      `report-guardrail-budget-dispatched-extension-v355-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING',
      binaryVersion: cluster.binaryVersion, sourceSha256: {}, stages: [],
      scope: 'owned loopback PostgreSQL 18.6; PG73 plus v348/v349/v350/v351/v353/v355 review-only proposals',
      limitations: [
        'No route, coordinator, Worker, Hyperdrive, formal migration, production credential, remote SQL, or deployment changed.',
        'An extension COMMIT acknowledgement loss is simulated after commit; no TCP connection loss is injected.',
        'The admission LOGIN still supplies its request identity and reservation amount. A bearer proof and quoted amount are not independently verified by this SQL.',
        'The adapter is not wired into the route coordinator. Buyer settlement and late actual usage remain outside this fixture.',
        'The buyer-held row check covers immediate NOWAIT refusal, not an end-to-end buyer writer settlement/extension race.',
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
      const migrationNames = await listPg73Migrations();
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
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
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
      stage('v353-prerequisite-function-only-ACL-for-direct-admission-LOGIN', { acl });

      const extensionProposal = await readFile(new URL(
        'guardrail-budget-dispatched-extension-login-v355.sql', proposals), 'utf8');
      report.sourceSha256.extensionProposal = hash(extensionProposal);
      report.sourceSha256.extensionAdapter = hash(await readFile(new URL(
        '../../../packages/proxy/src/services/postgres-guardrail-budget-extension-v355.ts',
        import.meta.url)));
      await assert.rejects(migrator.begin(tx => tx.unsafe(extensionProposal).simple()),
        /activation|dependency/u);
      await migrator.unsafe(`GRANT UPDATE (reserved_micros) ON TABLE
        ${gateway}.guardrail_budget_windows TO cinatoken_gateway_runtime`);
      await assert.rejects(migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_extension_v355_activation='reviewed-v1'");
        await tx.unsafe(extensionProposal).simple();
      }), /activation|dependency/u,
      'a runtime column-level write grant must fail v355 activation');
      await migrator.unsafe(`REVOKE UPDATE (reserved_micros) ON TABLE
        ${gateway}.guardrail_budget_windows FROM cinatoken_gateway_runtime`);
      stage('column-level-runtime-write-grant-drift-refuses-activation');
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.guardrail_budget_extension_v355_activation='reviewed-v1'");
        await tx.unsafe(extensionProposal).simple();
      });
      const extensionSignature = `${gateway}.extend_guardrail_budgets_dispatched_v355(text,text,text,jsonb,bigint,timestamptz,timestamptz)`;
      const extensionAcl = await migrator.unsafe(`SELECT roles.role_name,
          pg_catalog.has_function_privilege(roles.role_name,$1,'EXECUTE') AS can_execute,
          pg_catalog.has_table_privilege(roles.role_name,
            '${gateway}.guardrail_budget_windows','UPDATE') AS window_update,
          pg_catalog.has_table_privilege(roles.role_name,
            '${gateway}.guardrail_budget_reservations','UPDATE') AS reservation_update
        FROM (VALUES ('cinatoken_gateway_budget_admission'),
          ('cinatoken_gateway_runtime'),
          ('cinatoken_gateway_buyer_settlement')) AS roles(role_name)`,
      [extensionSignature]);
      const extensionByRole = Object.fromEntries(extensionAcl.map(row => [row.role_name, row]));
      assert.deepEqual(extensionByRole.cinatoken_gateway_budget_admission,
        { role_name: 'cinatoken_gateway_budget_admission', can_execute: true,
          window_update: false, reservation_update: false });
      for (const role of ['cinatoken_gateway_runtime', 'cinatoken_gateway_buyer_settlement']) {
        assert.equal(extensionByRole[role].can_execute, false);
      }
      assert.equal(extensionByRole.cinatoken_gateway_runtime.window_update, false);
      assert.equal(extensionByRole.cinatoken_gateway_runtime.reservation_update, false);
      assert.equal(extensionByRole.cinatoken_gateway_buyer_settlement.window_update, true,
        'the existing buyer settlement update grant must not be mistaken for a v355 grant');
      await expectCode(runtime.unsafe(`SELECT ${gateway}.extend_guardrail_budgets_dispatched_v355(
        'forged','v353-user','v353-key','[]'::jsonb,1,now(),now())`), '42501');
      stage('v355-default-off-install-and-execute-only-ACL', { extensionAcl });

      await migrator.unsafe(`INSERT INTO ${gateway}.users
          (id,email,budget_max,budget_spent)
          VALUES('v353-user','v353-user@example.invalid',10,0);
        INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v353-workspace','personal','v353-user','V353','v353','active');
        INSERT INTO ${gateway}.api_keys
          (id,key,user_id,workspace_id,limit_micros,limit_reset,include_byok_in_limit)
          VALUES('v353-key','synthetic-v353-key','v353-user','v353-workspace',
            2000000,'daily',true);
        INSERT INTO ${gateway}.workspace_budgets
          (id,workspace_id,reset_interval,limit_micros)
          VALUES('v353-budget','v353-workspace','daily',1500000);`).simple();
      const at = new Date();
      const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
      const end = new Date(start.getTime() + 86_400_000);
      const common = { workspaceId: 'v353-workspace', guardrailVersion: 1,
        period: 'daily', periodStart: start.toISOString(), periodEnd: end.toISOString(),
        limitMicros: 2_000_000 };
      const intents = [
        { ...common, limitMicros: 1_500_000,
          assignmentId: 'workspace-budget:v353-budget',
          guardrailId: 'workspace-budget:v353-budget', scopeType: 'workspace', scopeId: 'v353-workspace' },
        { ...common, assignmentId: 'gateway-key-limit:v353-key',
          guardrailId: 'gateway-key-limit:v353-key', scopeType: 'api_key', scopeId: 'v353-key' },
      ];
      const now = () => new Date();
      const reserveRoute = async (requestId, amount) => {
        const instant = now();
        const [reserved] = await admission.unsafe(`SELECT ${gateway}.reserve_guardrail_budgets_v351(
          $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,
        [requestId, 'v353-user', 'v353-key', admission.json([intents[1]]), amount,
          'gateway_key_route', instant.toISOString(),
          new Date(instant.getTime() + 120_000).toISOString()]);
        assert.deepEqual(reserved.result, { status: 'reserved', reservationCount: 1 });
        const [marked] = await admission.unsafe(`SELECT ${gateway}.mark_guardrail_budgets_dispatched_v351(
          $1,$2,$3) AS ok`, [requestId, instant.toISOString(),
          new Date(instant.getTime() + 900_000).toISOString()]);
        assert.equal(marked.ok, true);
      };
      const extensionExpiryByRequest = new Map();
      const extend = async (requestId, amount, suppliedIntents = intents,
        userId = 'v353-user', keyId = 'v353-key') => {
        const instant = now();
        if (!extensionExpiryByRequest.has(requestId)) {
          extensionExpiryByRequest.set(requestId,
            new Date(instant.getTime() + 900_000).toISOString());
        }
        const [row] = await admission.unsafe(`SELECT ${gateway}.extend_guardrail_budgets_dispatched_v355(
          $1,$2,$3,$4::jsonb,$5,$6,$7) AS result`,
        [requestId, userId, keyId, admission.json(suppliedIntents), amount,
          instant.toISOString(), extensionExpiryByRequest.get(requestId)]);
        return row.result;
      };
      const expectLeaseResult = (actual, status, requestId, count) => {
        assert.deepEqual({ status: actual.status, reservationCount: actual.reservationCount },
          { status, reservationCount: count });
        assert.equal(Date.parse(actual.leaseExpiresAt),
          Date.parse(extensionExpiryByRequest.get(requestId)),
          'success must attest the DB-held lease requested for this dispatch');
      };
      const rows = requestId => migrator.unsafe(`SELECT assignment_id,scope_type,
          reserved_micros::bigint AS reserved_micros,
          settled_micros::bigint AS settled_micros,
          settlement_basis,state,dispatched_at,expires_at
        FROM ${gateway}.guardrail_budget_reservations
        WHERE request_id=$1 ORDER BY assignment_id`, [requestId]);
      const windows = async () => {
        const found = await migrator.unsafe(`SELECT scope_type,
          reserved_micros::bigint AS reserved_micros,
          settled_micros::bigint AS settled_micros
          FROM ${gateway}.guardrail_budget_windows
          WHERE workspace_id='v353-workspace' ORDER BY scope_type`);
        return Object.fromEntries(found.map(row => [row.scope_type,
          { reserved: Number(row.reserved_micros), settled: Number(row.settled_micros) }]));
      };

      // A workspace with no configured paid-budget intents exercises the
      // Key-only n=1 branch. Its existing route lease is the only possible
      // database proof for a subsequent paid send.
      await migrator.unsafe(`INSERT INTO ${gateway}.workspaces
          (id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES('v355-only-workspace','personal','v353-user','V355 only','v355-only','active');
        INSERT INTO ${gateway}.api_keys
          (id,key,user_id,workspace_id,limit_micros,limit_reset,include_byok_in_limit)
          VALUES('v355-only-key','synthetic-v355-only-key','v353-user','v355-only-workspace',
            2000000,'daily',true);`).simple();
      const onlyIntent = [{ ...common, workspaceId: 'v355-only-workspace',
        assignmentId: 'gateway-key-limit:v355-only-key',
        guardrailId: 'gateway-key-limit:v355-only-key',
        scopeType: 'api_key', scopeId: 'v355-only-key' }];
      const onlyId = `v355-only-${randomUUID()}`;
      const onlyAt = now();
      const onlyLeaseIso = new Date(onlyAt.getTime() + 120_000).toISOString();
      const [onlyReserved] = await admission.unsafe(`SELECT ${gateway}.reserve_guardrail_budgets_v351(
        $1,$2,$3,$4::jsonb,$5,$6,$7,$8) AS result`,
      [onlyId, 'v353-user', 'v355-only-key', admission.json(onlyIntent), 100_000,
        'gateway_key_route', onlyAt.toISOString(), onlyLeaseIso]);
      assert.deepEqual(onlyReserved.result, { status: 'reserved', reservationCount: 1 });
      const [onlyMarked] = await admission.unsafe(`SELECT ${gateway}.mark_guardrail_budgets_dispatched_v351(
        $1,$2,$3) AS ok`, [onlyId, onlyAt.toISOString(), onlyLeaseIso]);
      assert.equal(onlyMarked.ok, true);
      const extendOnly = async expiresAtIso => {
        const [row] = await admission.unsafe(`SELECT ${gateway}.extend_guardrail_budgets_dispatched_v355(
          $1,$2,$3,$4::jsonb,$5,$6,$7) AS result`,
        [onlyId, 'v353-user', 'v355-only-key', admission.json(onlyIntent), 100_000,
          now().toISOString(), expiresAtIso]);
        return row.result;
      };
      const onlyBefore = await rows(onlyId);
      assert.deepEqual(await extendOnly(new Date(Date.parse(onlyLeaseIso) + 1).toISOString()),
        { status: 'stale' }, 'Key-only must not authorize one millisecond beyond the held lease');
      for (let replay = 0; replay < 2; replay += 1) {
        const result = await extendOnly(onlyLeaseIso);
        assert.deepEqual({ status: result.status, reservationCount: result.reservationCount },
          { status: 'idempotent', reservationCount: 1 });
        assert.equal(Date.parse(result.leaseExpiresAt), Date.parse(onlyLeaseIso));
      }
      assert.deepEqual(await rows(onlyId), onlyBefore,
        'Key-only replay must neither add a paid row nor silently extend its route lease');
      stage('key-only-replay-attests-held-lease-and-rejects-one-millisecond-overrun');

      const [shortOnly] = await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET expires_at=pg_catalog.clock_timestamp()+INTERVAL '800 milliseconds'
        WHERE request_id=$1 RETURNING expires_at`, [onlyId]);
      let releaseOnlyLock;
      let onlyLockReadyResolve;
      const onlyLockGate = new Promise(resolve => { releaseOnlyLock = resolve; });
      const onlyLockReady = new Promise(resolve => { onlyLockReadyResolve = resolve; });
      const holdingOnlyLock = migrator.begin(async tx => {
        await tx.unsafe(`SELECT pg_catalog.pg_advisory_xact_lock(348,
          pg_catalog.hashtext($1))`, [onlyId]);
        onlyLockReadyResolve();
        await onlyLockGate;
      });
      await onlyLockReady;
      const waitingOnlyReplay = extendOnly(shortOnly.expires_at.toISOString());
      await new Promise(resolve => setTimeout(resolve, 1_200));
      releaseOnlyLock();
      await holdingOnlyLock;
      assert.deepEqual(await waitingOnlyReplay, { status: 'stale' });
      stage('key-only-replay-rechecks-expiry-after-request-lock-wait');

      const firstId = `v355-paid-${randomUUID()}`;
      await reserveRoute(firstId, 600_000);
      assert.deepEqual(await extend(firstId, 700_000),
        { status: 'stale' }, 'paid hold cannot exceed the existing route ceiling');
      assert.deepEqual(await extend(firstId, 250_000, intents, 'wrong-user'),
        { status: 'conflict' });
      assert.deepEqual(await extend(firstId, 250_000, [intents[1]]),
        { status: 'conflict' }, 'omitted charged workspace intent must fail');
      assert.equal((await rows(firstId)).length, 1);
      stage('request-identity-and-complete-intent-set-required-before-extension');

      expectLeaseResult(await extend(firstId, 250_000), 'reserved', firstId, 2);
      let firstRows = await rows(firstId);
      assert.equal(firstRows.length, 2);
      const keyHold = firstRows.find(row => row.settlement_basis === 'gateway_key_route');
      const paidHold = firstRows.find(row => row.settlement_basis === 'charged');
      assert.equal(keyHold?.assignment_id, 'gateway-key-limit:v353-key');
      assert.equal(Number(keyHold.reserved_micros), 600_000);
      assert.equal(keyHold.state, 'dispatched');
      assert.ok(keyHold.dispatched_at);
      assert.equal(paidHold?.assignment_id, 'workspace-budget:v353-budget');
      assert.equal(Number(paidHold.reserved_micros), 250_000);
      assert.equal(paidHold.state, 'dispatched');
      assert.deepEqual(await windows(), {
        api_key: { reserved: 600_000, settled: 0 },
        workspace: { reserved: 250_000, settled: 0 },
      });
      expectLeaseResult(await extend(firstId, 250_000), 'idempotent', firstId, 2);
      const [longerReplay] = await admission.unsafe(`SELECT ${gateway}.extend_guardrail_budgets_dispatched_v355(
        $1,$2,$3,$4::jsonb,$5,$6,$7) AS result`,
      [firstId, 'v353-user', 'v353-key', admission.json(intents), 250_000,
        now().toISOString(), new Date(Date.parse(extensionExpiryByRequest.get(firstId)) + 1).toISOString()]);
      assert.deepEqual(longerReplay.result, { status: 'stale' },
        'a multi-intent replay cannot authorize one millisecond beyond its shortest held lease');
      assert.deepEqual(await rows(firstId), firstRows);
      stage('atomic-paid-intent-extension-preserves-original-route-hold-and-replays-once');

      const ackId = `v355-ack-unknown-${randomUUID()}`;
      await reserveRoute(ackId, 100_000);
      await assert.rejects(async () => {
        expectLeaseResult(await extend(ackId, 100_000), 'reserved', ackId, 2);
        throw new Error('simulated extension COMMIT acknowledgement lost');
      }, /acknowledgement lost/u);
      expectLeaseResult(await extend(ackId, 100_000), 'idempotent', ackId, 2);
      assert.equal((await rows(ackId)).length, 2);
      stage('simulated-lost-extension-ack-replays-without-double-hold');

      const blockedId = `v355-blocked-${randomUUID()}`;
      await reserveRoute(blockedId, 1_200_000);
      assert.deepEqual(await extend(blockedId, 1_200_000),
        { status: 'blocked', assignmentId: 'workspace-budget:v353-budget' });
      assert.equal((await rows(blockedId)).length, 1);
      assert.deepEqual(await windows(), {
        api_key: { reserved: 1_900_000, settled: 0 },
        workspace: { reserved: 350_000, settled: 0 },
      });
      assert.deepEqual(await extend(blockedId, 1_200_000,
        [{ ...intents[0], limitMicros: 1_400_000 }, intents[1]]),
      { status: 'stale' });
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET state='reserved',dispatched_at=NULL WHERE request_id=$1`, [blockedId]);
      assert.deepEqual(await extend(blockedId, 1_200_000),
        { status: 'conflict' });
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET state='dispatched',dispatched_at=pg_catalog.clock_timestamp()
        WHERE request_id=$1`, [blockedId]);
      stage('capacity-block-and-stale-or-mixed-state-reject-without-paid-row');

      const adapterId = `v355-adapter-${randomUUID()}`;
      await reserveRoute(adapterId, 100_000);
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros+1
        WHERE workspace_id='v353-workspace' AND scope_type='workspace'`);
      await expectCode(extend(adapterId, 100_000), '23514');
      assert.equal((await rows(adapterId)).length, 1,
        'counter failure must not insert a charged reservation');
      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_windows
        SET reserved_micros=reserved_micros-1
        WHERE workspace_id='v353-workspace' AND scope_type='workspace'`);
      let unlock;
      let readyResolve;
      const gate = new Promise(resolve => { unlock = resolve; });
      const ready = new Promise(resolve => { readyResolve = resolve; });
      const holding = buyer.begin(async tx => {
        await tx.unsafe(`SELECT id FROM ${gateway}.guardrail_budget_reservations
          WHERE request_id=$1 FOR UPDATE`, [adapterId]);
        readyResolve();
        await gate;
      });
      await ready;
      try {
        await expectCode(extend(adapterId, 100_000), '55P03');
      } finally { unlock(); await holding; }
      assert.equal((await rows(adapterId)).length, 1);
      stage('counter-corruption-and-buyer-row-lock-fail-before-new-holds');

      owner = await openPostgresGuardrailBudgetExtensionOwnerV355({
        runtimeClient: { driver: 'postgres', raw: runtime },
        runtimeConnectionString: runtimeUrl, admissionConnectionString: admissionUrl,
        requestId: adapterId, userId: 'v353-user', apiKeyId: 'v353-key',
      });
      const adapterAt = now();
      assert.deepEqual(await owner.extendDispatched({
        requestId: adapterId, intents, reservedMicros: 100_000,
        nowIso: adapterAt.toISOString(),
        expiresAtIso: new Date(adapterAt.getTime() + 900_000).toISOString(),
      }), { status: 'reserved', reservationCount: 2 });
      await assert.rejects(async () => owner.extendDispatched({
        requestId: firstId, intents, reservedMicros: 100_000,
        nowIso: adapterAt.toISOString(),
        expiresAtIso: new Date(adapterAt.getTime() + 900_000).toISOString(),
      }), /request identity differs/u);
      await owner.close();
      owner = null;
      assert.equal((await rows(adapterId)).length, 2);
      stage('request-fixed-direct-login-adapter-extends-and-closes');

      const [forfeited] = await admission.unsafe(`SELECT
        ${gateway}.forfeit_guardrail_budgets_v353($1,$2) AS count`,
      [firstId, 'usage_unknown']);
      assert.equal(forfeited.count, 2);
      firstRows = await rows(firstId);
      assert.deepEqual(firstRows.map(row => row.state), ['expired', 'expired']);
      assert.deepEqual(firstRows.map(row => Number(row.settled_micros)).sort((a, b) => a - b),
        [250_000, 600_000]);
      stage('post-extension-forfeit-consumes-route-and-paid-ceilings-once');

      await migrator.unsafe(`UPDATE ${gateway}.guardrail_budget_reservations
        SET expires_at=pg_catalog.clock_timestamp()+INTERVAL '800 milliseconds'
        WHERE request_id=$1`, [blockedId]);
      let releaseRequestLock;
      let requestLockReadyResolve;
      let requestLockReadyReject;
      const requestLockGate = new Promise(resolve => { releaseRequestLock = resolve; });
      const requestLockReady = new Promise((resolve, reject) => {
        requestLockReadyResolve = resolve;
        requestLockReadyReject = reject;
      });
      const holdingRequestLock = migrator.begin(async tx => {
        await tx.unsafe(`SELECT pg_catalog.pg_advisory_xact_lock(348,
          pg_catalog.hashtext($1))`, [blockedId]);
        requestLockReadyResolve();
        await requestLockGate;
      });
      holdingRequestLock.catch(requestLockReadyReject);
      await requestLockReady;
      const waitingExtension = extend(blockedId, 1_200_000);
      await new Promise(resolve => setTimeout(resolve, 1_200));
      releaseRequestLock();
      await holdingRequestLock;
      assert.deepEqual(await waitingExtension, { status: 'stale' },
        'the route lease must be checked after a wait on the request lock');
      assert.equal((await rows(blockedId)).length, 1);
      stage('advisory-lock-wait-rechecks-database-clock-and-refuses-expired-route');

      await migrator.unsafe(`UPDATE ${gateway}.workspace_budgets
        SET limit_micros=limit_micros+1 WHERE id='v353-budget'`);
      assert.deepEqual(await extend(ackId, 100_000), { status: 'stale' });
      stage('replay-refuses-changed-configuration');

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
      process.stdout.write(`guardrail-budget-dispatched-extension-v355-report=${reportPath}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });
