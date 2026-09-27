// Explicit, owned loopback PostgreSQL 18 integration fixture. No ambient
// DATABASE_URL, Hyperdrive origin, queue, provider, or cloud service is used.
import assert from 'node:assert/strict';
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { pgCoreSchema } from '../../../packages/core/src/storage/drizzle/schema.pg.ts';
import { createPostgresStorageContext } from '../../../packages/core/src/storage/context.ts';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { modelEndpointSupportsOperation, parseVerifiedModelEndpointSnapshot } from '../../../packages/core/src/model-endpoint-runtime.ts';
import { prepareGatewayApiKeyForStorage } from '../../../packages/core/src/lib/key-hash.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { createProxyApp } from '../../../packages/proxy/src/app.ts';
import { createRequestCapacityPool } from '../../../packages/proxy/src/services/request-capacity.ts';
import { drainNodeBackgroundWork } from '../../../packages/proxy/src/runtime/schedule-background-work.ts';
import { drainNodeResourceWork } from '../../../packages/proxy/src/runtime/schedule-resource-completion.ts';
import { openWorkerPostgresImageRecoveryOwner } from '../../../packages/proxy/src/runtime/worker-postgres-image-producer-owner.ts';
import { createPostgresFinancialConsumer, FINANCIAL_RECOVERY_ROLE } from '../../../packages/proxy/src/runtime/postgres-financial-consumer.ts';
import {
  buildFinancialConsumerDirectLoginGrant, FINANCIAL_CONSUMER_GRANT_ACTIVATION,
  FINANCIAL_CONSUMER_ROLE,
} from './build-financial-consumer-direct-login-grant.ts';
import { grantPostgresRuntime } from './grant-postgres-runtime.ts';
import { buildRequestParentDefaultAclActivation } from './build-request-parent-default-acl-activation.mjs';
import { buildRequestParentProducerGrant } from './build-request-parent-producer-grant.mjs';
import { buildImageFactJobProducerGrant } from './build-image-fact-job-producer-grant.mjs';

const schema = 'cinatoken_gateway';
const roles = Object.freeze({
  migrator: 'cinatoken_gateway_migrator',
  runtime: 'cinatoken_gateway_runtime',
  dispatch: 'cinatoken_gateway_dispatch_producer',
  fact: 'cinatoken_gateway_fact_producer',
  financial: FINANCIAL_RECOVERY_ROLE,
});
const migrations = new URL('../../../packages/core/migrations-postgres/', import.meta.url);
const guardSwitch = new URL('./postgres-recovery-legacy-log-guard.activate.sql', import.meta.url);
const replayBase = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-reservations.sql', import.meta.url);
const replayGate = new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-replay-parent-gate.sql', import.meta.url);
const proposals = [
  ['cinatoken.dispatch_intent_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/dispatch-intent-producer-definer.sql', import.meta.url)],
  ['cinatoken.request_dispatch_single_claim_activation', new URL('../../../packages/core/migrations-proposals/postgres/request-dispatch-single-claim.sql', import.meta.url)],
  ['cinatoken.settlement_outbox_definer_activation', new URL('../../../packages/core/migrations-proposals/postgres/settlement-outbox-producer-definer.sql', import.meta.url)],
];

const hash = value => createHash('sha256').update(value).digest('hex');
const summary = error => ({ name: error?.name ?? null, code: error?.code ?? null,
  position: error?.position ?? null, where: error?.where ?? null,
  message: String(error?.message ?? error).slice(0, 600) });
const adapter = raw => ({ driver: 'postgres', raw, drizzle: drizzle(raw, { schema: pgCoreSchema }) });

function roleUrl(cluster, role, password) {
  return `postgres://${role}:${password}@127.0.0.1:${cluster.port}/postgres?sslmode=disable`;
}

function roleClient(cluster, role, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username: role, password, ssl: false, max: 1, max_pipeline: 1,
    prepare: false, fetch_types: false, connect_timeout: 3,
    idle_timeout: 0, max_lifetime: 0, backoff: 0, onnotice() {},
    connection: { application_name: `cinatoken-native-image-http-${label}` } });
}

async function bundle(sql, body) {
  try { await sql.unsafe(body).simple(); }
  catch (error) { await sql.unsafe('ROLLBACK').simple(); throw error; }
}

async function activateProposal(migrator, setting, url) {
  await migrator.begin(async tx => {
    await tx.unsafe(`SET LOCAL ${setting} = 'reviewed-v1'`);
    await tx.unsafe(await readFile(url, 'utf8')).simple();
  });
}

