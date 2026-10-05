import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	GatewayRepositories,
	GuardrailAssignmentRow,
	GuardrailVersionRow,
	GuardrailWithVersionRow,
	UpdateGuardrailMetadataPatch,
} from "@octafuse/core";
import type { AdminEnv } from "@/lib/admin-env";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import {
	hasAdminPermission,
	type AdminPermission,
	type AdminPrincipal,
} from "@/lib/admin-principal";
import {
	adminGuardrailPreviewConflict,
	adminGuardrailPreviewMetadata,
	adminGuardrailPreviewSuccess,
} from "@/lib/guardrail-response";
import { adminGuardrailsRoutes } from "./guardrails";

const secret = "PRIVATE_GUARDRAIL_CONFIG_SENTINEL";
const now = "2026-09-28T00:00:00.000Z";
const initialRow: GuardrailWithVersionRow = {
	id: "guardrail-1",
	workspace_id: "workspace-other",
	owner_user_id: "owner-other",
	name: "Existing rule",
	description: "Managed across workspaces",
	status: "active",
	is_workspace_default: false,
	is_account_default: false,
	account_scope_key: null,
	designated_version: 1,
	latest_version: 2,
	created_at: now,
	updated_at: now,
	version_id: "version-1",
	version_config_json: JSON.stringify({
		allowed_models: ["model-1"],
		hidden: secret,
	}),
	version_created_by_user_id: "owner-other",
	version_created_at: now,
};
const initialVersion: GuardrailVersionRow = {
	id: "version-1",
	guardrail_id: initialRow.id,
	version: 1,
	config_json: JSON.stringify({ require_zdr: true, hidden: secret }),
	created_by_user_id: "owner-other",
	created_at: now,
};
const initialAssignment: GuardrailAssignmentRow = {
	id: "assignment-1",
	workspace_id: initialRow.workspace_id,
	guardrail_id: initialRow.id,
	scope_type: "api_key",
	scope_id: "key-1",
	created_by_user_id: null,
	management_source: "admin",
	assigned_by_user_id: null,
	created_at: now,
	guardrail_name: initialRow.name,
};

test("effective preview success and typed conflict carry verified scope and currency metadata", () => {
	const metadata = adminGuardrailPreviewMetadata(
		{
			id: "workspace-other",
			scopeType: "organization",
			personalOwnerUserId: null,
			organizationId: "org-1",
		},
		"user-1",
		"key-1",
		" cny "
	);
	assert.deepEqual(metadata, {
		workspaceId: "workspace-other",
		userId: "user-1",
		accountScopeKey: "organization:org-1",
		budgetCurrency: "CNY",
		pricingCurrency: "USD",
		apiKeyId: "key-1",
	});
	assert.deepEqual(
		adminGuardrailPreviewSuccess(
			{ workspaceId: "untrusted", routeCandidates: { count: 0 } },
			metadata
		),
		{
			success: true,
			data: {
				...metadata,
				routeCandidates: { count: 0 },
			},
		}
	);
	assert.deepEqual(
		adminGuardrailPreviewConflict(
			"Rules conflict",
			{ reason: "empty" },
			metadata
		),
		{
			success: false,
			code: "guardrail_effective_conflict",
			message: "Rules conflict",
			...metadata,
			trace: { reason: "empty" },
		}
	);
	assert.equal(
		adminGuardrailPreviewMetadata(
			{
				id: "personal:user-1",
				scopeType: "personal",
				personalOwnerUserId: "user-1",
				organizationId: null,
			},
			"user-1",
			null,
			"invalid"
		).accountScopeKey,
		"personal:user-1"
	);
	assert.throws(() =>
		adminGuardrailPreviewMetadata(
			{
				id: "workspace-other",
				scopeType: "organization",
				personalOwnerUserId: null,
				organizationId: null,
			},
			"user-1",
			null,
			null
		)
	);
});

