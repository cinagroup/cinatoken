import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import { createPostgresModelRoutesRepository } from './model-routes.impl';

describe('PostgreSQL model routes repository', () => {
	it('binds each route pool id separately when loading surfaces', async () => {
		const routes = [
			{
				id: 'route-1',
				model_id: 'model-1',
				provider_id: 'provider-1',
				provider_model_name: 'upstream-1',
				priority: 0,
				status: 'active',
				route_group: 'default',
				weight: 1,
				price_override: null,
				custom_params: null,
				routing_metadata: null,
				upstream_protocol: 'openai',
				route_pool_id: 'pool-1',
				upstream_operation: 'chat',
				adapter: 'passthrough',
				pool_name: 'Pool 1',
				pool_strategy: 'priority',
				pool_tier_strategies: null,
				pool_status: 'active',
				pool_sticky_enabled: false,
				pool_sticky_idle_ttl_seconds: null,
				pool_sticky_epoch: null,
				model_name: 'Model 1',
				provider_name: 'Provider 1',
				provider_status: 'active',
			},
			{
				id: 'route-2',
				model_id: 'model-2',
				provider_id: 'provider-1',
				provider_model_name: 'upstream-2',
				priority: 0,
				status: 'active',
				route_group: 'default',
				weight: 1,
				price_override: null,
				custom_params: null,
				routing_metadata: null,
				upstream_protocol: 'openai',
				route_pool_id: 'pool-2',
				upstream_operation: 'chat',
				adapter: 'passthrough',
				pool_name: 'Pool 2',
				pool_strategy: 'priority',
				pool_tier_strategies: null,
				pool_status: 'active',
				pool_sticky_enabled: false,
				pool_sticky_idle_ttl_seconds: null,
				pool_sticky_epoch: null,
				model_name: 'Model 2',
				provider_name: 'Provider 1',
				provider_status: 'active',
			},
		];
		let capturedLimit: number | null = null;
		const builder = {
			from() { return this; },
			leftJoin() { return this; },
			orderBy() { return this; },
			limit(value: number) { capturedLimit = value; return this; },
			then(resolve: (value: typeof routes) => unknown) { return Promise.resolve(resolve(routes)); },
		};
		let capturedSql = '';
		let capturedParams: unknown[] = [];
		const client = {
			driver: 'postgres',
			drizzle: { select: () => builder },
			raw: {
				async unsafe(sql: string, params: unknown[]) {
					capturedSql = sql;
					capturedParams = params;
					return [
						{ route_pool_id: 'pool-1', surfaces: '[{"id":"surface-1"}]' },
						{ route_pool_id: 'pool-2', surfaces: '[{"id":"surface-2"}]' },
					];
				},
			},
		} as unknown as PostgresDatabaseClient;

		const result = await createPostgresModelRoutesRepository(client).listModelRoutesWithJoins({ limit: 1_001 });

		assert.equal(capturedLimit, 1_001);
		assert.match(capturedSql, /route_pool_id IN \(\$1, \$2\)/u);
		assert.deepEqual(capturedParams, ['pool-1', 'pool-2']);
		assert.equal(result[0]?.surfaces, '[{"id":"surface-1"}]');
		assert.equal(result[1]?.surfaces, '[{"id":"surface-2"}]');
	});
});
