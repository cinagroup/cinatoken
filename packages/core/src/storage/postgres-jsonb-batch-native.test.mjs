import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresModelEndpointsRepository } from '../db/postgres/model-endpoints.impl.ts';
import { createPostgresRouteDataPoliciesRepository } from '../db/postgres/route-data-policies.impl.ts';
import { startNativePostgres } from '../test-support/postgres-native-cluster.mjs';

test('PostgreSQL route and endpoint batch readers pass arrays as JSONB values',
  { timeout: 120_000, skip: !process.env.GATEWAY_NATIVE_PG_BIN }, async () => {
    const cluster = await startNativePostgres();
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

      // This is the old call shape: postgres.js encodes a string parameter as
      // a JSONB scalar, so array expansion fails in native PostgreSQL.
      await assert.rejects(pg.unsafe(
        'SELECT pg_catalog.jsonb_array_elements_text($1::jsonb) AS id',
        [JSON.stringify(['route-a'])],
      ), /cannot extract elements from a scalar/u);

      const db = { driver: 'postgres', raw: pg };
      const endpoints = createPostgresModelEndpointsRepository(db);
      const policies = createPostgresRouteDataPoliciesRepository(db);
      assert.deepEqual((await endpoints.listRouteLinks(['endpoint-a', 'absent']))
        .map(row => row.route_target_id), ['route-a']);
      assert.deepEqual((await endpoints.listDiscoveryRouteBindings(['endpoint-a']))
        .map(row => row.id), ['route-a']);
      assert.deepEqual((await endpoints.listRuntimeBindingsByRouteTargetIds(['route-a']))
        .map(row => row.id), ['endpoint-a']);
      assert.deepEqual((await policies.getByRouteTargetIds(['route-a']))
        .map(row => row.route_target_id), ['route-a']);
      assert.equal((await endpoints.listRouteLinks(['absent'])).length, 0);
      assert.equal((await policies.getByRouteTargetIds(['absent'])).length, 0);
    } catch (error) { failure = error; }
    try { await cluster.cleanup(); }
    catch (cleanupError) {
      throw failure === undefined ? cleanupError
        : new AggregateError([failure, cleanupError], 'Batch reader and native cleanup failed');
    }
    if (failure !== undefined) throw failure;
  });