function fixture(
	options: {
		principal?: AdminPrincipal | null;
		rows?: GuardrailWithVersionRow[];
		versions?: GuardrailVersionRow[];
		failList?: boolean;
		keyStatus?: "active" | "revoked";
		assignmentTarget?: string;
		assignmentConflict?: boolean;
		assignmentScopeConflict?: boolean;
		missingAfterWrite?: boolean;
	} = {}
) {
	let rows = options.rows ?? [{ ...initialRow }];
	const versions = options.versions ?? [
		{ ...initialVersion },
		{ ...initialVersion, id: "version-2", version: 2 },
	];
	let binding = {
		...initialAssignment,
		guardrail_id: options.assignmentTarget ?? initialRow.id,
	};
	let writeHappened = false;
	const calls: string[] = [];
	const deleteArgs: unknown[][] = [];
	const repositories = {
		guardrails: {
			listAll: async (archived: boolean) => {
				calls.push(`list:${archived}`);
				if (options.failList) throw new Error("storage failure");
				return rows;
			},
			getById: async (id: string) => {
				calls.push(`get:${id}`);
				if (writeHappened && options.missingAfterWrite) return null;
				return rows.find((row) => row.id === id) ?? null;
			},
			listVersions: async (id: string) => {
				calls.push(`versions:${id}`);
				return versions;
			},
			listAssignments: async (id: string) => {
				calls.push(`assignments:${id}`);
				return binding.guardrail_id === id ? [binding] : [];
			},
			updateMetadata: async (
				id: string,
				patch: UpdateGuardrailMetadataPatch
			) => {
				calls.push(`update:${id}`);
				writeHappened = true;
				rows = rows.map((row) =>
					row.id === id
						? {
								...row,
								name: patch.name ?? row.name,
								description:
									patch.description === undefined
										? row.description
										: patch.description,
								status: patch.status ?? row.status,
						  }
						: row
				);
				return true;
			},
			designateVersion: async (id: string, value: number) => {
				calls.push(`designate:${id}:${value}`);
				if (!versions.some((row) => row.version === value)) return false;
				writeHappened = true;
				rows = rows.map((row) =>
					row.id === id ? { ...row, designated_version: value } : row
				);
				return true;
			},
			upsertAssignment: async (params: {
				guardrailId: string;
				workspaceId: string;
			}) => {
				calls.push(`assign:${params.guardrailId}`);
				if (options.assignmentScopeConflict)
					throw new Error("guardrail_assignment_scope_not_assignable");
				if (options.assignmentConflict)
					throw new Error("guardrail_assignment_target_not_assignable");
				binding = {
					...binding,
					guardrail_id: options.assignmentTarget ?? params.guardrailId,
					workspace_id: params.workspaceId,
				};
				return binding;
			},
			deleteAssignment: async (...args: unknown[]) => {
				deleteArgs.push(args);
				calls.push("delete");
				if (args[4] && args[4] !== binding.guardrail_id) return false;
				return true;
			},
		},
		apiKeys: {
			getApiKeyByIdInWorkspace: async (id: string, workspaceId: string) => {
				calls.push(`key:${id}:${workspaceId}`);
				return id === "key-1" && workspaceId === initialRow.workspace_id
					? { id, status: options.keyStatus ?? "active" }
					: null;
			},
		},
		users: { getById: async () => null },
	} as unknown as GatewayRepositories;
	const principal =
		options.principal === undefined
			? ({
					type: "console",
					id: "console:test",
					username: "test",
			  } as const satisfies AdminPrincipal)
			: options.principal;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		if (!principal)
			return c.json({ success: false, message: "Unauthorized" }, 401);
		const decision = getAdminAuthorizationDecision(c.req.method, c.req.path);
		if (
			decision.kind !== "permission" ||
			!hasAdminPermission(principal, decision.permission)
		)
			return c.json({ success: false, message: "Forbidden" }, 403);
		c.set("principal", principal);
		c.set("repositories", repositories);
		await next();
	});
	app.route("/admin/guardrails", adminGuardrailsRoutes);
	return { app, calls, deleteArgs, currentBinding: () => binding };
}

function apiKey(permissions: AdminPermission[]): AdminPrincipal {
	return { type: "api_key", id: "admin_key:test", keyId: "test", permissions };
}
function privateResponse(response: Response) {
	assert.equal(response.headers.get("cache-control"), "private, no-store");
}