async function grantFinancialFixture(admin, migrator, password) {
  assert.equal(roles.financial, FINANCIAL_CONSUMER_ROLE);
  await admin.unsafe(`REVOKE ALL ON DATABASE postgres FROM PUBLIC;
    REVOKE ALL ON DATABASE template1 FROM PUBLIC;
    REVOKE ALL ON SCHEMA public FROM PUBLIC;`).simple();
  const iterations = 32768, salt = randomBytes(20);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const storedKey = createHash('sha256').update(createHmac('sha256', salted).update('Client Key').digest()).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const scramVerifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}`
    + `$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
  const plan = await buildFinancialConsumerDirectLoginGrant({
    activation: FINANCIAL_CONSUMER_GRANT_ACTIVATION,
    role: roles.financial, database: 'postgres', roleConnectionLimit: 2,
    scramVerifier, replayReservationPhase: 'parent-gated',
  });
  await admin.unsafe(plan.adminSql).simple();
  await migrator.unsafe(plan.migratorSql).simple();
  const [role] = await admin.unsafe(`SELECT oid, rolcanlogin, rolinherit, rolsuper,
    rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname=$1`, [roles.financial]);
  assert.equal(role.rolcanlogin, true);
  for (const name of ['rolinherit', 'rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'])
    assert.equal(role[name], false, name);
  assert.equal((await admin.unsafe(`SELECT count(*)::int AS n FROM pg_catalog.pg_auth_members
    WHERE roleid=$1 OR member=$1`, [role.oid]))[0].n, 0);
}

