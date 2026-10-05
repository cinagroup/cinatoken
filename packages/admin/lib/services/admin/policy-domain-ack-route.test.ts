import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	GuardrailAssignmentRow,
	GuardrailWithVersionRow,
	RequestPresetWithVersionRow,
	UpdateGuardrailMetadataPatch,
	UpdateRequestPresetMetadataPatch,
} from "@octafuse/core";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { EXPECTED_CONSOLE_SUBJECT_HEADER } from "./expected-console-subject";

const now = "2026-10-01T00:00:00.000Z";
const subject = "operator%policy";
const privateSentinel = "SYNTHETIC_PRIVATE_POLICY_CONFIG";
const trusted: AdminPrincipal = {
	type: "console",
	username: `cinaauth:${subject}`,
	id: `console:cinaauth:${subject}`,
};
const named: AdminPrincipal = {
	type: "api_key",
	id: "admin_key:policy-test",
	keyId: "policy-test",
	permissions: ["presets.write", "guardrails.write"],
};
type Call = { kind: string; args: unknown[] };

/** Real Admin Hono/middleware/handlers; only repository data and receipts are synthetic. */
function fixture(
	options: {
		principal?: AdminPrincipal;
		removed?: boolean;
		guardrailPatchConflict?: boolean;
	} = {}
) {
	const calls: Call[] = [];
	let preset: RequestPresetWithVersionRow = {
		id: "preset-1",
		workspace_id: "workspace-1",
		owner_user_id: "owner-1",
		slug: "preset",
		name: "Preset",
		description: null,
		visibility: "private",
		status: "active",
		designated_version: 1,
		latest_version: 2,
		created_at: now,
		updated_at: now,
		version_id: "preset-version-1",
		version_system_prompt: privateSentinel,
		version_config_json: JSON.stringify({
			model: "model-1",
			private: privateSentinel,
		}),
		version_created_by_user_id: "owner-1",
		version_created_at: now,
	};
	let guardrail: GuardrailWithVersionRow = {
		id: "guardrail-1",
		workspace_id: "workspace-1",
		owner_user_id: "owner-1",
		name: "Guardrail",
		description: null,
		status: "active",
		is_workspace_default: false,
		is_account_default: false,
		account_scope_key: null,
		designated_version: 1,
		latest_version: 2,
		created_at: now,
		updated_at: now,
		version_id: "guardrail-version-1",
		version_config_json: JSON.stringify({
			allowed_models: ["model-1"],
			private: privateSentinel,
		}),
		version_created_by_user_id: "owner-1",
		version_created_at: now,
	};
	const record = (kind: string, ...args: unknown[]) => {
		calls.push({ kind, args });
	};
	const repositories = {
		client: { driver: "d1", raw: {} },
		requestPresets: {
			getById: async (id: string) => {
				record("preset.read", id);
				return id === preset.id ? preset : null;
			},
			updateMetadata: async (
				id: string,
				patch: UpdateRequestPresetMetadataPatch
			) => {
				record("preset.update", id, patch);
				preset = {
					...preset,
					...(patch.name === undefined ? {} : { name: patch.name }),
				};
			},
			designateVersion: async (id: string, version: number, nowIso: string) => {
				record("preset.designate", id, version, nowIso);
				preset = { ...preset, designated_version: version };
				return true;
			},
		},
		guardrails: {
			getById: async (id: string) => {
				record("guardrail.read", id);
				return id === guardrail.id ? guardrail : null;
			},
			updateMetadata: async (
				id: string,
				patch: UpdateGuardrailMetadataPatch
			) => {
				record("guardrail.update", id, patch);
				if (options.guardrailPatchConflict) return false;
				guardrail = {
					...guardrail,
					...(patch.name === undefined ? {} : { name: patch.name }),
				};
				return true;
			},
			designateVersion: async (id: string, version: number, nowIso: string) => {
				record("guardrail.designate", id, version, nowIso);
				guardrail = { ...guardrail, designated_version: version };
				return true;
			},
			upsertAssignment: async (params: {
				id: string;
				workspaceId: string;
				guardrailId: string;
				scopeType: "api_key" | "user";
				scopeId: string;
				createdByUserId: null;
				nowIso: string;
			}) => {
				record("guardrail.bind", params);
				return {
					id: params.id,
					workspace_id: params.workspaceId,
					guardrail_id: params.guardrailId,
					scope_type: params.scopeType,
					scope_id: params.scopeId,
					created_by_user_id: null,
					management_source: "admin",
					assigned_by_user_id: null,
					created_at: params.nowIso,
					guardrail_name: guardrail.name,
				} satisfies GuardrailAssignmentRow;
			},
			deleteAssignment: async (...args: unknown[]) => {
				record("guardrail.unbind", ...args);
				return options.removed ?? true;
			},
		},
		apiKeys: {
			getApiKeyByIdInWorkspace: async (id: string, workspaceId: string) => {
				record("key.read", id, workspaceId);
				return id === "key-1" && workspaceId === "workspace-1"
					? { id, status: "active" }
					: null;
			},
		},
	} as unknown as GatewayRepositories;
	const app = createAdminApp();
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL: options.principal ?? trusted,
	} as unknown as AdminBindings;
	return {
		calls,
		request: (
			path: string,
			method: string,
			body?: unknown,
			header: string | null = encodeURIComponent(subject)
		) =>
			app.fetch(
				new Request(`https://test.invalid/admin/${path}`, {
					method,
					headers: {
						...(body === undefined
							? {}
							: { "Content-Type": "application/json" }),
						...(header === null
							? {}
							: { [EXPECTED_CONSOLE_SUBJECT_HEADER]: header }),
					},
					...(body === undefined ? {} : { body: JSON.stringify(body) }),
				}),
				bindings
			),
	};
}

