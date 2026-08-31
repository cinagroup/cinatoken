import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	ManagementApiKeyRow,
	ManagementGatewayKeyRow,
	ResolvedGatewayKeyRow,
	StorageContext,
} from "@octafuse/core";
import { createProxyApp } from "../../app";

const gatewaySecret = "sk-current-gateway-secret";
const managementSecret = `sk-cina-mgmt-${"a".repeat(64)}`;

const gatewayAuthRow: ResolvedGatewayKeyRow = {
	id: "gateway-1",
	key: "sk-current…cret",
	user_id: "user-1",
	workspace_id: "personal:user-1",
	name: "Production",
	status: "active",
	metadata: null,
	expires_at: "2099-01-01T00:00:00.000Z",
	limit_micros: 10_000_000,
	limit_reset: "daily",
	include_byok_in_limit: false,
	limit_epoch: 1,
	last_used_at: null,
	created_at: "2026-08-31T00:00:00.000Z",
	updated_at: "2026-08-31T00:00:00.000Z",
	user_email: "user@example.com",
	user_metadata: null,
	user_charged_cost_factors: null,
	budget_max: null,
	budget_base: 0,
	budget_spent: 0,
	budget_period: "monthly",
	budget_reset_at: "2099-01-01T00:00:00.000Z",
	budget_epoch: 0,
	budget_reserved_micros: 0,
};

const gatewayMetadataRow: ManagementGatewayKeyRow = {
	id: "gateway-1",
	key_hash: `sha256:${"b".repeat(64)}`,
	key_preview: "sk-current…cret",
	user_id: "user-1",
	workspace_id: "personal:user-1",
	name: "Production",
	status: "active",
	expires_at: "2099-01-01T00:00:00.000Z",
	limit_micros: 10_000_000,
	limit_reset: "daily",
	include_byok_in_limit: false,
	limit_epoch: 1,
	created_at: "2026-08-31T00:00:00.000Z",
	updated_at: "2026-08-31T00:00:00.000Z",
	usage: 12.5,
	usage_daily: 2.5,
	usage_weekly: 4.5,
	usage_monthly: 8.5,
};

const managementRow: ManagementApiKeyRow = {
	id: "management-1",
	key_hash: `sha256:${"a".repeat(64)}`,
	key_preview: "sk-cina-mgmt-aaaa…aaaa",
	account_type: "personal",
	personal_owner_user_id: "user-1",
	organization_id: null,
	name: "Automation",
	status: "active",
	expires_at: "2099-01-01T00:00:00.000Z",
	last_used_at: null,
	created_by_user_id: "user-1",
	created_at: "2026-08-31T00:00:00.000Z",
	updated_at: "2026-08-31T00:00:00.000Z",
};

function fixture() {
	let gatewayLookupCount = 0;
	const repositories = {
		apiKeys: {
			getApiKeyWithUserByKey: async (secret: string) => {
				gatewayLookupCount += 1;
				return secret === gatewaySecret ? gatewayAuthRow : null;
			},
			getCurrentById: async (id: string) =>
				id === gatewayMetadataRow.id ? gatewayMetadataRow : null,
		},
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === managementSecret ? managementRow : null,
			getByIdInAccount: async (id: string) =>
				id === managementRow.id ? managementRow : null,
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories }) as StorageContext);
	return {
		gatewayLookups: () => gatewayLookupCount,
		request: (path: string, init?: RequestInit) =>
			app.request(path, init, { REQUEST_BODY_LOGGING: "off" }),
	};
}

function bearer(secret: string): RequestInit {
	return { headers: { Authorization: `Bearer ${secret}` } };
}

test("current-key returns real Gateway usage without revealing the secret", async () => {
	const { request } = fixture();
	const response = await request("/api/v1/key", bearer(gatewaySecret));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as { data: Record<string, unknown> };
	assert.equal(body.data.is_management_key, false);
	assert.equal(body.data.is_provisioning_key, false);
	assert.equal(body.data.label, gatewayMetadataRow.key_preview);
	assert.equal(body.data.usage, 12.5);
	assert.equal(body.data.usage_daily, 2.5);
	assert.equal(body.data.expires_at, gatewayMetadataRow.expires_at);
	assert.equal(body.data.limit, 10);
	assert.equal(body.data.limit_remaining, 7.5);
	assert.equal(body.data.limit_reset, "daily");
	assert.deepEqual(body.data.rate_limit, {
		requests: -1,
		interval: "",
		note: "This field is deprecated and safe to ignore.",
	});
	assert.equal(JSON.stringify(body).includes(gatewaySecret), false);
});

test("current-key identifies a Management principal without inference usage", async () => {
	const { request, gatewayLookups } = fixture();
	const response = await request("/api/v1/key", bearer(managementSecret));
	assert.equal(response.status, 200);
	const body = (await response.json()) as { data: Record<string, unknown> };
	assert.equal(body.data.is_management_key, true);
	assert.equal(body.data.is_provisioning_key, true);
	assert.equal(body.data.creator_user_id, "user-1");
	assert.equal(body.data.expires_at, managementRow.expires_at);
	assert.equal(body.data.usage, 0);
	assert.equal(body.data.byok_usage, 0);
	assert.equal(gatewayLookups(), 0);
	assert.equal(JSON.stringify(body).includes(managementSecret), false);
});

test("current-key requires a strict, valid Bearer credential", async () => {
	const { request } = fixture();
	assert.equal((await request("/api/v1/key")).status, 401);
	assert.equal(
		(await request("/api/v1/key", {
			headers: { Authorization: `Basic ${gatewaySecret}` },
		})).status,
		401
	);
	assert.equal(
		(await request("/api/v1/key", bearer("sk-invalid"))).status,
		401
	);
});

test("Management namespace cannot authenticate an inference request", async () => {
	const { request, gatewayLookups } = fixture();
	const response = await request("/api/v1/chat/completions", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${managementSecret}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: "vendor/model", messages: [] }),
	});
	assert.equal(response.status, 401);
	assert.equal(gatewayLookups(), 0);
});