test("global summary list and empty collection omit complete configuration", async () => {
	const { app, calls } = fixture();
	const response = await app.request("/admin/guardrails/summaries");
	assert.equal(response.status, 200);
	privateResponse(response);
	const text = await response.text();
	assert.equal(text.includes(secret), false);
	assert.deepEqual(JSON.parse(text), {
		success: true,
		count: 1,
		canWrite: true,
		data: [
			{
				id: "guardrail-1",
				workspaceId: "workspace-other",
				ownerUserId: "owner-other",
				name: "Existing rule",
				description: "Managed across workspaces",
				status: "active",
				isWorkspaceDefault: false,
				isAccountDefault: false,
				accountScopeKey: null,
				designatedVersion: 1,
				latestVersion: 2,
			},
		],
	});
	assert.deepEqual(calls, ["list:true"]);
	const empty = await fixture({ rows: [] }).app.request(
		"/admin/guardrails/summaries"
	);
	assert.equal(empty.status, 200);
	privateResponse(empty);
	assert.deepEqual(await empty.json(), {
		success: true,
		data: [],
		count: 0,
		canWrite: true,
	});
});

test("read-only Guardrails principal receives summaries without write permission", async () => {
	const { app } = fixture({ principal: apiKey(["guardrails.read"]) });
	const response = await app.request("/admin/guardrails/summaries");
	assert.equal(response.status, 200);
	privateResponse(response);
	const body = (await response.json()) as { canWrite: unknown; count: unknown };
	assert.equal(body.canWrite, false);
	assert.equal(body.count, 1);
	assert.equal(JSON.stringify(body).includes(secret), false);
});

test("version summary is lazy and config-free while legacy reads retain their shapes", async () => {
	const { app } = fixture();
	const response = await app.request(
		"/admin/guardrails/guardrail-1/version-summaries"
	);
	assert.equal(response.status, 200);
	privateResponse(response);
	const text = await response.text();
	assert.equal(text.includes(secret), false);
	assert.deepEqual(JSON.parse(text), {
		success: true,
		data: {
			guardrailId: "guardrail-1",
			total: 2,
			versions: [
				{ id: "version-1", version: 1, createdAt: now },
				{ id: "version-2", version: 2, createdAt: now },
			],
		},
	});
	for (const path of [
		"/admin/guardrails",
		"/admin/guardrails/guardrail-1/versions",
	]) {
		const old = await app.request(path);
		assert.equal(old.status, 200);
		privateResponse(old);
		assert.equal((await old.text()).includes(secret), true);
	}
});

test("summary PATCH/designate never return config; legacy writes remain full", async () => {
	const { app } = fixture();
	const patch = await app.request(
		"/admin/guardrails/guardrail-1?view=summary",
		{
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: '{"name":"Renamed","status":"archived"}',
		}
	);
	assert.equal(patch.status, 200);
	privateResponse(patch);
	const patchText = await patch.text();
	assert.equal(patchText.includes(secret), false);
	assert.deepEqual(JSON.parse(patchText).data, {
		id: "guardrail-1",
		workspaceId: "workspace-other",
		ownerUserId: "owner-other",
		name: "Renamed",
		description: "Managed across workspaces",
		status: "archived",
		isWorkspaceDefault: false,
		isAccountDefault: false,
		accountScopeKey: null,
		designatedVersion: 1,
		latestVersion: 2,
	});
	const designate = await app.request(
		"/admin/guardrails/guardrail-1/designate?view=summary",
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"version":2}',
		}
	);
	assert.equal(designate.status, 200);
	privateResponse(designate);
	const designateText = await designate.text();
	assert.equal(designateText.includes(secret), false);
	assert.equal(JSON.parse(designateText).data.designatedVersion, 2);
	const legacy = await app.request("/admin/guardrails/guardrail-1", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: '{"description":"legacy"}',
	});
	assert.equal(legacy.status, 200);
	privateResponse(legacy);
	assert.equal((await legacy.text()).includes(secret), true);
});

