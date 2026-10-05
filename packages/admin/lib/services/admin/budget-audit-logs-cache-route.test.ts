import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	UserAuditLogExportRow,
} from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPermission, AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";

function fixture(
	permissions: AdminPermission[] | null,
	exportRows: UserAuditLogExportRow[] = [],
	exportFailure?: unknown
) {
	let listReads = 0;
	let filterReads = 0;
	let exportReads = 0;
	const repositories = {
		userAuditLogs: {
			getGlobalUserAuditLogs: async () => {
				listReads++;
				return { logs: [], total: 0 };
			},
			getGlobalUserAuditLogFilterOptions: async () => {
				filterReads++;
				return { reasonCodes: [] };
			},
			scanGlobalUserAuditLogsForExport: async () => {
				exportReads++;
				if (exportFailure !== undefined) throw exportFailure;
				return exportRows;
			},
		},
	} as unknown as GatewayRepositories;
	const principal: AdminPrincipal | undefined =
		permissions === null
			? undefined
			: {
					type: "api_key",
					id: "admin_key:budget-audit-cache-test",
					keyId: "budget-audit-cache-test",
					permissions,
			  };
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: principal,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		request: (path: string) => app.request(path, { method: "GET" }, bindings),
		reads: () => ({ listReads, filterReads, exportReads }),
	};
}

test("budget audit list and filters keep data and auth failures private", async () => {
	for (const [path, expectedReads] of [
		[
			"/admin/budget-audit-logs?page=1",
			{ listReads: 1, filterReads: 0, exportReads: 0 },
		],
		[
			"/admin/budget-audit-logs/filters",
			{ listReads: 0, filterReads: 1, exportReads: 0 },
		],
		[
			"/admin/budget-audit-logs/export.csv",
			{ listReads: 0, filterReads: 0, exportReads: 1 },
		],
	] as const) {
		const allowed = fixture(["logs.read"]);
		const success = await allowed.request(path);
		assert.equal(success.status, 200, path);
		assert.equal(
			success.headers.get("cache-control"),
			"private, no-store",
			path
		);
		if (path.endsWith(".csv")) {
			assert.match(success.headers.get("content-type") ?? "", /^text\/csv/u);
			assert.match(
				success.headers.get("content-disposition") ?? "",
				/^attachment;/u
			);
		}
		assert.deepEqual(allowed.reads(), expectedReads, path);

		const denied = fixture(["analytics.read"]);
		const forbidden = await denied.request(path);
		assert.equal(forbidden.status, 403, path);
		assert.equal(
			forbidden.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.deepEqual(await forbidden.json(), {
			success: false,
			message: "Forbidden",
			required_permission: "logs.read",
		});
		assert.deepEqual(
			denied.reads(),
			{ listReads: 0, filterReads: 0, exportReads: 0 },
			path
		);

		const anonymous = fixture(null);
		const unauthorized = await anonymous.request(path);
		assert.equal(unauthorized.status, 401, path);
		assert.equal(
			unauthorized.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.deepEqual(
			anonymous.reads(),
			{ listReads: 0, filterReads: 0, exportReads: 0 },
			path
		);
	}
});

test("oversized CSV source returns a private 413 with no partial download", async () => {
	const subject = fixture(
		["logs.read"],
		[
			{
				log: {
					id: "audit-1",
					created_at: "2026-09-29 00:00:00",
					request_log_id: null,
					correlation_id: null,
					event_type: "admin_adjust",
					source: "admin_users",
					reason_code: null,
					reason_text: null,
					actor_type: "admin",
					actor_id: null,
					user_id: "user-1",
					user_email: null,
					api_key_id: null,
					before_user_snapshot: null,
					after_user_snapshot: null,
				},
				cursor: { createdAt: "2026-09-29T00:00:00.000Z", id: "audit-1" },
				oversized: true,
			},
		]
	);
	const response = await subject.request("/admin/budget-audit-logs/export.csv");
	assert.equal(response.status, 413);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.doesNotMatch(
		response.headers.get("content-type") ?? "",
		/^text\/csv/u
	);
	assert.equal(response.headers.get("content-disposition"), null);
	assert.deepEqual(subject.reads(), {
		listReads: 0,
		filterReads: 0,
		exportReads: 1,
	});
});

test("database statement timeout returns a private 504 with no partial CSV download", async () => {
	const subject = fixture(["logs.read"], [], {
		code: "ER_QUERY_TIMEOUT",
		errno: 3024,
	});
	const response = await subject.request("/admin/budget-audit-logs/export.csv");
	assert.equal(response.status, 504);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.doesNotMatch(
		response.headers.get("content-type") ?? "",
		/^text\/csv/u
	);
	assert.equal(response.headers.get("content-disposition"), null);
	assert.deepEqual(subject.reads(), {
		listReads: 0,
		filterReads: 0,
		exportReads: 1,
	});
});

test("outer budget audit policy covers list and filters including pre-Hono failures, not adjacent paths", () => {
	for (const path of [
		"/api/admin/budget-audit-logs",
		"/api/admin/budget-audit-logs/",
		"/api/admin/budget-audit-logs/filters",
		"/api/admin/budget-audit-logs/filters/",
		"/api/admin/budget-audit-logs/export.csv",
		"/api/admin/budget-audit-logs/export.csv/",
	]) {
		for (const status of [200, 401, 403, 503]) {
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
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
	for (const path of [
		"/api/admin/budget-audit-logs-extra",
		"/api/admin/budget-audit-logs/filter",
		"/api/admin/budget-audit-logs/filters/detail",
		"/api/admin/budget-audit-logs/export.csv/extra",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			Response.json(
				{ success: false },
				{
					status: 503,
					headers: { "Cache-Control": "public, max-age=600" },
				}
			)
		);
		assert.equal(
			response.headers.get("cache-control"),
			"public, max-age=600",
			path
		);
	}
});

test("invalid audit filters fail before storage reads, including export path", async () => {
	for (const path of [
		"/admin/budget-audit-logs?actor_kind=unknown",
		"/admin/budget-audit-logs/export.csv?start_date=2026-02-30",
		"/admin/budget-audit-logs/export.csv?page=2",
	]) {
		const subject = fixture(["logs.read"]);
		const response = await subject.request(path);
		assert.equal(response.status, 400, path);
		assert.equal(
			response.headers.get("cache-control"),
			"private, no-store",
			path
		);
		assert.deepEqual(
			subject.reads(),
			{ listReads: 0, filterReads: 0, exportReads: 0 },
			path
		);
	}
});

test("CSV route allows only read methods with logs.read", () => {
	assert.deepEqual(
		getAdminAuthorizationDecision("GET", "/admin/budget-audit-logs/export.csv"),
		{ kind: "permission", permission: "logs.read" }
	);
	assert.deepEqual(
		getAdminAuthorizationDecision(
			"HEAD",
			"/admin/budget-audit-logs/export.csv"
		),
		{ kind: "permission", permission: "logs.read" }
	);
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		assert.deepEqual(
			getAdminAuthorizationDecision(
				method,
				"/admin/budget-audit-logs/export.csv"
			),
			{ kind: "deny" }
		);
	}
});
