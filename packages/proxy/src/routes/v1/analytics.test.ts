import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	GatewayRepositories,
	ManagementAnalyticsQuery,
	ManagementApiKeyRow,
	ResolvedGatewayKeyRow,
	StorageContext,
} from '@octafuse/core';
import { createProxyApp, type GatewayBindings } from '../../app';

const managementSecret = `sk-cina-mgmt-${'a'.repeat(64)}`;
const gatewaySecret = 'sk-analytics-ordinary';

const managementRow: ManagementApiKeyRow = {
	id: 'management-analytics',
	key_hash: `sha256:${'a'.repeat(64)}`,
	key_preview: 'sk-cina-mgmt-aaaa…aaaa',
	account_type: 'organization',
	personal_owner_user_id: null,
	organization_id: 'org-analytics',
	name: 'Analytics automation',
	status: 'active',
	expires_at: '2099-01-01T00:00:00.000Z',
	last_used_at: null,
	created_by_user_id: 'user-admin',
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
};

const gatewayRow: ResolvedGatewayKeyRow = {
	id: 'gateway-analytics',
	key: 'sk-analytics…nary',
	user_id: 'user-admin',
	workspace_id: 'organization:org-analytics',
	name: 'Ordinary',
	status: 'active',
	metadata: null,
	expires_at: '2099-01-01T00:00:00.000Z',
	limit_micros: null,
	limit_reset: null,
	include_byok_in_limit: false,
	limit_epoch: 0,
	last_used_at: null,
	created_at: '2026-09-01T00:00:00.000Z',
	updated_at: '2026-09-01T00:00:00.000Z',
	user_email: 'admin@example.com',
	user_metadata: null,
	user_charged_cost_factors: null,
	budget_max: null,
	budget_base: 0,
	budget_spent: 0,
	budget_period: 'none',
	budget_reset_at: null,
	budget_epoch: 0,
	budget_reserved_micros: 0,
};

function fixture(bindings: Partial<GatewayBindings> = {}) {
	let captured: ManagementAnalyticsQuery | null = null;
	const repositories = {
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === managementSecret ? managementRow : null,
		},
		apiKeys: {
			getApiKeyWithUserByKey: async (secret: string) =>
				secret === gatewaySecret ? gatewayRow : null,
		},
		requestLogs: {
			queryManagementAnalytics: async (query: ManagementAnalyticsQuery) => {
				captured = query;
				return {
					rows: [
						{ date__day: '2026-09-01T00:00:00.000Z', model: 'deepseek/deepseek-chat', request_count: '4', total_usage: 0.125 },
						{ date__day: '2026-09-02T00:00:00.000Z', model: 'deepseek/deepseek-chat', request_count: '2', total_usage: 0.05 },
					],
					truncated: true,
				};
			},
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories }) as StorageContext);
	return {
		captured: () => captured,
		request: (path: string, init?: RequestInit) =>
			app.request(path, init, { REQUEST_BODY_LOGGING: 'off', ...bindings }),
	};
}

