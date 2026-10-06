// Review-only counterexample: a quoted route manifest is not a Chat selector.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import postgres from 'postgres';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '../../../packages/core/src/route-data-policy.ts';
import { providerSupportsUpstreamProtocol } from '../../../packages/core/src/provider-endpoints.ts';
import { parseVerifiedModelEndpointSnapshot, modelEndpointSupportsOperation } from '../../../packages/core/src/model-endpoint-runtime.ts';
import { createPostgresStorageContext } from '../../../packages/core/src/storage/context.ts';
import { startNativePostgres } from '../../../packages/core/src/test-support/postgres-native-cluster.mjs';
import { resolveRoutesForSurface, resolveRouteResultsFromRows } from '../../../packages/proxy/src/services/model-router.ts';
import { buildModelFallbackPlan } from '../../../packages/proxy/src/services/model-fallback-plan.ts';
import { grantPg73RuntimeFixture, listPg73Migrations } from './pg73-native-fixture.mjs';

const root = new URL('../../../', import.meta.url);
const fixtureUrl = new URL(import.meta.url);
const loadedFixtureSha256 = createHash('sha256').update(await readFile(fixtureUrl)).digest('hex');
const reportUrl = new URL('docs/developers/architecture/implementation-evidence/C04-complete-text-manifest-selection-v393-report.json', root);
const g = 'cinatoken_gateway';
const sha = value => createHash('sha256').update(value).digest('hex');
const roles = {
  cap: 'cinatoken_gateway_request_capability_issuer',
  claim: 'cinatoken_gateway_request_capability_claim',
  fragment: 'cinatoken_gateway_request_route_ceiling_issuer',
  verifier: 'cinatoken_gateway_route_source_verifier',
  complete: 'cinatoken_gateway_complete_text_quote_issuer',
  planner: 'cinatoken_gateway_complete_text_ingress_planner',
};
const overlays = [
  ['authenticated-request-capability-login-v356.sql', 'cinatoken.request_capability_login_activation'],
  ['authenticated-text-route-ceiling-issuer-v357.sql', 'cinatoken.request_route_ceiling_activation'],
  ['authenticated-text-route-source-fence-v359.sql', 'cinatoken.route_source_fence_activation'],
  ['authenticated-complete-text-quote-v360.sql', 'cinatoken.complete_text_quote_activation'],
  ['complete-text-secretless-plan-v365.sql', 'cinatoken.complete_text_secretless_plan_activation'],
];
const sourcePaths = [
  'scripts/db/cutover/postgres-complete-text-manifest-selection-v393.native.test.mjs',
  'scripts/db/cutover/postgres-complete-text-manifest-selection-v393.tsconfig.json',
  'scripts/db/cutover/grant-postgres-runtime.ts',
  'packages/core/src/test-support/postgres-native-cluster.mjs',
  'packages/core/src/db/postgres/model-endpoints.impl.ts',
  'packages/core/src/storage/model-endpoints.sql-repositories.test.ts',
  'node_modules/drizzle-orm/postgres-js/driver.js',
  'node_modules/drizzle-orm/package.json',
  'node_modules/postgres/src/types.js',
  'node_modules/postgres/package.json',
  'packages/proxy/src/services/model-router.ts',
  'packages/proxy/src/services/route-selection.ts',
  'packages/proxy/src/services/model-fallback-plan.ts',
  'packages/proxy/src/services/provider-routing-preferences.ts',
  'packages/proxy/src/services/provider-performance-routing.ts',
  'packages/proxy/src/services/provider-default-load-balancing.ts',
  'packages/proxy/src/services/provider-circuit-breaker.ts',
  'packages/proxy/src/services/resolve-model-route-group.ts',
  'packages/proxy/src/services/route-strategies/index.ts',
  'packages/proxy/src/services/route-strategies/hash-affinity.ts',
  'packages/proxy/src/services/route-strategies/weighted-random.ts',
  'packages/proxy/src/services/route-strategies/weight-priority.ts',
  'packages/proxy/src/services/route-strategies/weighted-round-robin.ts',
  'packages/proxy/src/services/route-strategies/route-affinity-hash.ts',
  'packages/proxy/src/services/gateway-error-codes.ts',
  ...overlays.map(([name]) => `packages/core/migrations-proposals/postgres/${name}`),
];
async function sourcePins() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(new URL(path, root)))])));
}
// The selector imports the source core entry through this fixture's tsx config.
// Pin every core TypeScript source, including transitive selector/repository code.
async function coreCorpus() {
  const paths = [];
  async function walk(relative) {
    for (const entry of await readdir(new URL(relative + '/', root), { withFileTypes: true })) {
      const next = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) paths.push(next);
    }
  }
  await walk('packages/core/src');
  paths.sort();
  const bodies = await Promise.all(paths.map(async path => `${path}\n${await readFile(new URL(path, root), 'utf8')}`));
  return { files: paths.length, sha256: sha(bodies.join('\n')) };
}
function connection(cluster, username, password, label) {
  return postgres({ host: '127.0.0.1', port: cluster.port, database: 'postgres',
    username, password, ssl: false, max: 1, prepare: false, fetch_types: false,
    connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false,
    onnotice() {}, connection: { application_name: `manifest-selection-v393-${label}` } });
}