test("summary writes report a private error when the updated row cannot be confirmed", async () => {
	for (const [path, request] of [
		[
			"/admin/guardrails/guardrail-1?view=summary",
			{ method: "PATCH", body: '{"name":"Renamed"}' },
		],
		[
			"/admin/guardrails/guardrail-1/designate?view=summary",
			{ method: "POST", body: '{"version":2}' },
		],
	] as const) {
		const response = await fixture({ missingAfterWrite: true }).app.request(
			path,
			request
		);
		assert.equal(response.status, 500, path);
		privateResponse(response);
		const text = await response.text();
		assert.equal(text.includes(secret), false);
		assert.equal(text.includes("Renamed"), false);
	}
});

test("validation, absence, effective-preview early errors and storage failure are private", async () => {
	for (const [path, request, status] of [
		["/admin/guardrails/missing/version-summaries", undefined, 404],
		["/admin/guardrails/effective", undefined, 400],
		[
			"/admin/guardrails/effective?workspace_id=workspace-other&user_id=missing",
			undefined,
			404,
		],
		[
			"/admin/guardrails/guardrail-1?view=raw",
			{ method: "PATCH", body: "{}" },
			400,
		],
		[
			"/admin/guardrails/guardrail-1/designate?view=summary",
			{ method: "POST", body: '{"version":0}' },
			400,
		],
	] as const) {
		const response = await fixture().app.request(path, request);
		assert.equal(response.status, status, path);
		privateResponse(response);
		assert.equal((await response.text()).includes(secret), false);
	}
	const original = console.error;
	console.error = () => undefined;
	try {
		const storage = await fixture({ failList: true }).app.request(
			"/admin/guardrails/summaries"
		);
		assert.equal(storage.status, 500);
		privateResponse(storage);
		assert.equal((await storage.text()).includes("storage failure"), false);
	} finally {
		console.error = original;
	}
});

test("Gateway Key assignment requires an active key in the target workspace", async () => {
	const path = "/admin/guardrails/guardrail-1/assignments";
	const request = (scopeId: string) => ({
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ scope_type: "api_key", scope_id: scopeId }),
	});
	const inactive = fixture({ keyStatus: "revoked" });
	const denied = await inactive.app.request(path, request("key-1"));
	assert.equal(denied.status, 404);
	privateResponse(denied);
	assert.deepEqual(inactive.calls, [
		"get:guardrail-1",
		"key:key-1:workspace-other",
	]);
	assert.equal(inactive.calls.includes("assign:guardrail-1"), false);
	const missing = fixture();
	const wrongWorkspace = await missing.app.request(
		path,
		request("key-in-other-workspace")
	);
	assert.equal(wrongWorkspace.status, 404);
	privateResponse(wrongWorkspace);
	assert.deepEqual(missing.calls, [
		"get:guardrail-1",
		"key:key-in-other-workspace:workspace-other",
	]);
	assert.equal(missing.calls.includes("assign:guardrail-1"), false);
	const active = fixture();
	const bound = await active.app.request(path, request("key-1"));
	assert.equal(bound.status, 200);
	privateResponse(bound);
	assert.deepEqual(active.calls, [
		"get:guardrail-1",
		"key:key-1:workspace-other",
		"assign:guardrail-1",
	]);
	assert.equal(
		((await bound.json()) as { data: { scopeId: string } }).data.scopeId,
		"key-1"
	);
});

test("Gateway Key assignment maps target conflict and verifies returned target", async () => {
	const path = "/admin/guardrails/guardrail-1/assignments";
	const request = {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: '{"scope_type":"api_key","scope_id":"key-1"}',
	};
	const conflict = await fixture({ assignmentConflict: true }).app.request(
		path,
		request
	);
	assert.equal(conflict.status, 409);
	privateResponse(conflict);
	const mismatch = await fixture({
		assignmentTarget: "other-guardrail",
	}).app.request(path, request);
	assert.equal(mismatch.status, 409);
	privateResponse(mismatch);
	const valid = await fixture().app.request(path, request);
	assert.equal(valid.status, 200);
	privateResponse(valid);
	const body = (await valid.json()) as { data: { guardrailId: string } };
	assert.equal(body.data.guardrailId, "guardrail-1");
});