function authorized(body?: unknown, secret = managementSecret): RequestInit {
	return {
		method: body === undefined ? 'GET' : 'POST',
		headers: {
			Authorization: `Bearer ${secret}`,
			...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	};
}

test('analytics metadata is Management-only and advertises only implemented fields', async () => {
	const { request } = fixture();
	assert.equal((await request('/api/v1/analytics/meta')).status, 401);
	assert.equal((await request('/api/v1/analytics/meta', authorized(undefined, gatewaySecret))).status, 403);

	const response = await request('/api/v1/analytics/meta', authorized());
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
	const body = await response.json() as {
		data: { metrics: Array<{ name: string }>; dimensions: Array<{ name: string }> };
	};
	assert.ok(body.data.metrics.some(({ name }) => name === 'total_usage'));
	assert.ok(body.data.metrics.some(({ name }) => name === 'cache_hit_rate'));
	assert.ok(body.data.dimensions.some(({ name }) => name === 'app'));
	assert.ok(body.data.dimensions.some(({ name }) => name === 'workspace'));
	assert.equal(body.data.dimensions.some(({ name }) => name === 'country'), false);
});

test('analytics query passes a validated account scope and OpenRouter-shaped query', async () => {
	const { request, captured } = fixture();
	const response = await request('/api/v1/analytics/query', authorized({
		metrics: ['request_count', 'total_usage'],
		dimensions: ['model'],
		filters: [{ field: 'api_key_id', operator: 'eq', value: 'b'.repeat(64) }],
		granularity: 'day',
		group_limit: 31,
		limit: 2,
		order_by: { field: 'total_usage', direction: 'desc' },
		time_range: {
			start: '2026-09-01T00:00:00Z',
			end: '2026-09-03T00:00:00Z',
		},
	}));

	assert.equal(response.status, 200);
	assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
	const query = captured();
	assert.ok(query);
	assert.deepEqual(query.account, {
		accountType: 'organization',
		personalOwnerUserId: null,
		organizationId: 'org-analytics',
	});
	assert.deepEqual(query.filters, [{
		field: 'api_key_id',
		operator: 'eq',
		value: 'b'.repeat(64),
	}]);
	assert.equal(query.groupLimit, 31);
	const body = await response.json() as {
		data: { data: unknown[]; metadata: { row_count: number; truncated: boolean } };
	};
	assert.equal(body.data.data.length, 2);
	assert.equal(body.data.metadata.row_count, 2);
	assert.equal(body.data.metadata.truncated, true);
});

test('analytics query uses the dedicated per-Management-key Workers rate limit', async () => {
	const keys: string[] = [];
	const { request, captured } = fixture({
		ANALYTICS_RATE_LIMITER: {
			limit: async ({ key }) => {
				keys.push(key);
				return { success: false };
			},
		} as GatewayBindings['ANALYTICS_RATE_LIMITER'],
	});
	const metadata = await request('/api/v1/analytics/meta', authorized());
	assert.equal(metadata.status, 200);
	assert.deepEqual(keys, []);

	const response = await request('/api/v1/analytics/query', authorized({
		metrics: ['request_count'],
	}));
	assert.equal(response.status, 429);
	assert.equal(response.headers.get('Retry-After'), '60');
	assert.equal(response.headers.get('X-OctaFuse-Error-Code'), 'gateway.analytics_rate_limited');
	assert.deepEqual(keys, ['management-key:management-analytics']);
	assert.equal(captured(), null);

	const unavailable = fixture({
		ANALYTICS_RATE_LIMITER: {
			limit: async () => { throw new Error('binding unavailable'); },
		} as GatewayBindings['ANALYTICS_RATE_LIMITER'],
	});
	const unavailableResponse = await unavailable.request(
		'/api/v1/analytics/query',
		authorized({ metrics: ['request_count'] }),
	);
	assert.equal(unavailableResponse.status, 500);
	assert.equal(unavailable.captured(), null);
});

test('analytics rejects unsupported, malformed, and over-wide queries before storage', async () => {
	const { request, captured } = fixture();
	const cases: unknown[] = [
		{ metrics: ['p90_latency'] },
		{ metrics: ['request_count'], dimensions: ['model', 'provider', 'workspace'] },
		{ metrics: ['request_count'], classifier_dimensions: { classifier_id: 'x' } },
		{ metrics: ['request_count'], filters: [{ field: 'api_key_id', operator: 'eq', value: 'Production' }] },
		{
			metrics: ['request_count'],
			time_range: { start: '2026-02-30T00:00:00Z', end: '2026-03-02T00:00:00Z' },
		},
		{
			metrics: ['request_count'],
			granularity: 'minute',
			time_range: { start: '2026-09-01T00:00:00Z', end: '2026-09-01T04:00:00Z' },
		},
	];
	for (const body of cases) {
		const response = await request('/api/v1/analytics/query', authorized(body));
		assert.equal(response.status, 400);
	}
	assert.equal(captured(), null);

	const wrongMediaType = await request('/api/v1/analytics/query', {
		method: 'POST',
		headers: { Authorization: `Bearer ${managementSecret}`, 'Content-Type': 'text/plain' },
		body: JSON.stringify({ metrics: ['request_count'] }),
	});
	assert.equal(wrongMediaType.status, 400);
});
