import assert from 'node:assert/strict';
import test from 'node:test';
import { Hono } from 'hono';
import type {
	EffectiveGuardrailRow,
	GatewayRepositories,
	ModelEndpointRuntimeBindingRow,
	ModelRouteJoinRow,
	ProviderRow,
	RouteDataPolicyRow,
	WorkspaceContextProjection,
} from '@octafuse/core';
import { computeRouteDataPolicySubjectFingerprintFromRows } from '@octafuse/core';
import type { UserEnv } from '@/lib/user-env';
import type { UserPrincipal } from '@/lib/user-auth';
import { userGuardrailsRoutes } from './guardrails';

const principal: UserPrincipal = {
	userId: 'user-1',
	subject: 'cinaauth-subject-1',
	email: 'user@example.com',
	isAdmin: false,
	capabilities: [],
};

const workspaceContext: WorkspaceContextProjection = {
	workspaces: [],
	currentWorkspace: {
		id: 'workspace-1', name: 'Workspace 1', slug: 'workspace-1', description: null,
		scopeType: 'personal', organizationId: null, organizationName: null, organizationSlug: null,
		personalOwnerUserId: 'user-1', isDefault: true, status: 'active', role: 'owner',
		accessSource: 'personal_owner', createdAt: '2026-09-02T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
	},
	preferredWorkspaceAvailable: true,
};
workspaceContext.workspaces.push(workspaceContext.currentWorkspace);

const effectiveRow: EffectiveGuardrailRow = {
	id: 'guardrail-1', workspace_id: 'workspace-1', owner_user_id: 'user-1', name: 'User policy',
	description: null, status: 'active', designated_version: 1, latest_version: 1,
	created_at: '2026-09-02T00:00:00.000Z', updated_at: '2026-09-02T00:00:00.000Z',
	version_id: 'version-1', version_config_json: JSON.stringify({ allowed_models: ['openai/gpt-4o'], require_zdr: true }),
	version_created_by_user_id: 'user-1', version_created_at: '2026-09-02T00:00:00.000Z',
	assignment_id: 'assignment-1', assignment_scope_type: 'user', assignment_scope_id: 'user-1',
};

const route: ModelRouteJoinRow = {
	id: 'internal-route-id', model_id: 'openai/gpt-4o', provider_id: 'internal-provider-id',
	provider_model_name: 'private-upstream-model', priority: 1, status: 'active', route_group: 'default',
	price_override: null, custom_params: null, routing_metadata: null, upstream_protocol: 'openai',
	route_pool_id: 'pool-1', upstream_operation: 'chat', adapter: 'passthrough', surfaces: null,
	pool_name: 'Default', pool_strategy: null, pool_tier_strategies: null, pool_status: 'active',
	model_name: 'GPT-4o', provider_name: 'Provider A', provider_status: 'active',
};

function appFor(repositories: GatewayRepositories) {
	const app = new Hono<UserEnv>();
	app.use('*', async (c, next) => {
		c.set('repositories', repositories);
		c.set('principal', principal);
		c.set('workspaceContext', workspaceContext);
		await next();
	});
	app.route('/guardrails', userGuardrailsRoutes);
	return app;
}