test("Gateway Key revocation after precheck maps to private 409 without changing the binding", async () => {
	const f = fixture({
		assignmentScopeConflict: true,
		assignmentTarget: "previous-guardrail",
	});
	const response = await f.app.request(
		"/admin/guardrails/guardrail-1/assignments",
		{
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: '{"scope_type":"api_key","scope_id":"key-1"}',
		}
	);
	assert.equal(response.status, 409);
	privateResponse(response);
	assert.deepEqual(await response.json(), {
		success: false,
		code: "guardrail_assignment_scope_not_assignable",
		message: "Assignment scope changed while the binding was being applied",
	});
	assert.deepEqual(f.calls, [
		"get:guardrail-1",
		"key:key-1:workspace-other",
		"assign:guardrail-1",
	]);
	assert.equal(f.currentBinding().guardrail_id, "previous-guardrail");
});

test("conditional DELETE protects changed assignments; legacy deletion retains boolean response", async () => {
	const path =
		"/admin/guardrails/assignments/api_key/key-1?workspace_id=workspace-other";
	const changed = fixture({ assignmentTarget: "other-guardrail" });
	const conflict = await changed.app.request(
		path + "&expected_guardrail_id=guardrail-1",
		{ method: "DELETE" }
	);
	assert.equal(conflict.status, 409);
	privateResponse(conflict);
	assert.deepEqual(changed.deleteArgs[0], [
		"workspace-other",
		"api_key",
		"key-1",
		undefined,
		"guardrail-1",
	]);
	const invalid = await fixture().app.request(
		path + "&expected_guardrail_id=%20bad",
		{ method: "DELETE" }
	);
	assert.equal(invalid.status, 400);
	privateResponse(invalid);
	const safe = await fixture().app.request(
		path + "&expected_guardrail_id=guardrail-1",
		{ method: "DELETE" }
	);
	assert.equal(safe.status, 200);
	privateResponse(safe);
	assert.deepEqual(await safe.json(), {
		success: true,
		removed: true,
		acknowledgement: {
			domain: "guardrails",
			operation: "unbind",
			id: "guardrail-1",
			related_id: "key-1",
		},
	});
	const legacy = await fixture().app.request(path, { method: "DELETE" });
	assert.equal(legacy.status, 200);
	privateResponse(legacy);
	assert.deepEqual(await legacy.json(), {
		success: true,
		removed: true,
		acknowledgement: {
			domain: "guardrails",
			operation: "unbind",
			related_id: "key-1",
		},
	});
});

test("read/write permissions deny before repository access", async () => {
	for (const path of [
		"/admin/guardrails/summaries",
		"/admin/guardrails/guardrail-1/version-summaries",
	]) {
		assert.deepEqual(getAdminAuthorizationDecision("GET", path), {
			kind: "permission",
			permission: "guardrails.read",
		});
		const denied = fixture({ principal: apiKey([]) });
		assert.equal((await denied.app.request(path)).status, 403);
		assert.deepEqual(denied.calls, []);
		assert.equal(
			(
				await fixture({ principal: apiKey(["guardrails.read"]) }).app.request(
					path
				)
			).status,
			200
		);
	}
	for (const [method, path, body] of [
		["PATCH", "/admin/guardrails/guardrail-1?view=summary", "{}"],
		[
			"POST",
			"/admin/guardrails/guardrail-1/designate?view=summary",
			'{"version":1}',
		],
		[
			"DELETE",
			"/admin/guardrails/assignments/api_key/key-1?workspace_id=workspace-other&expected_guardrail_id=guardrail-1",
			undefined,
		],
	] as const) {
		assert.deepEqual(
			getAdminAuthorizationDecision(method, path.split("?")[0]),
			{ kind: "permission", permission: "guardrails.write" }
		);
		const denied = fixture({ principal: apiKey(["guardrails.read"]) });
		assert.equal(
			(await denied.app.request(path, { method, body })).status,
			403
		);
		assert.deepEqual(denied.calls, []);
	}
	const anonymous = fixture({ principal: null });
	assert.equal(
		(await anonymous.app.request("/admin/guardrails/summaries")).status,
		401
	);
	assert.deepEqual(anonymous.calls, []);
});
