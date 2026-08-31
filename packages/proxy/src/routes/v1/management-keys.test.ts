import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	ManagementApiKeyRow,
	ManagementGatewayKeyRow,
	StorageContext,
} from "@octafuse/core";
import { createProxyApp } from "../../app";

const managementSecret = `sk-cina-mgmt-${"a".repeat(64)}`;
const gatewayHash = "b".repeat(64);

const managementRow: ManagementApiKeyRow = {
	id: "management-1",
	key_hash: `sha256:${"a".repeat(64)}`,
	key_preview: "sk-cina-mgmt-aaaa…aaaa",
	account_type: "personal",
	personal_owner_user_id: "user-1",
	organization_id: null,
	name: "Automation",
	status: "active",
	expires_at: null,
	last_used_at: null,
	created_by_user_id: "user-1",
	created_at: "2026-08-31T00:00:00.000Z",
	updated_at: "2026-08-31T00:00:00.000Z",
};

function fixture() {
	let gatewayRow: ManagementGatewayKeyRow | null = {
		id: "gateway-1",
		key_hash: `sha256:${gatewayHash}`,
		key_preview: "sk-abcd…wxyz",
		user_id: "user-1",
		workspace_id: "personal:user-1",
		name: "Production",
		status: "active",
		expires_at: "2099-01-01T00:00:00.000Z",
		limit_micros: null,
		limit_reset: null,
		include_byok_in_limit: false,
		limit_epoch: 0,
		created_at: "2026-08-31T01:00:00.000Z",
		updated_at: "2026-08-31T01:00:00.000Z",
		usage: 12.5,
		usage_daily: 2.5,
		usage_weekly: 4.5,
		usage_monthly: 8.5,
	};
	const repositories = {
		managementApiKeys: {
			getActiveBySecret: async (secret: string) =>
				secret === managementSecret ? managementRow : null,
			workspaceBelongsToAccount: async (workspaceId: string) =>
				workspaceId === "personal:user-1",
		},
		apiKeys: {
			getApiKeyWithUserByKey: async () => null,
			listForManagement: async () => (gatewayRow ? [gatewayRow] : []),
			getByHashForManagement: async (params: { keyHash: string }) =>
				params.keyHash === `sha256:${gatewayHash}` ? gatewayRow : null,
			updateByHashForManagement: async (
				_params: unknown,
				patch: {
					name?: string;
					status?: "active" | "disabled";
					limitMicros?: number | null;
					limitReset?: "daily" | "weekly" | "monthly" | null;
					includeByokInLimit?: boolean;
				}
			) => {
				if (!gatewayRow) return false;
				gatewayRow = {
					...gatewayRow,
					...(patch.name === undefined ? {} : { name: patch.name }),
					...(patch.status === undefined ? {} : { status: patch.status }),
					...(patch.limitMicros === undefined ? {} : { limit_micros: patch.limitMicros }),
					...(patch.limitReset === undefined ? {} : { limit_reset: patch.limitReset }),
					...(patch.includeByokInLimit === undefined ? {} : { include_byok_in_limit: patch.includeByokInLimit }),
					limit_epoch: gatewayRow.limit_epoch + (patch.limitMicros !== undefined || patch.limitReset !== undefined || patch.includeByokInLimit !== undefined ? 1 : 0),
					updated_at: "2026-08-31T02:00:00.000Z",
				};
				return true;
			},
			deleteByHashForManagement: async () => {
				gatewayRow = null;
				return true;
			},
		},
	} as unknown as GatewayRepositories;
	const app = createProxyApp(async () => ({ repositories } as StorageContext));
	return {
		request: (path: string, init?: RequestInit) =>
			app.request(path, init, { REQUEST_BODY_LOGGING: "off" }),
	};
}

function bearer(secret: string): RequestInit {
	return { headers: { Authorization: `Bearer ${secret}` } };
}

test("Management key lists real usage without exposing either secret", async () => {
	const { request } = fixture();
	const response = await request("/api/v1/keys", bearer(managementSecret));
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as {
		data: Array<Record<string, unknown>>;
	};
	assert.equal(body.data.length, 1);
	assert.equal(body.data[0]?.hash, gatewayHash);
	assert.equal(body.data[0]?.usage, 12.5);
	assert.equal(body.data[0]?.limit, null);
	assert.equal(body.data[0]?.expires_at, "2099-01-01T00:00:00.000Z");
	assert.equal(body.data[0]?.workspace_id, "personal:user-1");
	assert.equal(JSON.stringify(body).includes(managementSecret), false);
});

test("Gateway and Management credentials cannot cross privilege domains", async () => {
	const { request } = fixture();
	const ordinaryOnManagement = await request(
		"/api/v1/keys",
		bearer("sk-ordinary-gateway-key")
	);
	assert.equal(ordinaryOnManagement.status, 401);

	const managementOnInference = await request("/api/v1/chat/completions", {
		...bearer(managementSecret),
		method: "POST",
		headers: {
			...bearer(managementSecret).headers,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ model: "vendor/model", messages: [] }),
	});
	assert.equal(managementOnInference.status, 401);
});

test("Management key can inspect, disable, rename, and delete an owned key", async () => {
	const { request } = fixture();
	const patch = await request(`/api/v1/keys/${gatewayHash}`, {
		...bearer(managementSecret),
		method: "PATCH",
		headers: {
			...bearer(managementSecret).headers,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ disabled: true, name: "Paused key" }),
	});
	assert.equal(patch.status, 200);
	const patched = (await patch.json()) as { data: Record<string, unknown> };
	assert.equal(patched.data.disabled, true);
	assert.equal(patched.data.name, "Paused key");

	const deleted = await request(`/api/v1/keys/${gatewayHash}`, {
		...bearer(managementSecret),
		method: "DELETE",
	});
	assert.equal(deleted.status, 200);
	assert.deepEqual(await deleted.json(), { deleted: true });
	assert.equal(
		(await request(`/api/v1/keys/${gatewayHash}`, bearer(managementSecret)))
			.status,
		404
	);
});

test("Management API updates key limits while rejecting unavailable BYOK accounting", async () => {
	const { request } = fixture();
	const limit = await request(`/api/v1/keys/${gatewayHash}`, {
		...bearer(managementSecret),
		method: "PATCH",
		headers: {
			...bearer(managementSecret).headers,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ limit: 10, limit_reset: "daily" }),
	});
	assert.equal(limit.status, 200);
	const limitBody = (await limit.json()) as { data: Record<string, unknown> };
	assert.equal(limitBody.data.limit, 10);
	assert.equal(limitBody.data.limit_remaining, 7.5);
	assert.equal(limitBody.data.limit_reset, "daily");

	const byok = await request(`/api/v1/keys/${gatewayHash}`, {
		...bearer(managementSecret),
		method: "PATCH",
		headers: {
			...bearer(managementSecret).headers,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ include_byok_in_limit: true }),
	});
	assert.equal(byok.status, 400);

	const connect = await request("/api/v1/keys", {
		...bearer(managementSecret),
		method: "POST",
		headers: {
			...bearer(managementSecret).headers,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ name: "Partner", external_user: "customer-1" }),
	});
	assert.equal(connect.status, 403);
});
