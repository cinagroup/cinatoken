import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	computeRouteDataPolicySubjectFingerprintFromRows,
	type GatewayRepositories,
	type RouteDataPolicyAdminRow,
	type RouteDataPolicyRow,
	type UpsertRouteDataPolicyParams,
} from '@octafuse/core';
import { Hono } from 'hono';
import type { AdminEnv } from '@/lib/admin-env';
import { adminDataPoliciesRoutes } from '@/lib/routes/admin/data-policies';
import { updateModelRouteService } from './model-routes-service';
import { updateProviderService } from './providers-service';

const route = {
	id: 'route-1', model_id: 'model-1', provider_id: 'provider-1', provider_model_name: 'upstream-model',
	priority: 0, status: 'active', route_group: 'default', weight: 1, price_override: null,
	custom_params: '{"safety":"strict"}', routing_metadata: null, upstream_protocol: 'openai',
	route_pool_id: 'pool-1', upstream_operation: 'chat', adapter: 'passthrough',
};

const provider = {
	id: 'provider-1', name: 'Provider', endpoints: '{"openai":{"base":"https://api.example/v1"}}',
	api_key: 'provider-secret', status: 'active', description: null, shared_channel_type: null,
	created_at: '2026-08-30T00:00:00.000Z',
};

describe('admin route data-policy subject binding', () => {
	it('captures the current subject and reports out-of-band drift as unknown', async () => {
		let saved: RouteDataPolicyRow | null = null;
		const captures: UpsertRouteDataPolicyParams[] = [];
		let currentProvider = provider;
		const repositories = {
			routes: { getModelRouteRowById: async (id: string) => id === route.id ? route : null },
			providers: { getProviderById: async () => currentProvider },
			routeDataPolicies: {
				upsertWithAudit: async (params: UpsertRouteDataPolicyParams) => {
					captures.push(params);
					saved = {
						route_target_id: params.routeTargetId, subject_fingerprint: params.subjectFingerprint,
						retention_days: params.retentionDays, training_allowed: params.trainingAllowed,
						zdr_supported: params.zdrSupported, evidence_url: params.evidenceUrl,
						verified_by: params.verifiedBy, verified_at: params.verifiedAt,
						expires_at: params.expiresAt, status: params.status,
						invalidated_at: null, invalidation_reason: null, updated_at: params.nowIso,
					};
					return saved;
				},
				listAll: async () => saved ? [{
					...saved,
					model_id: route.model_id, provider_id: provider.id, provider_name: provider.name,
					provider_model_name: route.provider_model_name, upstream_protocol: route.upstream_protocol,
					upstream_operation: route.upstream_operation, route_group: route.route_group,
				}] satisfies RouteDataPolicyAdminRow[] : [],
			},
		} as unknown as GatewayRepositories;
		const app = new Hono<AdminEnv>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			c.set('principal', { type: 'console', id: 'console:admin', username: 'admin' });
			await next();
		});
		app.route('/data-policies', adminDataPoliciesRoutes);

		const put = await app.request('/data-policies/route-1', {
			method: 'PUT',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				status: 'verified', retention_days: 0, training_allowed: false, zdr_supported: true,
				evidence_url: 'https://provider.example/privacy', expires_at: '2099-01-01T00:00:00.000Z',
			}),
		});
		assert.equal(put.status, 200);
		const expected = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
		assert.equal(captures[0]?.subjectFingerprint, expected);
		const putBody = await put.json() as { data: { effective_status: string; subject_matches_current: boolean } };
		assert.equal(putBody.data.effective_status, 'verified');
		assert.equal(putBody.data.subject_matches_current, true);

		currentProvider = { ...provider, endpoints: '{"openai":{"base":"https://other.example/v1"}}' };
		const list = await app.request('/data-policies');
		assert.equal(list.status, 200);
		const listBody = await list.json() as { data: Array<{ effective_status: string; subject_matches_current: boolean }> };
		assert.equal(listBody.data[0]?.effective_status, 'unknown');
		assert.equal(listBody.data[0]?.subject_matches_current, false);
	});

	it('invalidates verified assertions after trust-relevant admin mutations', async () => {
		const invalidations: Array<{ scope: string; reason: string; actorId: string }> = [];
		const repositories = {
			routes: {
				getModelRouteRowById: async () => route,
				updateModelRouteByPatch: async () => 1,
				deleteRoutePoolIfEmpty: async () => false,
			},
			providers: {
				getProviderProtocolBases: async () => ({ id: provider.id, endpoints: provider.endpoints }),
				getProviderRowById: async () => provider,
				updateProviderByPatch: async () => 1,
			},
			models: { getModelDetailWithRouteCounts: async () => null },
			routeDataPolicies: {
				invalidateForRouteTarget: async (_id: string, params: { reason: string; actorId: string }) => {
					invalidations.push({ scope: 'route', reason: params.reason, actorId: params.actorId });
					return 1;
				},
				invalidateForProvider: async (_id: string, params: { reason: string; actorId: string }) => {
					invalidations.push({ scope: 'provider', reason: params.reason, actorId: params.actorId });
					return 1;
				},
			},
		} as unknown as GatewayRepositories;

		await updateModelRouteService(repositories, route.id, { custom_params: { safety: 'relaxed' } }, 'console:admin');
		await updateProviderService(repositories, provider.id, {
			endpoints: { openai: { base: 'https://other.example/v1' } },
		}, 'console:admin');
		assert.deepEqual(invalidations, [
			{ scope: 'route', reason: 'route_subject_changed:custom_params', actorId: 'console:admin' },
			{ scope: 'provider', reason: 'provider_subject_changed:endpoints', actorId: 'console:admin' },
		]);
	});
});