const cases = [
	{
		path: "presets/preset-1?view=summary",
		method: "PATCH",
		body: { name: "Renamed" },
		write: "preset.update",
		ack: { domain: "presets", operation: "update", id: "preset-1" },
	},
	{
		path: "presets/preset-1/designate?view=summary",
		method: "POST",
		body: { version: 2 },
		write: "preset.designate",
		ack: { domain: "presets", operation: "designate", id: "preset-1" },
	},
	{
		path: "guardrails/guardrail-1?view=summary",
		method: "PATCH",
		body: { name: "Renamed" },
		write: "guardrail.update",
		ack: { domain: "guardrails", operation: "update", id: "guardrail-1" },
	},
	{
		path: "guardrails/guardrail-1/designate?view=summary",
		method: "POST",
		body: { version: 2 },
		write: "guardrail.designate",
		ack: { domain: "guardrails", operation: "designate", id: "guardrail-1" },
	},
	{
		path: "guardrails/guardrail-1/assignments",
		method: "PUT",
		body: { scope_type: "api_key", scope_id: "key-1" },
		write: "guardrail.bind",
		ack: {
			domain: "guardrails",
			operation: "bind",
			id: "guardrail-1",
			related_id: "key-1",
		},
	},
	{
		path: "guardrails/assignments/api_key/key-1?workspace_id=workspace-1&expected_guardrail_id=guardrail-1",
		method: "DELETE",
		body: undefined,
		write: "guardrail.unbind",
		ack: {
			domain: "guardrails",
			operation: "unbind",
			id: "guardrail-1",
			related_id: "key-1",
		},
	},
] as const;
const assertPrivate = (response: Response, status: number) => {
	assert.equal(response.status, status);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
};

