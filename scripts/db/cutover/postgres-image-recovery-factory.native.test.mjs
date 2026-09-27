// Explicit local fixture only. Starts its own loopback PostgreSQL cluster and
// never uses an ambient database URL or changes production role grants.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { resolveUpstreamEndpoint } from '../../../packages/core/src/index.ts';
import {
  buildImageGenerationUpstreamBody,
  captureImageAttemptRouteFacts,
  createPreparedImageGenerationAttempt,
} from '../../../packages/proxy/src/services/image-attempt-context.ts';
import { createPostgresImageUsageRecoveryFactory } from '../../../packages/proxy/src/services/image-usage-recovery-postgres.ts';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { buildRequestParentProducerGrant } from './build-request-parent-producer-grant.mjs';
import { buildImageFactJobProducerGrant } from './build-image-fact-job-producer-grant.mjs';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';

const schema = 'cinatoken_gateway';
const dispatchRole = 'cinatoken_gateway_dispatch_producer';
const factRole = 'cinatoken_gateway_fact_producer';
const runtimeRole = 'cinatoken_gateway_runtime';
const migrationDir = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.request_dispatch_parent_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-parent-deadline-budget.sql', import.meta.url)],
  ['cinatoken.settlement_outbox_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url)],
];
const sha256 = body => createHash('sha256').update(body).digest('hex');
const client = raw => ({ driver: 'postgres', raw, drizzle: {} });

