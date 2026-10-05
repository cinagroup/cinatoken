import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	GatewayRepositories,
	GuardrailAssignmentRow,
	GuardrailWithVersionRow,
} from "@octafuse/core";
import { userGuardrailsRoutes } from "@/lib/routes/user/guardrails";
import type { UserEnv } from "@/lib/user-env";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";

const row: GuardrailWithVersionRow = {
	id: "owned",
	workspace_id: "workspace-1",
	owner_user_id: "user-1",
	name: "Policy",
	description: null,
	status: "active",
	designated_version: 1,
	latest_version: 2,
	created_at: "2026-09-27T00:00:00Z",
	updated_at: "2026-09-27T00:00:00Z",
	version_id: "version-1",
	version_config_json: "{}",
	version_created_by_user_id: "user-1",
	version_created_at: "2026-09-27T00:00:00Z",
};
const binding: GuardrailAssignmentRow = {
	id: "binding-1",
	workspace_id: "workspace-1",
	guardrail_id: "owned",
	scope_type: "user",
	scope_id: "user-1",
	created_by_user_id: "user-1",
	management_source: null,
	assigned_by_user_id: "user-1",
	created_at: "2026-09-27T00:00:00Z",
	guardrail_name: "Policy",
};
type Body = {
	success: boolean;
	code?: string;
	message?: string;
	workspaceId?: string;
	userId?: string;
	accountScopeKey?: string;
	budgetCurrency?: string;
	data?: unknown;
	trace?: unknown[];
};
function fixture(
	options: {
		rows?: GuardrailWithVersionRow[];
		capability?: boolean;
		managed?: boolean;
		casManaged?: boolean;
		casFailure?: boolean;
		oldBinding?: boolean;
		targetFailure?: boolean;
		scopeFailure?: boolean;
		conflict?: boolean;
		bindings?: GuardrailAssignmentRow[];
	} = {}
) {
	const rows = new Map(
		(options.rows ?? [row]).map((value) => [value.id, { ...value }])
	);
	const writes: { method: string; params: unknown }[] = [];
	let managed = Boolean(options.managed);
	const assignments = () =>
		options.bindings ?? [
			managed
				? {
						...binding,
						created_by_user_id: null,
						management_source: "management_api" as const,
						assigned_by_user_id: "manager",
				  }
				: binding,
		];
	const repositories = {
		systemConfig: {
			getConfig: async (key: string) =>
				key === "BILLING_CURRENCY" ? "CNY" : "UTC",
		},
		routes: { listModelRoutesWithJoins: async () => [] },
		guardrails: {
			listOwnedByWorkspace: async (
				workspaceId: string,
				userId: string,
				includeArchived: boolean
			) => {
				assert.equal(workspaceId, "workspace-1");
				assert.equal(userId, "user-1");
				assert.equal(includeArchived, true);
				return [...rows.values()];
			},
			getByIdInWorkspace: async (id: string) => rows.get(id) ?? null,
			getById: async (id: string) => rows.get(id) ?? null,
			listAssignments: async () => assignments(),
			listVersions: async (id: string) => [
				{
					id: "version-1",
					guardrail_id: id,
					version: 1,
					config_json: "{}",
					created_by_user_id: "user-1",
					created_at: row.created_at,
				},
			],
			createWithVersion: async (
				params: Parameters<
					GatewayRepositories["guardrails"]["createWithVersion"]
				>[0]
			) => {
				writes.push({ method: "create", params });
				const created = {
					...row,
					id: params.id,
					name: params.name,
					description: params.description,
					workspace_id: params.workspaceId,
					owner_user_id: params.ownerUserId,
					version_config_json: params.configJson,
				};
				rows.set(created.id, created);
				return created;
			},
			addVersion: async (
				params: Parameters<GatewayRepositories["guardrails"]["addVersion"]>[0]
			) => {
				writes.push({ method: "version", params });
				assert.equal(params.preserveAdminManaged, true);
				if (options.casManaged) {
					managed = true;
					return null;
				}
				if (options.casFailure) return null;
				const existing = rows.get(params.guardrailId)!;
				existing.latest_version++;
				existing.designated_version = existing.latest_version;
				existing.version_config_json = params.configJson;
				return existing;
			},
			updateMetadata: async (
				id: string,
				params: Parameters<
					GatewayRepositories["guardrails"]["updateMetadata"]
				>[1]
			) => {
				writes.push({ method: "metadata", params });
				assert.equal(params.preserveAdminManaged, true);
				if (options.casManaged) {
					managed = true;
					return false;
				}
				if (options.casFailure) return false;
				Object.assign(rows.get(id)!, {
					...(params.name ? { name: params.name } : {}),
					...(params.status ? { status: params.status } : {}),
					...(params.description !== undefined
						? { description: params.description }
						: {}),
				});
				return true;
			},
			designateVersion: async (
				id: string,
				version: number,
				_at: string,
				params: Parameters<
					GatewayRepositories["guardrails"]["designateVersion"]
				>[3]
			) => {
				writes.push({ method: "designate", params });
				assert.equal(params?.preserveAdminManaged, true);
				if (options.casManaged) {
					managed = true;
					return false;
				}
				if (options.casFailure) return false;
				rows.get(id)!.designated_version = version;
				return true;
			},
			upsertAssignment: async (
				params: Parameters<
					GatewayRepositories["guardrails"]["upsertAssignment"]
				>[0]
			) => {
				writes.push({ method: "bind", params });
				assert.equal(params.preserveAdminManaged, true);
				if (options.scopeFailure)
					throw new Error("guardrail_assignment_scope_not_assignable");
				if (options.targetFailure)
					throw new Error("guardrail_assignment_target_not_assignable");
				if (options.oldBinding)
					return { ...binding, guardrail_id: "old-policy" };
				if (managed) return { ...binding, created_by_user_id: null };
				return {
					...binding,
					guardrail_id: params.guardrailId,
					scope_type: params.scopeType,
					scope_id: params.scopeId,
				};
			},
			deleteAssignment: async (
				workspaceId: string,
				scopeType: string,
				scopeId: string,
				userId: string
			) => {
				writes.push({
					method: "unbind",
					params: { workspaceId, scopeType, scopeId, userId },
				});
				assert.equal(workspaceId, "workspace-1");
				assert.equal(userId, "user-1");
				return !managed;
			},
			getEffectiveForRequest: async () =>
				options.conflict
					? [
							{
								...row,
								version_config_json: "invalid json",
								assignment_id: "assignment-1",
								assignment_scope_type: "user",
								assignment_scope_id: "user-1",
							},
					  ]
					: [],
		},
		apiKeys: {
			getApiKeyByIdInWorkspace: async (id: string, workspaceId: string) =>
				id === "owned-key" || id === "revoked-key"
					? {
							id,
							user_id: "user-1",
							workspace_id: workspaceId,
							status: id === "revoked-key" ? "revoked" : "active",
					  }
					: id === "foreign-key"
					? {
							id,
							user_id: "other",
							workspace_id: workspaceId,
							status: "active",
					  }
					: null,
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
			subject: "subject",
			email: "user@example.com",
			isAdmin: false,
			capabilities: options.capability === false ? [] : ["account.read"],
		});
		c.set("workspaceContext", {
			currentWorkspace: {
				id: "workspace-1",
				scopeType: "organization",
				organizationId: "org-1",
				personalOwnerUserId: null,
				role: "owner",
			},
		} as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/guardrails", userGuardrailsRoutes);
	const request = (
		path: string,
		method = "GET",
		body?: unknown,
		workspace = "workspace-1"
	) =>
		app.request(`/guardrails${path}`, {
			method,
			headers: {
				"Content-Type": "application/json",
				"X-CinaToken-Workspace": encodeURIComponent(workspace),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	return { app, request, rows, writes };
}
test("Guardrails capability guards every read and write with private no-store", async () => {
	const f = fixture({ capability: false });
	for (const [path, method] of [
		["", "GET"],
		["/effective", "GET"],
		["/owned/versions", "GET"],
		["/owned/assignments", "GET"],
		["", "POST"],
		["/owned", "PATCH"],
		["/owned", "DELETE"],
		["/owned/versions", "POST"],
		["/owned/designate", "POST"],
		["/owned/assignments", "PUT"],
		["/assignments/user/user-1", "DELETE"],
	]) {
		const response = await f.request(
			path,
			method,
			method === "GET" ? undefined : {}
		);
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(f.writes.length, 0);
});
test("empty list proves current account and configured budget currency independent of organization role", async () => {
	const response = await fixture({ rows: [] }).request("");
	const body = (await response.json()) as {
		data: {
			workspaceId: string;
			userId: string;
			accountScopeKey: string;
			budgetCurrency: string;
			guardrails: unknown[];
		};
	};
	assert.equal(response.status, 200);
	assert.equal(body.data.workspaceId, "workspace-1");
	assert.equal(body.data.userId, "user-1");
	assert.equal(body.data.accountScopeKey, "organization:org-1");
	assert.equal(body.data.budgetCurrency, "CNY");
	assert.deepEqual(body.data.guardrails, []);
});
test("server permissions make managed policies and cross-workspace account defaults read-only", async () => {
	const defaults = {
		...row,
		id: "default",
		workspace_id: "other-workspace",
		owner_user_id: "other-member",
		is_account_default: true,
		account_scope_key: "organization:org-1",
	};
	const f = fixture({ rows: [defaults], managed: true });
	const response = await f.request("");
	const body = (await response.json()) as {
		data: {
			guardrails: {
				canEdit: boolean;
				canAssign: boolean;
				canArchive: boolean;
				adminManaged: boolean;
			}[];
		};
	};
	assert.deepEqual(
		body.data.guardrails.map((value) => [
			value.canEdit,
			value.canAssign,
			value.canArchive,
			value.adminManaged,
		]),
		[[false, false, false, true]]
	);
	assert.equal((await f.request("/default/versions")).status, 200);
	for (const method of ["PATCH", "DELETE"])
		assert.equal(
			(
				await f.request(
					"/default",
					method,
					method === "PATCH" ? { description: "x" } : undefined
				)
			).status,
			404
		);
	assert.equal(
		(
			await fixture({
				rows: [{ ...defaults, owner_user_id: "user-1" }],
			}).request("/default/versions", "POST", { config: {} })
		).status,
		404
	);
});
test("organization owner role cannot read or edit a foreign member policy or unrelated account default", async () => {
	const foreign = { ...row, id: "foreign", owner_user_id: "other" };
	const wrongDefault = {
		...foreign,
		id: "other-default",
		is_account_default: true,
		account_scope_key: "organization:other",
	};
	const f = fixture({ rows: [foreign, wrongDefault] });
	for (const id of ["foreign", "other-default"])
		for (const path of [`/${id}/versions`, `/${id}/assignments`])
			assert.equal((await f.request(path)).status, 404);
	assert.equal(
		(await f.request("/foreign", "PATCH", { description: "x" })).status,
		404
	);
	assert.equal(f.writes.length, 0);
});
test("create saves server ownership and supports all seven filters while rejecting unsafe regex or unsupported permissions", async () => {
	const f = fixture();
	const config = {
		content_filter_builtins: [
			"email",
			"phone",
			"ssn",
			"credit-card",
			"ip-address",
			"secrets",
			"regex-prompt-injection",
		].map((slug) => ({
			slug,
			action: slug === "regex-prompt-injection" ? "flag" : "redact",
		})),
		input_filters: [{ id: "input", pattern: "secret{1,4}", action: "block" }],
		output_filters: [{ id: "output", pattern: "[0-9]{4}", action: "redact" }],
		budget: { limit: 0.123456, period: "daily" },
		data_collection: "deny",
		require_zdr: true,
		zdr: { openai: true },
		openrouter: { enable_paid_model_training: true },
	};
	assert.equal(
		(
			await f.request("", "POST", {
				name: " Policy ",
				description: null,
				config,
				ownerUserId: "attacker",
				workspaceId: "other",
			})
		).status,
		201
	);
	const saved = f.writes[0].params as {
		ownerUserId: string;
		workspaceId: string;
		configJson: string;
	};
	assert.equal(saved.ownerUserId, "user-1");
	assert.equal(saved.workspaceId, "workspace-1");
	assert.equal(JSON.parse(saved.configJson).budget.limit, 0.123456);
	for (const invalid of [
		{ input_filters: [{ id: "unsafe", pattern: "(a+)+", action: "block" }] },
		{ content_filter_builtins: [{ slug: "person-name", action: "block" }] },
		{ openrouter: { enable_paid_model_training: false } },
	])
		assert.equal(
			(await f.request("", "POST", { name: "Bad", config: invalid })).status,
			400
		);
	assert.equal(f.writes.length, 1);
});
test("new version preserves managed CAS and archived policy rejects append", async () => {
	const input = {
		name: "Policy",
		description: null,
		config: { allowed_models: [] },
	};
	const success = fixture();
	assert.equal(
		(await success.request("/owned/versions", "POST", input)).status,
		201
	);
	assert.equal(success.rows.get("owned")!.designated_version, 3);
	const cleared = fixture({
		rows: [{ ...row, description: "Old description" }],
	});
	assert.equal(
		(await cleared.request("/owned/versions", "POST", input)).status,
		201
	);
	assert.equal(
		(cleared.writes[0].params as { description: string | null }).description,
		null,
		"explicit null clears the previous description"
	);
	assert.equal(
		(
			await fixture({ casManaged: true }).request(
				"/owned/versions",
				"POST",
				input
			)
		).status,
		403
	);
	assert.equal(
		(
			await fixture({ casFailure: true }).request(
				"/owned/versions",
				"POST",
				input
			)
		).status,
		409
	);
	assert.equal(
		(
			await fixture({ rows: [{ ...row, status: "archived" }] }).request(
				"/owned/versions",
				"POST",
				input
			)
		).status,
		409
	);
});
test("default name and lifecycle are immutable while policy ceiling validates restricted fields", async () => {
	const f = fixture({
		rows: [
			{
				...row,
				is_account_default: true,
				account_scope_key: "organization:org-1",
			},
		],
	});
	assert.equal(
		(await f.request("/owned", "PATCH", { name: "Rename" })).status,
		400
	);
	assert.equal(
		(await f.request("/owned", "PATCH", { status: "archived" })).status,
		400
	);
	assert.equal((await f.request("/owned", "DELETE")).status, 403);
	assert.equal(
		(
			await f.request("/owned/assignments", "PUT", {
				scope_type: "user",
				scope_id: "user-1",
			})
		).status,
		400
	);
	assert.equal(
		(await f.request("/owned/versions", "POST", { name: "Rename", config: {} }))
			.status,
		400
	);
	assert.equal(
		(
			await f.request("/owned/versions", "POST", {
				name: "Policy",
				config: { budget: { limit: 1, period: "daily" } },
			})
		).status,
		400
	);
	assert.equal(
		(await f.request("/owned", "PATCH", { description: "Owner description" }))
			.status,
		200
	);
});
test("metadata, designation and archive protect concurrent administrator takeover", async () => {
	for (const [path, method, body] of [
		["/owned", "PATCH", { description: "x" }],
		["/owned/designate", "POST", { version: 1 }],
		["/owned", "DELETE", undefined],
	] as const) {
		assert.equal(
			(await fixture({ managed: true }).request(path, method, body)).status,
			403
		);
		assert.equal(
			(await fixture({ casManaged: true }).request(path, method, body)).status,
			403
		);
	}
	const f = fixture();
	assert.equal((await f.request("/owned", "DELETE")).status, 200);
	assert.equal(f.rows.get("owned")!.status, "archived");
	assert.equal(
		(await f.request("/owned", "PATCH", { status: "active" })).status,
		200
	);
	assert.equal(f.rows.get("owned")!.status, "active");
});
test("binding accepts owned scopes only and rejects managed, archived or changed target without false success", async () => {
	for (const scope of [
		{ scope_type: "user", scope_id: "other" },
		{ scope_type: "api_key", scope_id: "foreign-key" },
		{ scope_type: "api_key", scope_id: "revoked-key" },
	])
		assert.equal(
			(await fixture().request("/owned/assignments", "PUT", scope)).status,
			403
		);
	const input = { scope_type: "api_key", scope_id: "owned-key" };
	assert.equal(
		(
			await fixture({ managed: true }).request(
				"/owned/assignments",
				"PUT",
				input
			)
		).status,
		403
	);
	assert.equal(
		(
			await fixture({ rows: [{ ...row, status: "archived" }] }).request(
				"/owned/assignments",
				"PUT",
				input
			)
		).status,
		404
	);
	const target = await fixture({ targetFailure: true }).request(
		"/owned/assignments",
		"PUT",
		input
	);
	assert.equal(target.status, 409);
	assert.equal(
		((await target.json()) as Body).code,
		"guardrail_assignment_target_not_assignable"
	);
	const scopeFixture = fixture({ scopeFailure: true });
	const scope = await scopeFixture.request("/owned/assignments", "PUT", input);
	assert.equal(scope.status, 409);
	assert.equal(scope.headers.get("cache-control"), "private, no-store");
	assert.deepEqual(await scope.json(), {
		success: false,
		code: "guardrail_assignment_scope_not_assignable",
		message: "Assignment scope changed while the binding was being applied",
	});
	assert.deepEqual(
		scopeFixture.writes.map((write) => write.method),
		["bind"]
	);
	assert.equal(
		(
			await fixture({ oldBinding: true }).request(
				"/owned/assignments",
				"PUT",
				input
			)
		).status,
		409
	);
	assert.equal(
		(await fixture().request("/owned/assignments", "PUT", input)).status,
		200
	);
});
test("assignment read exposes managed provenance and unbinding protects real scope ownership", async () => {
	const f = fixture({ managed: true });
	const response = await f.request("/owned/assignments");
	const body = (await response.json()) as {
		data: {
			managementSource: string;
			assignedByUserId: string;
			canUnbind: boolean;
		}[];
	};
	assert.equal(body.data[0].managementSource, "management_api");
	assert.equal(body.data[0].assignedByUserId, "manager");
	assert.equal(body.data[0].canUnbind, false);
	assert.equal(
		(await f.request("/assignments/user/user-1", "DELETE")).status,
		403
	);
	assert.equal(
		(await f.request("/assignments/user/other", "DELETE")).status,
		404
	);
	assert.equal(
		(await fixture().request("/assignments/api_key/foreign-key", "DELETE"))
			.status,
		404
	);
	assert.equal(
		(await fixture().request("/assignments/api_key/owned-key", "DELETE"))
			.status,
		200
	);
});
test("effective conflict keeps validated account metadata and trace, while foreign or revoked key stays 404", async () => {
	const f = fixture({ conflict: true });
	for (const key of ["foreign-key", "revoked-key"])
		assert.equal((await f.request(`/effective?api_key_id=${key}`)).status, 404);
	const response = await f.request("/effective");
	const body = (await response.json()) as Body & {
		pricingCurrency: string;
		apiKeyId: string | null;
	};
	assert.equal(response.status, 409);
	assert.equal(body.success, false);
	assert.equal(body.code, "guardrail_effective_conflict");
	assert.equal(body.workspaceId, "workspace-1");
	assert.equal(body.userId, "user-1");
	assert.equal(body.accountScopeKey, "organization:org-1");
	assert.equal(body.budgetCurrency, "CNY");
	assert.equal(body.pricingCurrency, "USD");
	assert.equal(body.apiKeyId, null);
	assert.equal(body.trace?.length, 1);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
});
test("stale shared Cookie workspace rejects writes before persistence", async () => {
	const f = fixture();
	const response = await f.request(
		"",
		"POST",
		{ name: "Wrong", config: {} },
		"other-workspace"
	);
	assert.equal(response.status, 409);
	assert.equal(((await response.json()) as Body).code, "workspace_mismatch");
	assert.equal(f.writes.length, 0);
});

test("account.read without gateway-key capability can repair an effective conflict through version or own unbinding", async () => {
	const f = fixture({ conflict: true });
	assert.equal((await f.request("/effective")).status, 409);
	assert.equal(
		(
			await f.request("/owned/versions", "POST", {
				name: "Policy",
				description: null,
				config: { allowed_models: [] },
			})
		).status,
		201
	);
	assert.equal(
		(await f.request("/assignments/user/user-1", "DELETE")).status,
		200
	);
	assert.deepEqual(
		f.writes.map((write) => write.method),
		["version", "unbind"]
	);
});