test('v393 genuine quote/planner manifest includes a valid route excluded by the actual Chat surface',
  { timeout: 300_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    assert.ok(process.env.TSX_TSCONFIG_PATH?.replaceAll('\\', '/').endsWith(
      'scripts/db/cutover/postgres-complete-text-manifest-selection-v393.tsconfig.json'),
    'Run with the dedicated TSX_TSCONFIG_PATH to load current core source, not dist');
    const initialPins = await sourcePins();
    const initialCore = await coreCorpus();
    assert.equal(initialPins['scripts/db/cutover/postgres-complete-text-manifest-selection-v393.native.test.mjs'], loadedFixtureSha256);
    const cluster = await startNativePostgres();
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion,
      sourceSha256: initialPins, coreSourceCorpus: initialCore, stages: [], limitations: [
        'PASS proves an integration blocker: the v360/v365 route manifest is a budget/source superset, not a complete eligible Chat route order.',
        'Review-only local PG73 plus existing v356/v357/v359/v360/v365 proposals; no migration, remote database, Worker binding or deployment changed.',
        'The baseline uses the actual resolveRoutesForSurface, buildModelFallbackPlan and PostgreSQL repositories with the legacy runtime role. That credential-aware role is a comparison oracle, not a proposed secretless Gateway identity.',
        'Provider credentials and endpoint evidence are synthetic. No decryption, provider POST, admission, send grant, result fact or settlement is attempted.',
        'This two-model exact/wildcard surface counterexample does not establish full route-strategy, sticky, provider-control or fallback equivalence. Those remain obligations of a future credential-free selector.',
        'Node/local PostgreSQL execution does not establish workerd, Service Binding or Hyperdrive behavior.',
      ] };
    const stage = (name, detail = {}) => report.stages.push({ name, result: 'PASS', ...detail });
    const clients = [];
    let failure;
    try {
      assert.match(cluster.binaryVersion, /PostgreSQL\) 18\.6/u);
      const labels = ['migrator', 'runtime', ...Object.keys(roles)];
      const passwords = Object.fromEntries(labels.map(label => [label, randomBytes(24).toString('hex')]));
      await cluster.admin.unsafe(`CREATE ROLE cinatoken_gateway_migrator LOGIN PASSWORD '${passwords.migrator}';
        CREATE ROLE cinatoken_gateway_runtime LOGIN PASSWORD '${passwords.runtime}';
        ${Object.entries(roles).map(([label, name]) => `CREATE ROLE ${name} LOGIN NOINHERIT PASSWORD '${passwords[label]}';`).join('\n')}
        CREATE SCHEMA ${g} AUTHORIZATION cinatoken_gateway_migrator;
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE postgres TO cinatoken_gateway_migrator,
          cinatoken_gateway_runtime,${Object.values(roles).join(',')};
        GRANT CREATE ON DATABASE postgres TO cinatoken_gateway_migrator;`).simple();
      const migrator = connection(cluster, 'cinatoken_gateway_migrator', passwords.migrator, 'migrator');
      const cap = connection(cluster, roles.cap, passwords.cap, 'cap');
      const verifier = connection(cluster, roles.verifier, passwords.verifier, 'verifier');
      const complete = connection(cluster, roles.complete, passwords.complete, 'complete');
      const planner = connection(cluster, roles.planner, passwords.planner, 'planner');
      clients.push(migrator, cap, verifier, complete, planner);
      await migrator.unsafe(`CREATE TABLE ${g}.schema_migrations
        (version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())`);
      const migrations = new URL('packages/core/migrations-postgres/', root);
      const names = await listPg73Migrations();
      assert.equal(names.length, 73);
      const corpus = [];
      for (const name of names) {
        const body = await readFile(new URL(name, migrations), 'utf8');
        corpus.push(`${name}\n${body}`);
        await migrator.begin(async tx => {
          await tx.unsafe(body).simple();
          await tx.unsafe(`INSERT INTO ${g}.schema_migrations(version) VALUES($1)`, [name]);
        });
      }
      report.formalMigrations = { files: names.length, sha256: sha(corpus.join('\n')) };
      const migratorUrl = `postgres://cinatoken_gateway_migrator:${passwords.migrator}@127.0.0.1:${cluster.port}/postgres`;
      await grantPg73RuntimeFixture({ cluster, migrator, migratorUrl });
      for (const [name, flag] of overlays) {
        const sql = await readFile(new URL(`packages/core/migrations-proposals/postgres/${name}`, root), 'utf8');
        await migrator.begin(async tx => {
          await tx.unsafe(`SET LOCAL ${flag}='reviewed-v1'`);
          await tx.unsafe(sql).simple();
        });
      }
      stage('formal-pg73-and-real-v356-v357-v359-v360-v365-proposals-installed');

      const storage = await createPostgresStorageContext(
        `postgres://cinatoken_gateway_runtime:${passwords.runtime}@127.0.0.1:${cluster.port}/postgres`,
        { max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
          idle_timeout: 0, max_lifetime: 0, backoff: false, onnotice() {} });
      clients.push(storage.client.raw);
      const [runtimeIdentity] = await storage.client.raw.unsafe('SELECT current_user,session_user');
      assert.deepEqual(runtimeIdentity, { current_user: 'cinatoken_gateway_runtime', session_user: 'cinatoken_gateway_runtime' });
      const [plannerIdentity] = await planner.unsafe('SELECT current_user,session_user');
      assert.deepEqual(plannerIdentity, { current_user: roles.planner, session_user: roles.planner });
      await assert.rejects(planner.unsafe(`SELECT api_key,endpoints FROM ${g}.providers`), error => error.code === '42501');
      stage('real-repository-runtime-and-separate-secretless-planner-logins', { runtimeIdentity, plannerIdentity });

      const bearer = 'sk-local-manifest-selection-v393-bearer';
      const lookupHash = `sha256:${sha(bearer)}`;
      await migrator.unsafe(`INSERT INTO ${g}.users(id,email,budget_max)
        VALUES('v393-user','v393@example.invalid',1);
        INSERT INTO ${g}.workspaces(id,scope_type,personal_owner_user_id,name,slug,status)
        VALUES('v393-workspace','personal','v393-user','Manifest','v393','active');`).simple();
      await migrator.unsafe(`INSERT INTO ${g}.api_keys(id,key,key_hash,user_id,workspace_id,status)
        VALUES('v393-key',$1,$2,'v393-user','v393-workspace','active')`, [`hashref:${lookupHash}`, lookupHash]);
      await migrator.unsafe(`INSERT INTO ${g}.providers(id,name,api_key,endpoints,status)
        VALUES('v393-provider','V393 Provider','enc:v2:v393-provider-secret-sentinel',
          '{"openai":{"endpoints":{"chat":"https://secret.invalid/chat?key=v393-url-secret-sentinel"}}}', 'active');
        INSERT INTO ${g}.models(id,vendor) VALUES('v393-alpha','other'),('v393-beta','other');
        INSERT INTO ${g}.route_pools(id,model_id,route_group,name,status)
        VALUES('v393-pool-a','v393-alpha','default','Alpha exact','active'),
          ('v393-pool-b','v393-alpha','default','Alpha wildcard','active'),
          ('v393-pool-beta','v393-beta','default','Beta','active');
        INSERT INTO ${g}.model_surfaces(id,model_id,route_group,request_protocol,request_operation,route_pool_id,status)
        VALUES('v393-surface-exact','v393-alpha','default','openai','chat','v393-pool-a','active'),
          ('v393-surface-wildcard','v393-alpha','default','openai','*','v393-pool-b','active'),
          ('v393-surface-beta','v393-beta','default','openai','chat','v393-pool-beta','active');
        INSERT INTO ${g}.model_routes(id,model_id,provider_id,provider_model_name,route_pool_id,
          upstream_protocol,upstream_operation,adapter,status)
        VALUES('v393-route-z','v393-alpha','v393-provider','upstream-exact','v393-pool-a','openai','chat','passthrough','active'),
          ('v393-route-a','v393-alpha','v393-provider','upstream-wildcard','v393-pool-b','openai','chat','passthrough','active'),
          ('v393-route-beta','v393-beta','v393-provider','upstream-beta','v393-pool-beta','openai','chat','passthrough','active');`).simple();
      for (const [suffix, model] of [['z', 'alpha'], ['a', 'alpha'], ['beta', 'beta']]) {
        await migrator.unsafe(`INSERT INTO ${g}.model_endpoints(id,model_id,provider_id,provider_slug,tag,endpoint_class,context_length,max_completion_tokens,pricing,
          supports_implicit_caching,supports_voice_cloning,supports_tool_choice,evidence_url,verified_by,verified_at,expires_at,status)
          VALUES($1,$2,'v393-provider','v393-provider',$3,'standard',1000,1000,
            '{"currency":"USD","prompt":"0.000002","completion":"0.000004"}',
            false,false,'{"auto":false,"function":false,"none":false,"required":false}',
            'https://evidence.invalid/v393','fixture',now()-interval '1 minute',now()+interval '5 minutes','verified')`,
        [`v393-endpoint-${suffix}`, `v393-${model}`, suffix]);
        await migrator.unsafe(`INSERT INTO ${g}.model_endpoint_routes(endpoint_id,route_target_id) VALUES($1,$2)`,
          [`v393-endpoint-${suffix}`, `v393-route-${suffix}`]);
      }
      for (const target of ['v393-route-z', 'v393-route-a', 'v393-route-beta']) {
        const [route] = await migrator.unsafe(`SELECT provider_id,provider_model_name,custom_params,
          upstream_protocol,upstream_operation,adapter FROM ${g}.model_routes WHERE id=$1`, [target]);
        const [provider] = await migrator.unsafe(`SELECT id,endpoints,api_key,shared_channel_type FROM ${g}.providers WHERE id=$1`, [route.provider_id]);
        const fingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
        await migrator.unsafe(`UPDATE ${g}.model_endpoint_routes SET subject_fingerprint=$1 WHERE route_target_id=$2`, [fingerprint, target]);
        const [source] = await verifier.unsafe(`SELECT generation::text AS generation FROM ${g}.route_source_generations_v359 WHERE route_target_id=$1`, [target]);
        const [attested] = await verifier.unsafe(`SELECT ${g}.attest_text_route_source_v359($1,$2,$3) AS value`, [target, source.generation, fingerprint]);
        assert.equal(attested.value.status, 'attested');
      }
      stage('two-model-three-route-exact-and-wildcard-topology-genuinely-attested');

      const repos = storage.repositories;
      const runtimeBindings = await repos.modelEndpoints.listRuntimeBindingsByRouteTargetIds(['v393-route-z', 'v393-route-z']);
      assert.deepEqual(runtimeBindings.map(row => row.route_target_id), ['v393-route-z']);
      const routeLinks = await repos.modelEndpoints.listRouteLinks(['v393-endpoint-z', 'v393-endpoint-a']);
      assert.deepEqual(routeLinks.map(row => row.route_target_id), ['v393-route-a', 'v393-route-z']);
      const discoveryBindings = await repos.modelEndpoints.listDiscoveryRouteBindings(['v393-endpoint-z']);
      assert.deepEqual(discoveryBindings.map(row => row.id), ['v393-route-z']);
      stage('three-jsonb-array-repository-reads-work-through-real-drizzle-postgres-client', {
        runtimeBindings: runtimeBindings.length, routeLinks: routeLinks.length,
        discoveryBindings: discoveryBindings.length,
      });
      const [actualProvider] = await repos.providers.getProvidersByIds(['v393-provider']);
      const [actualRoute] = await repos.modelRouting.getModelRoutesByPoolId('v393-pool-a');
      assert.equal(providerSupportsUpstreamProtocol('openai', actualProvider), true);
      const actualEndpoint = parseVerifiedModelEndpointSnapshot(runtimeBindings[0]);
      assert.ok(actualEndpoint, 'real endpoint row must pass the unchanged runtime parser');
      assert.equal(modelEndpointSupportsOperation(actualEndpoint, 'chat'), true);
      assert.equal(await computeRouteDataPolicySubjectFingerprintFromRows(actualRoute, actualProvider),
        runtimeBindings[0].subject_fingerprint);
      stage('real-repository-provider-endpoint-capability-and-subject-parse-controls');
      const alpha = await resolveRoutesForSurface(repos, { modelId: 'v393-alpha', routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat' });
      const beta = await resolveRoutesForSurface(repos, { modelId: 'v393-beta', routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat' });
      assert.equal(alpha.surface.id, 'v393-surface-exact');
      assert.equal(alpha.surface.route_pool_id, 'v393-pool-a');
      assert.deepEqual(alpha.routes.map(route => route.targetId), ['v393-route-z']);
      assert.deepEqual(beta.routes.map(route => route.targetId), ['v393-route-beta']);
      const siblingRows = await repos.modelRouting.getModelRoutesByPoolId('v393-pool-b');
      const independentlyValidSibling = await resolveRouteResultsFromRows(repos, siblingRows);
      assert.deepEqual(independentlyValidSibling.map(route => route.targetId), ['v393-route-a']);
      stage('actual-chat-selector-prefers-exact-surface-and-excludes-valid-wildcard-pool', {
        selectedSurfaceId: alpha.surface.id, selectedPoolId: alpha.surface.route_pool_id,
        eligibleAlpha: alpha.routes.map(route => route.targetId), eligibleBeta: beta.routes.map(route => route.targetId),
        independentlyValidWildcardPool: independentlyValidSibling.map(route => route.targetId),
      });

      const finalBody = JSON.stringify({ model: 'v393-alpha', models: ['v393-alpha', 'v393-beta'],
        messages: [{ role: 'user', content: 'hello' }], max_completion_tokens: 300 });
      const legacyPlan = await buildModelFallbackPlan(repos, {
        modelIds: ['v393-alpha', 'v393-beta'], body: JSON.parse(finalBody),
        requestProtocol: 'openai', requestOperation: 'chat',
      });
      assert.equal(legacyPlan.ok, true, JSON.stringify(legacyPlan));
      assert.deepEqual(legacyPlan.candidates.map(candidate => [candidate.baseModelId, candidate.routes.map(route => route.targetId)]), [
        ['v393-alpha', ['v393-route-z']], ['v393-beta', ['v393-route-beta']],
      ]);
      stage('actual-chat-fallback-plan-accepts-same-body-and-keeps-only-surface-eligible-routes', {
        candidates: legacyPlan.candidates.map(candidate => ({ modelId: candidate.baseModelId,
          eligibleRoutes: candidate.routes.map(route => route.targetId), strategy: candidate.strategy.base })),
      });
      const requestId = `v393-${randomUUID()}`;
      const originalHash = sha(finalBody);
      const [issued] = await cap.unsafe(`SELECT ${g}.issue_request_capability_v356($1,$2,$3) AS value`, [requestId, bearer, originalHash]);
      assert.equal(issued.value.status, 'issued');
      const [quoted] = await complete.unsafe(`SELECT ${g}.issue_complete_flat_text_quote_v360($1,$2,$3,$4) AS value`,
        [requestId, issued.value.capability, originalHash, finalBody]);
      assert.equal(quoted.value.status, 'quoted_complete_subset');
      assert.equal(quoted.value.routeCount, 3);
      stage('genuine-v360-quote-accepts-two-models-and-all-three-attested-routes', {
        status: quoted.value.status, routeCount: quoted.value.routeCount,
      });
      const [planned] = await planner.unsafe(`SELECT ${g}.plan_complete_flat_text_quote_v365($1,$2) AS value`, [requestId, quoted.value.quoteId]);
      assert.equal(planned.value.status, 'planned_complete_subset');
      assert.deepEqual(planned.value.orderedModelIds, ['v393-alpha', 'v393-beta']);
      assert.equal(planned.value.candidateCount, 2);
      assert.equal(planned.value.routeCount, 3);
      assert.deepEqual(planned.value.routes.map(route => [route.candidateIndex, route.modelId, route.routeTargetId]), [
        [0, 'v393-alpha', 'v393-route-a'], [0, 'v393-alpha', 'v393-route-z'], [1, 'v393-beta', 'v393-route-beta'],
      ]);
      assert.ok(planned.value.routes.every(route => Object.keys(route).sort().join(',') ===
        'attestedSourceSha256,candidateIndex,modelId,routeTargetId,sourceGeneration'));
      const encoded = JSON.stringify(planned.value);
      for (const forbidden of ['secret-sentinel', 'secret.invalid', 'enc:v2:', 'providerId', 'providerEndpoints', 'providerModelName']) {
        assert.equal(encoded.includes(forbidden), false, forbidden);
      }
      stage('genuine-v365-secretless-manifest-orders-unselected-route-before-eligible-route', {
        status: planned.value.status, orderedModelIds: planned.value.orderedModelIds,
        routes: planned.value.routes,
      });
      const firstManifestRoute = planned.value.routes[0].routeTargetId;
      assert.equal(firstManifestRoute, 'v393-route-a');
      assert.equal(alpha.routes.some(route => route.targetId === firstManifestRoute), false);
      // Re-run the real selector after the committed quote: no intervening route
      // edits or stale source are needed for the mismatch.
      const unchanged = await resolveRoutesForSurface(repos, { modelId: 'v393-alpha', routeGroup: 'default', requestProtocol: 'openai', requestOperation: 'chat' });
      assert.deepEqual(unchanged.routes.map(route => route.targetId), ['v393-route-z']);
      stage('manifest-first-is-not-current-chat-eligible-without-any-source-mutation', {
        proposedManifestFirst: firstManifestRoute, actualEligible: unchanged.routes.map(route => route.targetId),
        blocker: 'A future secretless Gateway must derive trusted surface eligibility before route strategy and grant selection.',
      });

      assert.deepEqual(await sourcePins(), initialPins);
      assert.deepEqual(await coreCorpus(), initialCore);
      assert.equal(sha(await readFile(fixtureUrl)), loadedFixtureSha256);
      stage('loaded-fixture-all-file-pins-and-core-source-corpus-remain-unchanged');
      report.status = 'PASS';
    } catch (error) {
      failure = error;
      report.status = 'FAIL';
      const cause = error?.cause ?? error;
      report.failure = { code: cause?.code ?? null, constraint: cause?.constraint_name ?? null,
        message: String(error?.stack ?? error).slice(0, 5000) };
    } finally {
      await Promise.allSettled(clients.map(sql => sql.end({ timeout: 1 })));
      try { await cluster.cleanup(); report.cleanup = 'PASS'; }
      catch (error) { report.cleanup = 'FAIL'; report.cleanupError = String(error?.stack ?? error).slice(0, 1500); failure ??= error; }
      await writeFile(reportUrl, JSON.stringify(report, null, 2) + '\n');
      process.stdout.write(`complete-text-v393-report=${reportUrl.pathname}\n`);
    }
    if (failure) throw failure;
    assert.equal(report.cleanup, 'PASS');
  });