function localRoleClient(cluster, username, password, applicationName) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, max_pipeline: 1,
    prepare: false, fetch_types: false, connect_timeout: 3, idle_timeout: 0,
    max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-native-image-factory-${applicationName}` } });
}

async function bundle(sql, text) {
  try { await sql.unsafe(text).simple(); }
  catch (error) { await sql.unsafe('ROLLBACK').simple(); throw error; }
}

function route() {
  return {
    targetId: 'target-1', modelSurfaceId: 'surface-1', routePoolId: 'pool-1',
    providerId: 'provider-1', providerName: 'Provider', providerModelName: 'provider-image-model',
    upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
    providerEndpoints: { openai: { base: 'https://provider.example/v1' } },
    providerApiKey: 'private-upstream-key', providerKeyId: 'provider-key-1',
    providerKeyFingerprint: 'fingerprint-1', priceOverrideRaw: null,
    routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null,
    routeGroup: 'default', routePriority: 1, routeWeight: 1,
  };
}

async function preparedContext(selected, requestSha256) {
  const url = resolveUpstreamEndpoint('openai', 'images.generations', selected.providerEndpoints,
    { providerId: selected.providerId });
  const facts = captureImageAttemptRouteFacts(selected, 'images.generations', url);
  const prepared = createPreparedImageGenerationAttempt(facts,
    buildImageGenerationUpstreamBody(selected, { prompt: 'fixture image prompt', n: 1 }));
  const digests = await prepared.digestTrustedContext(requestSha256,
    { signal: new AbortController().signal, throwIfStopped() {} });
  return Object.freeze({ operation: prepared.operation, requestSha256,
    ...digests, routeIdentity: prepared.routeIdentity });
}

function usage(storage, scope, selected) {
  const now = new Date().toISOString();
  return {
    repos: storage.repositories, requestLogId: scope.requestId,
    userId: scope.userId, apiKeyId: scope.apiKeyId, workspaceId: scope.workspaceId,
    userEmail: 'sensitive@example.invalid', modelId: scope.modelId,
    providerId: selected.providerId, providerModelName: selected.providerModelName,
    providerKeyId: selected.providerKeyId, providerKeyFingerprint: selected.providerKeyFingerprint,
    routeTargetId: selected.targetId, modelSurfaceId: selected.modelSurfaceId,
    routePoolId: selected.routePoolId, requestProtocol: 'openai',
    requestOperation: scope.operation, upstreamProtocol: 'openai',
    upstreamOperation: selected.upstreamOperation, routeGroup: 'default',
    status: 'error', latencyMs: 10, errorMessage: 'private upstream error',
    requestBody: 'private request prompt', upstreamRequestBody: 'private upstream key',
    billing: { modelPricingProfileJson: null, imageCount: 1, operation: 'generations',
      pricingContext: { pricingAtUtcMs: Date.now(), businessTimezone: 'UTC' } },
    timing: { providerAttempts: [{ attemptIndex: 1, routeTargetId: selected.targetId,
      providerId: selected.providerId, outcome: 'unavailable',
      reason: 'provider_http_error', httpStatus: 503, observedAtIso: now }] },
  };
}

test('native PostgreSQL Images recovery factory claim, fact, outbox and job',
  { timeout: 240_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-image-factory-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PostgreSQL 18; 73 formal migrations; review-only parent/outbox proposals; distinct password-authenticated LOGIN runtime/dispatch/fact roles',
      limitations: [
        'Direct LOGIN role connections use random fixture-only passwords; no production credential, origin, Hyperdrive binding or cloud deployment is proven.',
        'The budget ticket callback is synthetic; real PostgreSQL origin admission and financial recovery are not exercised.',
        'Parent and fact/job grants are default-disabled local proposals, not formal migrations or a production activation.',
        'The prepared ingress SHA and selected route are supplied by the fixture; this test does not exercise HTTP parsing or real provider fetch.',
      ], sourceSha256: {}, stages: [] };
    const clients = [];
    const stage = (name, details = {}) => report.stages.push({ name, result: 'PASS', ...details });
    let failure;
    try {
      const [version] = await cluster.admin.unsafe("SELECT current_setting('server_version_num')::int AS n");
      assert.ok(version.n >= 180000 && version.n < 190000);
      report.serverVersionNum = version.n;
      for (const [name, url] of [
        ['test', new URL(import.meta.url)],
        ['factory', new URL('../../../packages/proxy/src/services/image-usage-recovery-postgres.ts', import.meta.url)],
        ['attemptContext', new URL('../../../packages/proxy/src/services/image-attempt-context.ts', import.meta.url)],
        ['parentGrant', new URL('./build-request-parent-producer-grant.mjs', import.meta.url)],
        ['factJobGrant', new URL('./build-image-fact-job-producer-grant.mjs', import.meta.url)],
        ...proposals.map(([name, url]) => [name, url]),
      ]) report.sourceSha256[name] = sha256(await readFile(url));
      const passwords = Object.freeze({ migrator: randomBytes(24).toString('hex'),
        runtime: randomBytes(24).toString('hex'),
        dispatch: randomBytes(24).toString('hex'), fact: randomBytes(24).toString('hex') });
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE ${runtimeRole} LOGIN NOINHERIT PASSWORD '${passwords.runtime}';
        CREATE ROLE ${dispatchRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.dispatch}';
        CREATE ROLE ${factRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.fact}';
        CREATE SCHEMA ${schema} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator, ${runtimeRole}, ${dispatchRole}, ${factRole};`).simple();
      const migrator = localRoleClient(cluster, 'cinatoken_gateway_migrator',
        passwords.migrator, 'migrator');
      clients.push(migrator);
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${passwords.migrator}@127.0.0.1:${cluster.port}/postgres`;
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations(
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrationDir)).filter(name => name.endsWith('.sql')).sort();
      assert.equal(files.length, 73);
      const corpus = [];
      for (const name of files) {
        const body = await readFile(new URL(name, migrationDir), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${schema}.schema_migrations(version) VALUES ($1)`, [name]);
        });
      }
      report.sourceSha256.formalMigrationCorpus = sha256(corpus.join('\n'));
      stage('formal-migrations', { count: files.length });
      for (const [setting, url] of proposals.slice(0, 2)) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await bundle(migrator, await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
      // The pinned default-ACL bundle above already installs the parent proposal.
      for (const [setting, url] of proposals.slice(3)) {
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
          await tx.unsafe(await readFile(url, 'utf8')).simple();
        });
      }
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await bundle(migrator, await buildRequestParentProducerGrant({ activation: 'reviewed-direct-login-v1' }));
      stage('reviewed-parent-and-outbox-definers-with-function-only-parent-grant');
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
        VALUES ('image-user','image@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES ('image-space','personal','image-user','Image fixture','image-fixture','active');
        INSERT INTO ${schema}.api_keys(id,key,user_id,workspace_id)
        VALUES ('image-key','fixture-key','image-user','image-space');`).simple();

      const claimRaw = localRoleClient(cluster, dispatchRole, passwords.dispatch, 'dispatch');
      const factRaw = localRoleClient(cluster, factRole, passwords.fact, 'fact');
      const runtimeRaw = localRoleClient(cluster, runtimeRole, passwords.runtime, 'runtime');
      clients.push(claimRaw, factRaw, runtimeRaw);
      for (const [raw, expected] of [[claimRaw, dispatchRole],
        [factRaw, factRole], [runtimeRaw, runtimeRole]]) {
        const [identity] = await raw.unsafe('SELECT current_user AS current_role, session_user AS session_role');
        assert.deepEqual(identity, { current_role: expected, session_role: expected });
      }
      const wrongCredential = localRoleClient(cluster, dispatchRole,
        passwords.fact, 'wrong-credential');
      try {
        await assert.rejects(wrongCredential.unsafe('SELECT 1'),
          error => error.code === '28P01');
      } finally {
        await wrongCredential.end({ timeout: 1 });
      }
      const [membership] = await cluster.admin.unsafe(`SELECT count(*)::int AS n
        FROM pg_catalog.pg_auth_members
        WHERE member IN ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1),
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))
          OR roleid IN ((SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$1),
            (SELECT oid FROM pg_catalog.pg_roles WHERE rolname=$2))`, [dispatchRole, factRole]);
      assert.equal(membership.n, 0);
      stage('password-authenticated-runtime-dispatch-and-fact-origins',
        { currentEqualsSession: true, wrongCredentialRejected: true,
          roleMemberships: membership.n });
      const [acl] = await cluster.admin.unsafe(`SELECT
        pg_catalog.has_function_privilege($1::text,
          '${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)', 'EXECUTE') AS dispatch_prepare,
        pg_catalog.has_function_privilege($2::text,
          '${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)', 'EXECUTE') AS fact_prepare,
        pg_catalog.has_function_privilege($3::text,
          '${schema}.prepare_request_dispatch_intent_v1(text,integer,text,text,text,text,text,text,bigint,integer)', 'EXECUTE') AS runtime_prepare,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_dispatch_requests','SELECT,INSERT,UPDATE,DELETE') AS dispatch_parent_dml,
        pg_catalog.has_table_privilege($2::text,'${schema}.request_dispatch_requests','SELECT,INSERT,UPDATE,DELETE') AS fact_parent_dml,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_dispatch_intents','SELECT,INSERT,UPDATE,DELETE') AS dispatch_intent_dml,
        pg_catalog.has_table_privilege($2::text,'${schema}.request_dispatch_intents','SELECT,INSERT,UPDATE,DELETE') AS fact_intent_dml,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_usage_settlements','INSERT') AS dispatch_fact_insert,
        pg_catalog.has_table_privilege($2::text,'${schema}.request_usage_settlements','INSERT') AS fact_fact_insert,
        pg_catalog.has_table_privilege($3::text,'${schema}.request_usage_settlements','INSERT') AS runtime_fact_insert`,
      [dispatchRole, factRole, runtimeRole]);
      assert.deepEqual(acl, { dispatch_prepare: true, fact_prepare: false, runtime_prepare: false,
        dispatch_parent_dml: false, fact_parent_dml: false,
        dispatch_intent_dml: false, fact_intent_dml: false,
        dispatch_fact_insert: false, fact_fact_insert: false, runtime_fact_insert: false });
      await assert.rejects(claimRaw.unsafe(`SELECT request_id FROM ${schema}.request_dispatch_requests`),
        error => error.code === '42501');
      await assert.rejects(claimRaw.unsafe(`SELECT request_id FROM ${schema}.request_dispatch_intents`),
        error => error.code === '42501');
      await assert.rejects(factRaw.unsafe(`SELECT request_id FROM ${schema}.request_dispatch_requests`),
        error => error.code === '42501');
      stage('separate-direct-login-dispatch-and-fact-roles-with-default-fact-denial', { acl });

      const storage = { client: client(runtimeRaw), repositories: {} };
      const factory = createPostgresImageUsageRecoveryFactory(storage,
        { claimProducer: client(claimRaw), factProducer: client(factRaw) }, { maxAttempts: 1 });
      const selected = route();
      const requestSha256 = sha256('{"model":"gateway-image-model","prompt":"fixture image prompt","n":1}');
      const bound = await preparedContext(selected, requestSha256);
      const expiry = Number((await cluster.admin.unsafe(`SELECT
        (floor(extract(epoch FROM pg_catalog.clock_timestamp())*1000)::bigint+120000)::text AS ms`))[0].ms);
      const scope = requestId => Object.freeze({ requestId, userId: 'image-user',
        apiKeyId: 'image-key', workspaceId: 'image-space', modelId: 'gateway-image-model',
        operation: 'images.generations', requestSha256, expiresAtMs: expiry });
      const events = [];
      const ticket = requestId => ({
        async markAfterCommittedClaim() {
          // A separate session must already observe the committed send right.
          const [row] = await cluster.admin.unsafe(`SELECT i.state,p.claim_count
            FROM ${schema}.request_dispatch_intents i
            JOIN ${schema}.request_dispatch_requests p ON p.request_id=i.request_id
            WHERE i.request_id=$1`, [requestId]);
          assert.deepEqual(row, { state: 'dispatch_claimed', claim_count: 1 });
          events.push('budget.mark');
        },
        async releaseAfterDefiniteNoClaim() { events.push('budget.release'); },
        holdAfterUncertainClaim() { events.push('budget.hold'); },
      });
      const badScope = scope(`image-${randomUUID()}`);
      const bad = factory(badScope);
      await assert.rejects(bad.beforeSingleGrantDispatch(
        { ...selected, providerKeyId: 'different-key' }, 1, ticket(badScope.requestId), () => {}, bound),
      /route mismatch/);
      assert.deepEqual(events, ['budget.release']);
      assert.equal((await cluster.admin.unsafe(`SELECT count(*)::int AS n FROM ${schema}.request_dispatch_requests`))[0].n, 0);
      stage('prepared-route-mismatch-rejected-before-parent');

      const deniedScope = scope(`image-${randomUUID()}`);
      const denied = factory(deniedScope);
      await denied.beforeSingleGrantDispatch(selected, 1, ticket(deniedScope.requestId), () => {}, bound);
      assert.deepEqual(events.slice(-1), ['budget.mark']);
      await assert.rejects(denied.persist(usage(storage, deniedScope, selected)),
        error => error.code === '42501');
      const [afterDenial] = await cluster.admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements) AS facts,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox) AS outbox,
        (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs) AS jobs`);
      assert.deepEqual(afterDenial, { facts: 0, outbox: 0, jobs: 0 });
      stage('real-claim-and-budget-mark-but-ungranted-fact-write-fails-closed',
        { sqlstate: '42501', durable: afterDenial });

      await bundle(migrator, await buildImageFactJobProducerGrant({ activation: 'reviewed-direct-login-v1' }));
      const [granted] = await cluster.admin.unsafe(`SELECT
        pg_catalog.has_any_column_privilege($1::text,'${schema}.request_usage_settlements','INSERT') AS fact_column_insert,
        pg_catalog.has_any_column_privilege($1::text,'${schema}.request_usage_recovery_jobs','INSERT') AS job_column_insert,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_dispatch_intents','SELECT,INSERT,UPDATE,DELETE') AS intent_dml,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_dispatch_requests','SELECT,INSERT,UPDATE,DELETE') AS parent_dml,
        pg_catalog.has_table_privilege($1::text,'${schema}.request_usage_settlement_outbox','INSERT') AS outbox_insert,
        pg_catalog.has_any_column_privilege($2::text,'${schema}.request_usage_settlements','INSERT') AS dispatch_fact_insert`,
      [factRole, dispatchRole]);
      assert.deepEqual(granted, { fact_column_insert: true, job_column_insert: true,
        intent_dml: false, parent_dml: false, outbox_insert: false,
        dispatch_fact_insert: false });
      stage('reviewed-fact-and-job-column-grants', { granted });

      const admittedScope = scope(`image-${randomUUID()}`);
      const request = factory(admittedScope);
      await request.beforeSingleGrantDispatch(selected, 1, ticket(admittedScope.requestId), () => {}, bound);
      assert.deepEqual(events.slice(-1), ['budget.mark']);
      const commit = await request.persist(usage(storage, admittedScope, selected));
      await commit();
      const [durable] = await cluster.admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_dispatch_requests WHERE request_id=$1) AS parents,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_intents WHERE request_id=$1 AND state='dispatch_claimed') AS claims,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements WHERE request_id=$1) AS facts,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox WHERE request_id=$1) AS outbox,
        (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1 AND state='pending') AS pending_jobs,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs) AS financial_logs,
        (SELECT count(*)::int FROM ${schema}.user_audit_logs) AS financial_audits,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='image-user') AS budget_spent`,
      [admittedScope.requestId]);
      assert.deepEqual(durable, { parents: 1, claims: 1, facts: 1, outbox: 1,
        pending_jobs: 1, financial_logs: 0, financial_audits: 0, budget_spent: '0.000000' });
      const [fact] = await cluster.admin.unsafe(`SELECT context_sha256,payload_json
        FROM ${schema}.request_usage_settlements WHERE request_id=$1`, [admittedScope.requestId]);
      assert.equal(fact.context_sha256, bound.contextSha256);
      assert.ok(!fact.payload_json.includes('private request prompt'));
      assert.ok(!fact.payload_json.includes('private upstream key'));
      assert.ok(!fact.payload_json.includes('sensitive@example.invalid'));
      stage('factory-parent-claim-budget-mark-fact-outbox-and-pending-job', { durable,
        contextSha256: fact.context_sha256, sanitized: true });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      report.error = { name: error?.name ?? null, code: error?.code ?? null,
        message: String(error?.message ?? error).slice(0, 600) };
    } finally {
      try {
        await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
        await cluster.cleanup();
        report.cleanup = 'PASS';
      } catch (error) {
        report.cleanup = 'FAIL';
        report.cleanupError = String(error?.message ?? error).slice(0, 600);
        failure ??= error;
      }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(`Native Images factory report: ${reportFile}\n`);
    }
    if (failure) throw failure;
  });
