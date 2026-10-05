import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRepositories, RequestLogRow } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";

const privateMarker = "PRIVATE_REQUEST_LOG_DETAIL_SENTINEL";
const sourceLog = {
	id: "log-1",
	model_id: "vendor/model",
	provider_id: "provider-1",
	provider_name: "Provider One",
	status: "error",
	created_at: "2026-09-28 01:02:03",
	error_message: `upstream failed: ${privateMarker}`,
	request_body: privateMarker,
	upstream_request_body: privateMarker,
	route_trace: privateMarker,
	pricing_audit: privateMarker,
	raw_usage: privateMarker,
	user_email: privateMarker,
	api_key_id: privateMarker,
	provider_key_fingerprint: privateMarker,
} as unknown as RequestLogRow;

const safeLog = {
	id: "log-1",
	model_id: "vendor/model",
	provider_id: "provider-1",
	provider_name: "Provider One",
	status: "error",
	created_at: "2026-09-28T01:02:03.000Z",
};

function fixture(permissions: AdminPermission[] | null) {
	let storageReads = 0;
	let timezoneReads = 0;
	const repositories = {
		systemConfig: {
			getConfig: async () => {
				storageReads++;
				timezoneReads++;
				return "Asia/Singapore";
			},
		},
		apiKeys: {
			getApiKeysCount: async () => {
				storageReads++;
				return { total: 1, active: 1 };
			},
		},
		users: {
			getUsersCount: async () => {
				storageReads++;
				return { total: 1, active: 1 };
			},
		},
		requestLogs: {
			getRequestStatsByRange: async () => {
				storageReads++;
				return {
					totalRequests: 1,
					successCount: 0,
					errorCount: 1,
					chargedCost: 0.5,
					meteredCost: 0.4,
					standardCost: 0.6,
					inputTokens: 2,
					outputTokens: 3,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 5,
					avgLatencyMs: 12,
				};
			},
			getRecentLogs: async () => {
				storageReads++;
				return [sourceLog];
			},
			getRecentErrors: async () => {
				storageReads++;
				return [sourceLog];
			},
			getDistinctActiveUsersCount: async () => {
				storageReads++;
				return 1;
			},
			getThroughputLastMinute: async () => {
				storageReads++;
				return { rpm: 1, tpm: 5 };
			},
			queryRequestTimeseries: async () => {
				storageReads++;
				return [];
			},
		},
		analytics: {
			queryModelAnalytics: async () => {
				storageReads++;
				return [];
			},
			queryUserAnalytics: async () => {
				storageReads++;
				return [];
			},
			queryProviderReliability: async () => {
				storageReads++;
				return [];
			},
			queryModelProviderReliability: async () => {
				storageReads++;
				return [];
			},
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal | undefined =
		permissions === null
			? undefined
			: {
					type: "api_key",
					id: "admin_key:summary-test",
					keyId: "summary-test",
					permissions,
			  };
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string) => app.request(path, { method: "GET" }, bindings),
		storageReads: () => storageReads,
		timezoneReads: () => timezoneReads,
	};
}

test("analytics-only stats return fixed occurrence summaries without log details", async () => {
	const f = fixture(["analytics.read"]);
	const response = await f.request("/admin/stats?range=1d");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = (await response.json()) as {
		success: boolean;
		data: { recentLogs: unknown[]; recentErrors: unknown[] };
	};
	assert.equal(body.success, true);
	assert.deepEqual(body.data.recentLogs, [safeLog]);
	assert.deepEqual(body.data.recentErrors, [safeLog]);
	assert.doesNotMatch(JSON.stringify(body), new RegExp(privateMarker));
	assert.equal(f.timezoneReads(), 1);
});

test("reliability analytics use the same fixed recent-error summary", async () => {
	const f = fixture(["analytics.read"]);
	const response = await f.request(
		"/admin/analytics/reliability?start_date=2026-09-27&end_date=2026-09-28"
	);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const body = (await response.json()) as {
		success: boolean;
		data: { recentErrors: unknown[] };
	};
	assert.equal(body.success, true);
	assert.deepEqual(body.data.recentErrors, [safeLog]);
	assert.doesNotMatch(JSON.stringify(body), new RegExp(privateMarker));
});

test("stats and reliability require analytics.read before accessing repositories", async () => {
	for (const path of ["/admin/stats", "/admin/analytics/reliability"]) {
		const logsOnly = fixture(["logs.read"]);
		const denied = await logsOnly.request(path);
		assert.equal(denied.status, 403);
		assert.equal(denied.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await denied.json(), {
			success: false,
			message: "Forbidden",
			required_permission: "analytics.read",
		});
		assert.equal(logsOnly.storageReads(), 0);
		const missing = fixture(null);
		const unauthorized = await missing.request(path);
		assert.equal(unauthorized.status, 401);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store"
		);
		assert.equal(missing.storageReads(), 0);
	}
});

test("public Reliability cache policy covers success and early auth failures without capturing sibling analytics APIs", () => {
	for (const path of [
		"/api/admin/analytics/reliability",
		"/api/admin/analytics/reliability/",
		"/api/admin/analytics/reliability?start_date=2026-09-27",
	]) {
		for (const status of [200, 401, 403]) {
			const response = protectAdminConfigResponse(
				new Request(`https://admin.example.test${path}`),
				Response.json(
					{ success: status === 200 },
					{
						status,
						headers: { "Cache-Control": "public, max-age=600" },
					}
				)
			);
			assert.equal(response.status, status);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
	for (const path of [
		"/api/admin/analytics/models/detail",
		"/api/admin/analytics/providers-extra",
		"/api/admin/analytics/users//",
		"/api/admin/analytics/reliability/detail",
		"/api/admin/analytics/reliability//",
		"/api/admin/analytics/reliability-extra",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			Response.json({ success: false }, { status: 403 })
		);
		assert.equal(response.headers.get("cache-control"), null, path);
	}
});
