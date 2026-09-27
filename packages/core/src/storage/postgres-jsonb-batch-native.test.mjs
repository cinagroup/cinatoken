import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createPostgresModelEndpointsRepository } from '../db/postgres/model-endpoints.impl.ts';
import { createPostgresRouteDataPoliciesRepository } from '../db/postgres/route-data-policies.impl.ts';
import { MAX_MODEL_ENDPOINT_LIST_LIMIT } from '../db/model-endpoints-types.ts';
import { startNativePostgres } from '../test-support/postgres-native-cluster.mjs';

test('PostgreSQL JSONB batch boundary successor works with plain and Drizzle clients',
  { timeout: 120_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
    const reportPath = join(dirname(cluster.owned), `report-jsonb-batch-boundary-${randomUUID()}.json`);
    const report = { status: 'RUNNING', cleanup: 'PENDING', binaryVersion: cluster.binaryVersion, modes: [],
      limitations: ['Owned loopback PostgreSQL only; predecessor source saved separately; no vendor serializer mutation or remote service.'], sourceSha256: {} };
    for (const [name, path] of [['nativeTest', new URL(import.meta.url)],
      ['endpoints', new URL('../db/postgres/model-endpoints.impl.ts', import.meta.url)],
      ['policies', new URL('../db/postgres/route-data-policies.impl.ts', import.meta.url)]])
      report.sourceSha256[name] = createHash('sha256').update(await readFile(path)).digest('hex');
    let failure;
    try {
      const pg = cluster.admin;
      await pg.unsafe(`
        CREATE TABLE route_pools (id text PRIMARY KEY, status text);
        CREATE TABLE model_routes (
          id text PRIMARY KEY, model_id text, provider_id text,
          provider_model_name text, status text, route_group text,
          custom_params jsonb, routing_metadata jsonb,
          upstream_protocol text, upstream_operation text, adapter text,
          route_pool_id text
        );
        CREATE TABLE model_endpoints (
          id text PRIMARY KEY, model_id text, provider_id text,
          provider_slug text, tag text, endpoint_class text, region text,
          context_length integer, max_prompt_tokens integer,
          max_completion_tokens integer, quantization text,
          supported_parameters jsonb, pricing jsonb,
          supports_implicit_caching boolean, supports_voice_cloning boolean,
          supports_tool_choice jsonb, image_capabilities jsonb,
          audio_capabilities jsonb, evidence_url text, verified_by text,
          verified_at timestamptz, expires_at timestamptz, status text,
          created_at timestamptz, updated_at timestamptz
        );
        CREATE TABLE model_endpoint_routes (
          endpoint_id text, route_target_id text, subject_fingerprint text,
          created_at timestamptz
        );
        CREATE TABLE route_data_policies (
          route_target_id text, subject_fingerprint text,
          retention_days integer, training_allowed boolean,
          zdr_supported boolean, evidence_url text, verified_by text,
          verified_at timestamptz, expires_at timestamptz, status text,
          invalidated_at timestamptz, invalidation_reason text,
          updated_at timestamptz
        );
        INSERT INTO route_pools(id,status) VALUES ('pool-a','active');
        INSERT INTO model_routes(id,model_id,provider_id,provider_model_name,
          status,route_group,upstream_protocol,upstream_operation,adapter,route_pool_id)
          VALUES ('route-a','model-a','provider-a','upstream-a',
            'active','default','openai','chat','passthrough','pool-a');
        INSERT INTO model_endpoints(id,model_id,provider_id,provider_slug,tag,
          endpoint_class,status,created_at,updated_at)
          VALUES ('endpoint-a','model-a','provider-a','provider-a','standard',
            'standard','verified',now(),now());
        INSERT INTO model_endpoint_routes(endpoint_id,route_target_id,
          subject_fingerprint,created_at)
          VALUES ('endpoint-a','route-a','fingerprint-a',now());
        INSERT INTO route_data_policies(route_target_id,subject_fingerprint,
          status,verified_at,expires_at,updated_at)
          VALUES ('route-a','fingerprint-a','verified',now(),now()+interval '1 day',now());
      `).simple();

      // Plain postgres.js double-encodes an untyped pre-rendered JSON string.
      await assert.rejects(pg.unsafe(
        'SELECT pg_catalog.jsonb_array_elements_text($1::jsonb) AS id',
        [JSON.stringify(['route-a'])],
      ), /cannot extract elements from a scalar/u);

      const exoticRoute = `route-"\\'); SELECT pg_sleep(9); --☃`, exoticEndpoint = `endpoint-"\\'); DROP TABLE model_routes; --☃`;
      await pg.unsafe(`INSERT INTO model_routes(id,model_id,provider_id,provider_model_name,status,route_group,upstream_protocol,upstream_operation,adapter,route_pool_id)
        VALUES($1,'model-a','provider-a','upstream-a','active','default','openai','chat','passthrough','pool-a')`, [exoticRoute]);
      await pg.unsafe(`INSERT INTO model_endpoints(id,model_id,provider_id,provider_slug,tag,endpoint_class,status,created_at,updated_at)
        VALUES($1,'model-a','provider-a','provider-a','weird','standard','verified',now(),now())`, [exoticEndpoint]);
      await pg.unsafe(`INSERT INTO model_endpoint_routes(endpoint_id,route_target_id,subject_fingerprint,created_at)
        VALUES($1,$2,'fingerprint-weird',now())`, [exoticEndpoint, exoticRoute]);
      await pg.unsafe(`INSERT INTO route_data_policies(route_target_id,subject_fingerprint,status,verified_at,expires_at,updated_at)
        VALUES($1,'fingerprint-weird','verified',now(),now()+interval '1 day',now())`, [exoticRoute]);

      const oldDrizzle = cluster.client('jsonb-predecessor-drizzle', { prepare: false }); drizzle(oldDrizzle);
      const oldParameter = oldDrizzle.json(['route-a']);
      // Exact predecessor's pg.json(Array) reaches a transparent serializer:
      // Node cannot encode that Array as PostgreSQL parameter bytes.
      assert.ok(Array.isArray(oldDrizzle.options.serializers[114](oldParameter.value)));
      await assert.rejects(oldDrizzle.unsafe('SELECT pg_catalog.jsonb_array_elements_text($1::jsonb)', [oldParameter]),
        error => error?.code === 'ERR_INVALID_ARG_TYPE' && /Array/u.test(error.message));
      await oldDrizzle.end({ timeout: 1 });

      for (const mode of ['plain', 'drizzle']) {
        const raw = cluster.client(`jsonb-${mode}`, { prepare: false });
        const db = { driver: 'postgres', raw, ...(mode === 'drizzle' ? { drizzle: drizzle(raw) } : {}) };
        const parameter = raw.typed(JSON.stringify([exoticRoute]), 25);
        const bytes = raw.options.serializers[parameter.type](parameter.value);
        assert.equal(typeof bytes, 'string'); assert.ok(Buffer.byteLength(bytes) > 0);
        assert.deepEqual(JSON.parse(bytes), [exoticRoute]);
        const endpoints = createPostgresModelEndpointsRepository(db), policies = createPostgresRouteDataPoliciesRepository(db);
        const linked = await endpoints.listRouteLinks(['endpoint-a', exoticEndpoint, exoticEndpoint, 'absent']);
        assert.deepEqual(new Set(linked.map(row => row.route_target_id)), new Set(['route-a', exoticRoute])); assert.equal(linked.length, 2);
        const discovered = await endpoints.listDiscoveryRouteBindings([exoticEndpoint, exoticEndpoint]);
        assert.deepEqual(discovered.map(row => row.id), [exoticRoute]);
        const bindings = await endpoints.listRuntimeBindingsByRouteTargetIds([exoticRoute, exoticRoute]);
        assert.deepEqual(bindings.map(row => row.id), [exoticEndpoint]);
        const selected = await policies.getByRouteTargetIds([exoticRoute, exoticRoute]);
        assert.deepEqual(selected.map(row => row.route_target_id), [exoticRoute]);
        for (const run of [ids => endpoints.listRouteLinks(ids), ids => endpoints.listDiscoveryRouteBindings(ids),
          ids => endpoints.listRuntimeBindingsByRouteTargetIds(ids), ids => policies.getByRouteTargetIds(ids)]) {
          assert.equal((await run([])).length, 0); assert.equal((await run(['absent'])).length, 0);
        }
        for (const run of [ids => endpoints.listRouteLinks(ids), ids => endpoints.listDiscoveryRouteBindings(ids), ids => endpoints.listRuntimeBindingsByRouteTargetIds(ids)])
          await assert.rejects(run(Array(MAX_MODEL_ENDPOINT_LIST_LIMIT + 1).fill('duplicate')), RangeError);
        assert.equal((await pg.unsafe('SELECT count(*)::int AS n FROM model_routes'))[0].n, 2);
        report.modes.push({ mode, readers: 4, explicitTextOid: parameter.type, quotedBackslashInjectionIdRoundTrip: true,
          emptyAndAbsent: true, deduped: true, endpointBatchLimitsPreserved: true });
        await raw.end({ timeout: 1 });
      }
      report.status = 'PASS';
    } catch (error) { failure = error; }
    try { await cluster.cleanup(); report.cleanup = 'PASS'; }
    catch (cleanupError) {
      report.cleanup = 'FAIL'; report.status = 'FAIL';
      throw failure === undefined ? cleanupError
        : new AggregateError([failure, cleanupError], 'Batch reader and native cleanup failed');
    }
    if (failure !== undefined) { report.status = 'FAIL'; report.error = { name: failure.name, code: failure.code, message: failure.message }; }
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log('Native JSONB batch boundary successor report: ' + reportPath);
    if (failure !== undefined) throw failure;
  });