for (const item of cases) {
	test(`policy Hono ACK: ${item.write} identifies exact domain/operation/resources and one repository write`, async () => {
		const f = fixture(),
			response = await f.request(item.path, item.method, item.body);
		assertPrivate(response, 200);
		const text = await response.text(),
			body = JSON.parse(text) as {
				success: boolean;
				acknowledgement: unknown;
				data?: Record<string, unknown>;
				removed?: boolean;
			};
		assert.equal(body.success, true);
		assert.deepEqual(body.acknowledgement, item.ack);
		assert.equal(text.includes(privateSentinel), false);
		const writes = f.calls.filter((call) => !call.kind.endsWith(".read"));
		assert.equal(writes.length, 1);
		assert.equal(writes[0]?.kind, item.write);
		if (item.write.endsWith(".update")) {
			assert.equal(writes[0]?.args[0], item.ack.id);
			assert.equal(body.data?.name, "Renamed");
		}
		if (item.write.endsWith(".designate")) {
			assert.equal(writes[0]?.args[0], item.ack.id);
			assert.equal(writes[0]?.args[1], 2);
			assert.equal(body.data?.designatedVersion, 2);
		}
		if (item.write === "guardrail.bind") {
			assert.deepEqual(f.calls.find((call) => call.kind === "key.read")?.args, [
				"key-1",
				"workspace-1",
			]);
			const params = writes[0]?.args[0] as {
				id: string;
				workspaceId: string;
				guardrailId: string;
				scopeType: string;
				scopeId: string;
				createdByUserId: null;
				nowIso: string;
			};
			assert.match(params.id, /^[0-9a-f-]{36}$/u);
			assert.deepEqual(
				{ ...params, id: "generated", nowIso: "server-time" },
				{
					id: "generated",
					workspaceId: "workspace-1",
					guardrailId: "guardrail-1",
					scopeType: "api_key",
					scopeId: "key-1",
					createdByUserId: null,
					nowIso: "server-time",
				}
			);
			assert.equal(body.data?.guardrailId, "guardrail-1");
			assert.equal(body.data?.scopeId, "key-1");
		}
		if (item.write === "guardrail.unbind") {
			assert.deepEqual(writes[0]?.args, [
				"workspace-1",
				"api_key",
				"key-1",
				undefined,
				"guardrail-1",
			]);
			assert.equal(body.removed, true);
		}
	});
	test(`policy Hono subject guard: ${item.write} stale provided subject has zero repository calls and no ACK`, async () => {
		const f = fixture(),
			response = await f.request(
				item.path,
				item.method,
				item.body,
				"different-actor"
			);
		assertPrivate(response, 403);
		const body = (await response.json()) as {
			code: string;
			acknowledgement?: unknown;
		};
		assert.equal(body.code, "console_subject_mismatch");
		assert.equal(body.acknowledgement, undefined);
		assert.deepEqual(f.calls, []);
	});
}

test("policy Hono legacy: authorized headerless Console and named API clients keep exact ACKs", async () => {
	for (const principal of [trusted, named])
		for (const item of cases) {
			const f = fixture({ principal });
			const response = await f.request(item.path, item.method, item.body, null);
			assertPrivate(response, 200);
			assert.deepEqual(
				((await response.json()) as { acknowledgement: unknown })
					.acknowledgement,
				item.ack
			);
		}
});
test("policy Hono named client cannot supply a Console subject to select the audit actor", async () => {
	for (const item of cases) {
		const f = fixture({ principal: named }),
			response = await f.request(item.path, item.method, item.body);
		assertPrivate(response, 400);
		assert.equal(
			((await response.json()) as { acknowledgement?: unknown })
				.acknowledgement,
			undefined
		);
		assert.deepEqual(f.calls, []);
	}
});
test("policy Hono conditional unbind conflict preserves resource precondition and has no success ACK", async () => {
	const f = fixture({ removed: false }),
		item = cases[5],
		response = await f.request(item.path, item.method, item.body);
	assertPrivate(response, 409);
	assert.equal(
		((await response.json()) as { acknowledgement?: unknown }).acknowledgement,
		undefined
	);
	assert.deepEqual(f.calls, [
		{
			kind: "guardrail.unbind",
			args: ["workspace-1", "api_key", "key-1", undefined, "guardrail-1"],
		},
	]);
});
test("policy Hono conditional metadata conflict has no success ACK", async () => {
	const f = fixture({ guardrailPatchConflict: true }),
		item = cases[2],
		response = await f.request(item.path, item.method, item.body);
	assertPrivate(response, 409);
	assert.equal(
		((await response.json()) as { acknowledgement?: unknown }).acknowledgement,
		undefined
	);
	assert.deepEqual(
		f.calls.map((call) => call.kind),
		["guardrail.read", "guardrail.update"]
	);
});