test('effective Guardrail preview validates key ownership and returns a bounded safe projection', async () => {
	let routeReads = 0;
	let evidenceReads = 0;
	const provider: ProviderRow = {
		id: 'internal-provider-id', name: 'Provider A',
		endpoints: JSON.stringify({ openai: { base: 'https://api.example.com/v1' } }),
		api_key: 'provider-secret', status: 'active', description: null, shared_channel_type: null,
		created_at: '2026-09-02T00:00:00.000Z',
	};
	const subjectFingerprint = await computeRouteDataPolicySubjectFingerprintFromRows(route, provider);
	const policy: RouteDataPolicyRow = {
		route_target_id: route.id, subject_fingerprint: subjectFingerprint, retention_days: 0,
		training_allowed: false, zdr_supported: true, evidence_url: 'https://example.com/privacy',
		verified_by: 'admin-1', verified_at: '2026-09-01T00:00:00.000Z', expires_at: '2027-09-01T00:00:00.000Z',
		status: 'verified', invalidated_at: null, invalidation_reason: null, updated_at: '2026-09-01T00:00:00.000Z',
	};
	const endpointBinding: ModelEndpointRuntimeBindingRow = {
		route_target_id: route.id, subject_fingerprint: subjectFingerprint,
		id: 'internal-endpoint-id', model_id: route.model_id, provider_id: route.provider_id,
		provider_slug: 'provider-a', tag: 'provider-a', endpoint_class: 'standard', region: 'us',
		context_length: 128_000, max_prompt_tokens: 120_000, max_completion_tokens: 4_096,
		quantization: null, supported_parameters: JSON.stringify(['max_tokens']),
		pricing: JSON.stringify({ currency: 'USD', prompt: '0.000001', completion: '0.000002' }),
		supports_implicit_caching: 1, supports_voice_cloning: 0,
		supports_tool_choice: JSON.stringify({ auto: true, function: true, none: true, required: true }),
		image_capabilities: '{}', audio_capabilities: '{}', evidence_url: 'https://example.com/endpoint',
		verified_by: 'admin-1', verified_at: '2026-09-01T00:00:00.000Z',
		expires_at: '2027-09-01T00:00:00.000Z', status: 'verified',
		created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
	};
	const repositories = {
		apiKeys: {
			getApiKeyByIdInWorkspace: async (id: string, workspaceId: string) => id === 'key-owned' && workspaceId === 'workspace-1'
				? { id, workspace_id: workspaceId, user_id: 'user-1', status: 'active' }
				: id === 'key-foreign'
					? { id, workspace_id: workspaceId, user_id: 'user-2', status: 'active' }
					: null,
		},
		guardrails: { getEffectiveForRequest: async () => [effectiveRow] },
		routes: {
			listModelRoutesWithJoins: async (filters: { limit?: number }) => {
				routeReads += 1;
				assert.equal(filters.limit, 251);
				return [route];
			},
		},
		providers: {
			getProvidersByIds: async (ids: string[]) => {
				assert.deepEqual(ids, ['internal-provider-id']);
				return [provider];
			},
		},
		routeDataPolicies: {
			getByRouteTargetIds: async (ids: string[]) => {
				evidenceReads += 1;
				assert.deepEqual(ids, ['internal-route-id']);
				return [policy];
			},
		},
		modelEndpoints: {
			listRuntimeBindingsByRouteTargetIds: async (ids: string[]) => {
				assert.deepEqual(ids, ['internal-route-id']);
				return [endpointBinding];
			},
		},
		requestLogs: {
			getRecentRoutePerformanceSamples: async (options: { routeTargetIds: string[]; sinceIso: string; maxSamplesPerRoute: number }) => {
				assert.deepEqual(options.routeTargetIds, ['internal-route-id']);
				assert.equal(options.maxSamplesPerRoute, 100);
				assert.ok(Number.isFinite(Date.parse(options.sinceIso)));
				return [{
					route_target_id: route.id, output_tokens: 20, latency_ms: 1_000,
					upstream_response_ms: 800, final_upstream_headers_ms: 500,
					first_token_ms: 200, stream_duration_ms: 1_000,
					created_at: '2026-09-02T00:00:00.000Z',
				}];
			},
		},
		systemConfig: {
			getConfig: async (key: string) => {
				assert.equal(key, 'BUSINESS_TIMEZONE');
				return 'UTC';
			},
		},
	} as unknown as GatewayRepositories;
	const app = appFor(repositories);

	const foreign = await app.request('/guardrails/effective?api_key_id=key-foreign');
	assert.equal(foreign.status, 404);
	assert.equal(routeReads, 0, 'foreign keys must be rejected before reading the route catalog');

	const response = await app.request('/guardrails/effective?api_key_id=key-owned');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	const text = await response.text();
	const body = JSON.parse(text) as {
		success: boolean;
		data: {
			workspaceId: string;
			apiKeyId: string;
			routeCandidates: {
				count: number;
				routeEvidence: { required: boolean; eligibleCount: number };
				plannerEvidence: {
					staticallyEligibleCount: number;
					outputCapacity: { maximumTokens: number | null };
					performance: { p50LatencyMs: number | null };
					circuit: { evaluated: boolean; scope: string };
				};
			};
		};
	};
	assert.equal(body.success, true);
	assert.equal(body.data.workspaceId, 'workspace-1');
	assert.equal(body.data.apiKeyId, 'key-owned');
	assert.equal(body.data.routeCandidates.count, 1);
	assert.equal(body.data.routeCandidates.routeEvidence.required, true);
	assert.equal(body.data.routeCandidates.routeEvidence.eligibleCount, 1);
	assert.equal(body.data.routeCandidates.plannerEvidence.staticallyEligibleCount, 1);
	assert.equal(body.data.routeCandidates.plannerEvidence.outputCapacity.maximumTokens, 4_096);
	assert.equal(body.data.routeCandidates.plannerEvidence.performance.p50LatencyMs, 200);
	assert.deepEqual(body.data.routeCandidates.plannerEvidence.circuit, { evaluated: false, scope: 'dispatch_isolate' });
	assert.equal(routeReads, 1);
	assert.equal(evidenceReads, 1);
	assert.doesNotMatch(text, /internal-route-id|internal-provider-id|internal-endpoint-id|private-upstream-model|provider-secret|[0-9a-f]{64}/u);
});