test('native PG18 HTTP Images claim, fact/outbox/job and dedicated financial commit',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportFile = join(dirname(cluster.owned), `report-image-http-financial-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      scope: 'owned loopback PG18, actual Hono Images generation route, real runtime/dispatch/fact/financial LOGIN sessions',
      limitations: [
        'Three local direct URLs emulate separate Hyperdrive bindings; no real Worker, Hyperdrive or cloud origin was run.',
        'The provider response is a controlled local fetch function; no provider credential or external provider was called.',
        'No Queue delivery, ACK, cross-isolate exclusion or deployment was exercised.',
        'The parent, replay registry, outbox and producer grants are reviewed local proposals, not formal migrations.',
      ], stages: [], sourceSha256: {} };
    const clients = [];
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/);
      for (const [name, url] of [
        ['test', new URL(import.meta.url)],
        ['app', new URL('../../../packages/proxy/src/app.ts', import.meta.url)],
        ['images', new URL('../../../packages/proxy/src/routes/v1/images.ts', import.meta.url)],
        ['owner', new URL('../../../packages/proxy/src/runtime/worker-postgres-image-producer-owner.ts', import.meta.url)],
        ['consumer', new URL('../../../packages/proxy/src/runtime/postgres-financial-consumer.ts', import.meta.url)],
        ['financialAcl', new URL('./postgres-recovery-role-policy.ts', import.meta.url)],
        ['financialGrant', new URL('./build-financial-consumer-direct-login-grant.ts', import.meta.url)],
        ['runtimeGrant', new URL('./grant-postgres-runtime.ts', import.meta.url)],
        ['parentGrant', new URL('./build-request-parent-producer-grant.mjs', import.meta.url)],
        ['factGrant', new URL('./build-image-fact-job-producer-grant.mjs', import.meta.url)],
        ['replayBase', replayBase], ['replayGate', replayGate],
      ]) report.sourceSha256[name] = hash(await readFile(url));
      const passwords = Object.fromEntries(Object.keys(roles).map(role => [role, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE ${roles.migrator} LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE ${roles.runtime} LOGIN NOINHERIT PASSWORD '${passwords.runtime}';
        CREATE ROLE ${roles.dispatch} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.dispatch}';
        CREATE ROLE ${roles.fact} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${passwords.fact}';
        CREATE SCHEMA ${schema} AUTHORIZATION ${roles.migrator};
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO ${roles.migrator}, ${roles.runtime}, ${roles.dispatch}, ${roles.fact};`).simple();
      const migrator = roleClient(cluster, roles.migrator, passwords.migrator, 'migrator');
      clients.push(migrator);
      const migratorUrl = roleUrl(cluster, roles.migrator, passwords.migrator);
      await migrator.unsafe(`CREATE TABLE ${schema}.schema_migrations(
        version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
      const files = (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort();
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
      report.sourceSha256.formalMigrationCorpus = hash(corpus.join('\n'));
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await migrator.begin(async tx => {
        await tx.unsafe("SET LOCAL cinatoken.recovery_log_guard_activation = 'reviewed-v1'");
        await tx.unsafe(await readFile(guardSwitch, 'utf8')).simple();
      });
      for (const [setting, url] of proposals.slice(0, 2)) await activateProposal(migrator, setting, url);
      await bundle(migrator, await buildRequestParentDefaultAclActivation({ activation: 'reviewed-v1' }));
      // This fixture has no request rows or producer grant yet. The populated
      // legacy switch uses the separate one-transaction activation bundle.
      await activateProposal(migrator, 'cinatoken.request_dispatch_replay_reservations_activation', replayBase);
      await activateProposal(migrator, 'cinatoken.request_dispatch_replay_parent_gate_activation', replayGate);
      await activateProposal(migrator, ...proposals[2]);
      await grantPostgresRuntime({ DATABASE_URL: migratorUrl });
      await bundle(migrator, await buildRequestParentProducerGrant({ activation: 'reviewed-direct-login-v1' }));
      await bundle(migrator, await buildImageFactJobProducerGrant({ activation: 'reviewed-direct-login-v1' }));
      await grantFinancialFixture(cluster.admin, migrator, passwords.financial);
      stage('formal-schema-and-reviewed-local-roles', { formalMigrations: files.length });

      const gatewayKey = 'sk-native-image-http-' + randomUUID();
      const storedKey = await prepareGatewayApiKeyForStorage(gatewayKey);
      await migrator.unsafe(`INSERT INTO ${schema}.users(id,email,budget_max,budget_spent)
          VALUES ('http-user','http-image@example.invalid',10,0);
        INSERT INTO ${schema}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
          VALUES ('http-space','personal','http-user','HTTP Image Fixture','http-image-fixture','active');
        INSERT INTO ${schema}.providers(id,name,api_key,endpoints,status)
          VALUES ('http-provider','HTTP Provider','private-provider-key','{"openai":{"base":"https://provider.invalid/v1"}}','active');
        INSERT INTO ${schema}.models(id,display_name,vendor,input_modalities,output_modalities,route_policy)
          VALUES ('http-image-model','HTTP Image Model','test','["text","image"]','["image"]','{"strategy":"weight_priority"}');
        INSERT INTO ${schema}.route_pools(id,model_id,route_group,name,status)
          VALUES ('http-pool','http-image-model','default','HTTP Pool','active');
        INSERT INTO ${schema}.model_surfaces(id,model_id,route_group,request_protocol,request_operation,route_pool_id,status)
          VALUES ('http-surface','http-image-model','default','openai','images.generations','http-pool','active');
        INSERT INTO ${schema}.model_routes(id,model_id,provider_id,provider_model_name,route_pool_id,upstream_protocol,upstream_operation,adapter,status)
          VALUES ('http-route','http-image-model','http-provider','provider-image-model','http-pool','openai','images.generations','passthrough','active');
        INSERT INTO ${schema}.model_endpoints(id,model_id,provider_id,provider_slug,tag,pricing,image_capabilities,status,verified_by,verified_at,expires_at,evidence_url)
          VALUES ('http-endpoint','http-image-model','http-provider','test','test',
          '{"currency":"USD","prompt":"0","completion":"0"}',
          '{"provider_slug":"test","provider_tag":null,"supports_streaming":false,"supported_parameters":{"n":{"type":"range","min":1,"max":1}},"allowed_passthrough_parameters":[],"pricing":[{"billable":"output_image","unit":"image","cost_usd":"0.04"}]}',
          'verified','native-fixture',now(),'2099-01-01','https://provider.invalid/evidence');`,
      ).simple();
      await migrator.unsafe(`INSERT INTO ${schema}.api_keys
        (id,key,key_hash,key_preview,user_id,workspace_id)
        VALUES ('http-key',$1,$2,$3,'http-user','http-space')`,
      [storedKey.storageKey, storedKey.keyHash, storedKey.keyPreview]);
      const runtimeUrl = roleUrl(cluster, roles.runtime, passwords.runtime);
      const storage = await createPostgresStorageContext(runtimeUrl,
        { max: 1, prepare: false, fetch_types: false });
      clients.push(storage.client.raw);
      const route = (await storage.repositories.modelRouting.getModelRoutesByModelId('http-image-model'))[0];
      const provider = (await storage.repositories.providers.getProvidersByIds(['http-provider']))[0];
      assert.ok(route && provider);
      const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
      await migrator.unsafe(`INSERT INTO ${schema}.model_endpoint_routes(endpoint_id,route_target_id,subject_fingerprint)
        VALUES ('http-endpoint','http-route',$1)`, [fingerprint]);
      const [links, discovery, runtimeBindings, policies] = await Promise.all([
        storage.repositories.modelEndpoints.listRouteLinks(['http-endpoint']),
        storage.repositories.modelEndpoints.listDiscoveryRouteBindings(['http-endpoint']),
        storage.repositories.modelEndpoints.listRuntimeBindingsByRouteTargetIds(['http-route']),
        storage.repositories.routeDataPolicies.getByRouteTargetIds(['http-route']),
      ]);
      assert.equal(links.length, 1);
      assert.equal(discovery.length, 1);
      assert.equal(runtimeBindings.length, 1);
      assert.ok(Array.isArray(policies));
      assert.equal(policies.length, 0);
      assert.equal(links[0].subject_fingerprint, fingerprint);
      assert.equal(discovery[0].subject_fingerprint, fingerprint);
      assert.equal(runtimeBindings[0].subject_fingerprint, fingerprint);
      const verifiedEndpoint = parseVerifiedModelEndpointSnapshot(runtimeBindings[0]);
      assert.ok(verifiedEndpoint, 'Seeded endpoint must parse as verified');
      assert.equal(modelEndpointSupportsOperation(verifiedEndpoint, 'images.generations'), true);
      stage('seeded-real-runtime-routing-and-hashed-api-key',
        { endpointFingerprint: fingerprint, arrayBindingQueries: 4 });

      const bindings = {
        DATABASE_DRIVER: 'postgres', REQUEST_BODY_LOGGING: 'off',
        HYPERDRIVE: { connectionString: runtimeUrl },
        DISPATCH_HYPERDRIVE: { connectionString: roleUrl(cluster, roles.dispatch, passwords.dispatch) },
        FACT_HYPERDRIVE: { connectionString: roleUrl(cluster, roles.fact, passwords.fact) },
      };
      let owner, sends = 0;
      const fetchBoundaryObservations = [];
      async function observeFetchBoundary(phase) {
        const [observed] = await cluster.admin.unsafe(`SELECT
          (SELECT count(*)::int FROM ${schema}.request_dispatch_intents
            WHERE state='dispatch_claimed') AS committed_claims,
          (SELECT count(*)::int FROM ${schema}.request_usage_settlements) AS facts,
          (SELECT count(*)::int FROM pg_catalog.pg_stat_activity
            WHERE datname=pg_catalog.current_database()
              AND usename IN ('${roles.runtime}','${roles.dispatch}','${roles.fact}')
              AND xact_start IS NOT NULL) AS open_producer_transactions`);
        assert.deepEqual(observed, { committed_claims: 1, facts: 0,
          open_producer_transactions: 0 }, `${phase}: no database transaction may span provider fetch`);
        fetchBoundaryObservations.push({ phase, ...observed });
      }
      const capacity = createRequestCapacityPool({ maxRequests: 2, maxReservedBytes: 2 });
      const app = createProxyApp(async () => storage, {
        httpCapacity: { pool: capacity, reservedBytesPerRequest: 1 },
        postgresImageRecovery: { maxAttempts: 1, async open(context, requestStorage) {
          owner = await openWorkerPostgresImageRecoveryOwner(context, requestStorage);
          return owner;
        } },
        imageFetch: async (url, init) => {
          sends++;
          assert.match(String(url), /^https:\/\/provider\.invalid\/v1\/images\/generations$/);
          assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-provider-key');
          await observeFetchBoundary('before-provider-wait');
          await new Promise(resolve => setTimeout(resolve, 75));
          await observeFetchBoundary('during-provider-wait');
          return Response.json({ created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: 'AQID' }], usage: { input_tokens: 0, output_tokens: 0 } });
        },
      });
      const response = await app.fetch(new Request('https://gateway.invalid/v1/images/generations', {
        method: 'POST', headers: { Authorization: `Bearer ${gatewayKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'http-image-model', prompt: 'local fixture image', n: 1 }),
      }), bindings);
      const body = await response.text();
      assert.equal(response.status, 200, body);
      assert.equal(sends, 1);
      assert.equal(fetchBoundaryObservations.length, 2);
      assert.ok(owner?.authorities);
      await drainNodeBackgroundWork();
      await drainNodeResourceWork();
      assert.equal(capacity.snapshot().requests, 0);
      const [durableBefore] = await cluster.admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_dispatch_requests) AS parents,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_replay_tombstones) AS replay_reservations,
        (SELECT count(*)::int FROM ${schema}.request_dispatch_intents WHERE state='dispatch_claimed') AS claims,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlements) AS facts,
        (SELECT count(*)::int FROM ${schema}.request_usage_settlement_outbox) AS outbox,
        (SELECT count(*)::int FROM ${schema}.request_usage_recovery_jobs WHERE state='pending') AS pending_jobs,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs) AS logs,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='http-user') AS spent`);
      assert.deepEqual(durableBefore, { parents: 1, replay_reservations: 1,
        claims: 1, facts: 1, outbox: 1,
        pending_jobs: 1, logs: 0, spent: '0.000000' });
      const [fact] = await cluster.admin.unsafe(`SELECT request_id, payload_json
        FROM ${schema}.request_usage_settlements`);
      assert.ok(fact.request_id);
      const settlement = JSON.parse(fact.payload_json);
      assert.equal(settlement.params.chargedCost, 0.04);
      assert.equal(settlement.params.requestLog.chargedCost, 0.04);
      for (const secret of [gatewayKey, 'private-provider-key', 'local fixture image', 'http-image@example.invalid'])
        assert.ok(!fact.payload_json.includes(secret), `fact must not contain ${secret}`);
      stage('http-auth-route-fetch-parent-claim-fact-outbox-pending-job',
        { responseStatus: response.status, sends, fetchBoundaryObservations,
          durable: durableBefore, chargedCost: settlement.params.chargedCost });

      const financialRaw = roleClient(cluster, roles.financial, passwords.financial, 'financial');
      clients.push(financialRaw);
      const [identity] = await financialRaw.unsafe('SELECT current_user AS current_role, session_user AS session_role');
      assert.deepEqual(identity, { current_role: roles.financial, session_role: roles.financial });
      const financialCapacity = createRequestCapacityPool({ maxRequests: 2, maxReservedBytes: 32 });
      const consumer = createPostgresFinancialConsumer({ enabled: true,
        runtime: storage.client,
        dispatchProducer: owner.authorities.claimProducer,
        factProducer: owner.authorities.factProducer,
        openInvocationClient: async () => adapter(financialRaw),
        retireConfirmedClient: async client => { assert.equal(client.raw, financialRaw);
          await financialRaw.end({ timeout: 1 }); },
        capacity: financialCapacity,
        limits: { scope: { kind: 'all' }, maxRegistrations: 2, maxItems: 2,
          concurrency: 1, leaseSeconds: 30, runBudgetMs: 10000,
          reservedBytesPerConsumer: 7, reservedBytesPerScan: 11 },
      });
      const outcome = await consumer.runOnce();
      assert.equal(outcome.status, 'run_drained', JSON.stringify(outcome));
      assert.equal(outcome.queueAckSafe, false);
      assert.equal(outcome.result.committed, 1);
      const [durableAfter] = await cluster.admin.unsafe(`SELECT
        (SELECT count(*)::int FROM ${schema}.request_usage_commit_receipts WHERE request_id=$1) AS receipts,
        (SELECT count(*)::int FROM ${schema}.api_key_request_logs WHERE id=$1) AS logs,
        (SELECT count(*)::int FROM ${schema}.provider_attempt_availability WHERE request_log_id=$1) AS attempts,
        (SELECT count(*)::int FROM ${schema}.user_audit_logs WHERE request_log_id=$1) AS audits,
        (SELECT budget_spent::text FROM ${schema}.users WHERE id='http-user') AS spent,
        (SELECT state FROM ${schema}.request_usage_recovery_jobs WHERE request_id=$1) AS job_state`, [fact.request_id]);
      assert.equal(durableAfter.receipts, 1);
      assert.equal(durableAfter.logs, 1);
      assert.equal(durableAfter.attempts, 1);
      assert.equal(durableAfter.audits, 1);
      assert.equal(durableAfter.job_state, 'committed');
      assert.equal(durableAfter.spent, '0.040000');
      stage('dedicated-financial-login-committed-http-fact',
        { durable: durableAfter, queueAckSafe: outcome.queueAckSafe });
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL'; report.error = summary(error);
    } finally {
      await Promise.allSettled(clients.map(client => client.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = summary(error); failure ??= error; }
      await writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      console.log('Native HTTP Images financial report: ' + reportFile);
    }
    if (failure) throw failure;
  });
