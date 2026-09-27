import assert from 'node:assert/strict';
import type { D1Database, D1PreparedStatement, D1Result } from '@cloudflare/workers-types';
import {
	computeRouteDataPolicySubjectFingerprintFromRows, createD1StorageContext,
	type ModelRow, type ModelRouteRow, type ProviderRow, type ResolvedGatewayKeyRow,
} from '@octafuse/core';
import { createProxyApp } from '../app';
import { createRequestCapacityPool } from '../services/request-capacity';

/** Synthetic records, real gateway/planner/driver/accounting code. NOT a financial database.
 * No MockTracker or retained request/response history: also used by isolated memory probes.
 * Logical reservation units deliberately do not claim to be production memory weights.
 */
export async function createImageCapacityFixture(options: {
	upstreamOrigin: string; concurrency: number; operation: 'generations' | 'edits'; imageFetch?: typeof fetch;
}) {
	const origin = new URL(options.upstreamOrigin);
	assert.equal(origin.protocol, 'http:'); assert.equal(origin.hostname, '127.0.0.1');
	assert.equal(origin.origin, options.upstreamOrigin);
	const pool = createRequestCapacityPool({ maxRequests: options.concurrency, maxReservedBytes: options.concurrency });
	const stats = { auth: 0, guardrail: 0, models: 0, storage: 0, batchesStarted: 0, batchesCompleted: 0, statements: 0 };
	let releaseAccounting!: () => void;
	const accountingGate = new Promise<void>(resolve => { releaseAccounting = resolve; });
	const result = <T>(): D1Result<T> => ({ results: [], success: true, meta: {
		duration: 0, size_after: 0, rows_read: 0, rows_written: 1, last_row_id: 0, changes: 1, changed_db: true,
	} });
	class Statement {
		values: unknown[] = [];
		constructor(readonly sql: string) {}
		bind(...values: unknown[]) { this.values = values; return this; }
		async first<T = Record<string, unknown>>(): Promise<T | null> { throw new Error('Unexpected synthetic SQL first'); }
		async run<T = Record<string, unknown>>(): Promise<D1Result<T>> { throw new Error('Unexpected synthetic SQL run'); }
		async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
			assert.match(this.sql, /FROM workspace_budgets budget/); return result<T>();
		}
		raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
		raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
		async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
			assert.notEqual(options?.columnNames, true); assert.match(this.sql, /select "value" from "system_config"/); return [];
		}
	}
	const db: D1Database = {
		prepare: sql => new Statement(sql),
		batch: async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
			for (const statement of statements) {
				assert.ok(statement instanceof Statement);
				assert.match(statement.sql, /^\s*INSERT\s+INTO\s+(api_key_request_logs|public_model_daily_stats|provider_attempt_availability)/i);
			}
			stats.batchesStarted++; stats.statements += statements.length;
			// Keep real SQL bindings alive until this simulated acknowledgement, then drop them.
			await accountingGate;
			for (const statement of statements) { assert.ok(statement instanceof Statement); statement.values = []; }
			stats.batchesCompleted++; return statements.map(() => result<T>());
		},
		exec: async () => { throw new Error('Unexpected synthetic SQL exec'); },
		withSession: () => { throw new Error('Unexpected synthetic SQL session'); },
		dump: async () => { throw new Error('Unexpected synthetic SQL dump'); },
	};
	const storage = createD1StorageContext(db), repos = storage.repositories;
	const now = '2026-09-06T00:00:00.000Z';
	const key: ResolvedGatewayKeyRow = {
		id: 'image-key', key: 'synthetic-client-key', user_id: 'image-user', workspace_id: 'image-workspace', name: 'Synthetic',
		status: 'active', metadata: null, last_used_at: null, created_at: now, updated_at: now, user_email: null, user_metadata: null,
		user_charged_cost_factors: null, budget_max: null, budget_base: 0, budget_spent: 0, budget_period: 'none', budget_reset_at: null,
		budget_epoch: 0, budget_reserved_micros: 0, include_byok_in_limit: false, limit_micros: null, limit_epoch: 0, limit_reset: null, expires_at: null,
	};
	const model: ModelRow = { id: 'image-model', display_name: 'Synthetic', vendor: 'test', context_window: 8192, max_tokens: 1024,
		pricing_profile: null, tags: '[]', description: null, metadata: null, input_modalities: '["text","image"]', output_modalities: '["image"]',
		released_at: null, route_policy: '{"strategy":"weight_priority"}', created_at: now };
	const routes: ModelRouteRow[] = [{ id: 'target-0', model_id: model.id, provider_id: 'provider-0',
		provider_model_name: 'private-model', priority: 0, status: 'active', route_group: 'default', weight: 1, price_override: null, custom_params: null,
		upstream_protocol: 'openai', upstream_operation: `images.${options.operation}`, adapter: 'passthrough', routing_metadata: null }];
	const providers: ProviderRow[] = [{ id: 'provider-0', name: 'Synthetic', api_key: 'synthetic-provider-key', shared_channel_type: null,
		endpoints: JSON.stringify({ openai: { base: options.upstreamOrigin + '/v1' } }), status: 'active', description: null, created_at: now }];
	const endpoints = await Promise.all(routes.map(async (route, index) => ({ id: 'endpoint-' + index, model_id: model.id, provider_id: route.provider_id,
		provider_slug: 'test', tag: 'test', endpoint_class: null, region: null, context_length: 8192, max_prompt_tokens: null, max_completion_tokens: 1024,
		quantization: null, supported_parameters: '[]', pricing: '{"currency":"USD","prompt":"0","completion":"0"}',
		supports_implicit_caching: false, supports_voice_cloning: false, audio_capabilities: '{}', image_capabilities: JSON.stringify({
			provider_slug: 'test', provider_tag: null, supports_streaming: true,
			supported_parameters: { n: { type: 'range', min: 1, max: 10 } }, allowed_passthrough_parameters: [],
			pricing: [{ billable: 'output_image', unit: 'image', cost_usd: '0' }],
		}),
		supports_tool_choice: '{"auto":false,"function":false,"none":false,"required":false}', evidence_url: 'https://example.invalid/synthetic',
		verified_by: 'test', verified_at: now, expires_at: '2099-01-01T00:00:00.000Z', status: 'verified' as const, created_at: now, updated_at: now,
		route_target_id: route.id, subject_fingerprint: await computeRouteDataPolicySubjectFingerprintFromRows(route, providers[index]!) })));
	repos.apiKeys.getApiKeyWithUserByKey = async () => { stats.auth++; return key; };
	repos.apiKeys.getApiKeyByIdInWorkspace = async () => key;
	repos.guardrails.getEffectiveForRequest = async () => { stats.guardrail++; return []; };
	repos.userAuditLogs.insertUserAuditLog = async () => {};
	repos.modelRouting.getModelById = async () => { stats.models++; return model; };
	repos.modelRouting.resolveModelSurface = async () => null;
	repos.modelRouting.getModelRoutesByModelId = async () => routes;
	repos.modelRouting.getModelRoutesByPoolId = async () => routes;
	repos.providers.getProvidersByIds = async () => providers;
	repos.modelEndpoints.listRuntimeBindingsByRouteTargetIds = async () => endpoints;
	repos.routeDataPolicies.getByRouteTargetIds = async () => [];
	repos.systemConfig.getConfig = async () => null;
	repos.byokKeys.listActiveForRequest = async () => [];
	repos.byokKeys.shouldSuppressSharedCapacityForRequest = async () => false;
	repos.sharedKeys.listActiveSharedKeysByChannel = async () => [];
	repos.routePoolSticky.getBinding = async () => null;
	repos.routePoolSticky.deleteStaleBefore = async () => 0;
	repos.routePoolSticky.tryBind = async () => true;
	repos.requestLogs.getRecentRoutePerformanceSamples = async () => [];
	repos.requestLogs.getRouteAvailabilityAggregates = async () => [];
	return { pool, stats, releaseAccounting, app: createProxyApp(async () => { stats.storage++; return storage; }, {
		imageFetch: options.imageFetch,
		httpCapacity: { pool, reservedBytesPerRequest: 1 },
	}) };
}
