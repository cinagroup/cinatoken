import assert from "node:assert/strict";
import test from "node:test";
import type {
	AdminKeyMutationWithAudit,
	GatewayRepositories,
	UserRow,
} from "@octafuse/core";
import { defaultWorkspaceId } from "@octafuse/core";
import type { AdminBindings } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminApp } from "@/lib/admin-app";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import { rejectInvalidAdminMutationOrigin } from "@/lib/browser-mutation";
import { listAdminKeys } from "./keys-service";
import {
	gatewayKeyRevision,
	keyMetadata,
	keyMetadataProjection,
} from "./gateway-key-contract";

const USER = "owner-1";
const KEY = "key-1";
const CONSOLE: AdminPrincipal = {
	type: "console",
	id: "console:operator",
	username: "operator",
};
type PublicKey = {
	id: string;
	key_id: string;
	key: string;
	user_id: string;
	workspace_id: string;
	name: string | null;
	status: string;
	profile_revision: string;
	metadata_raw: string | null;
	metadata_preview: string | null;
	metadata_unavailable: boolean;
	owner: {
		email: string;
		external_system: string | null;
		external_user_id: string | null;
	};
};
type KeyEnvelope = { data: PublicKey; message: string };
type ListEnvelope = {
	data: PublicKey[];
	capabilities: Record<string, boolean>;
};
async function readResponse<T = KeyEnvelope>(response: Response): Promise<T> {
	return response.json() as Promise<T>;
}
function fixture(
	options: {
		principal?: AdminPrincipal | null;
		requireRevision?: string;
		metadata?: string | null;
		fail?: boolean;
		missingAtomic?: boolean;
		key?: string;
		race?: boolean;
	} = {}
) {
	let user: UserRow = {
		id: USER,
		email: "owner@example.test",
		external_system: null,
		external_user_id: null,
		budget_max: 10,
		budget_base: 10,
		budget_spent: 3,
		budget_period: "none",
		budget_reset_at: null,
		budget_epoch: 0,
		budget_reserved_micros: 0,
		status: "active",
		metadata: null,
		charged_cost_factors: null,
		created_at: "2026-09-30T00:00:00.000Z",
		updated_at: "2026-09-30T00:00:00.000Z",
	};
	let key = {
		id: KEY,
		key: options.key ?? "sk-pretend-complete-secret",
		user_id: USER,
		workspace_id: defaultWorkspaceId("personal", USER),
		name: "Before" as string | null,
		status: "active",
		metadata:
			options.metadata === undefined
				? '{"token":"hidden","team":"ops"}'
				: options.metadata,
		created_at: user.created_at,
		updated_at: user.updated_at,
	};
	const mutations: AdminKeyMutationWithAudit[] = [];
	let reads = 0;
	let audits = 0;
	let created = 0;
	const row = () => ({
		...key,
		user_email: user.email,
		user_metadata: null,
		user_charged_cost_factors: null,
		budget_max: user.budget_max,
		budget_base: user.budget_base,
		budget_spent: user.budget_spent,
		budget_period: user.budget_period,
		budget_reset_at: user.budget_reset_at,
		budget_epoch: 0,
		budget_reserved_micros: 0,
	});
	const raw = {
		prepare: (sql: string) => ({
			bind: (...values: unknown[]) => ({ sql, values }),
		}),
		batch: async (statements: Array<{ sql: string; values: unknown[] }>) => {
			if (options.fail) throw new Error("injected atomic creation failure");
			const insert = statements.find((s) =>
				s.sql.includes("INSERT INTO api_keys")
			);
			if (insert) {
				const v = insert.values;
				created++;
				key = {
					...key,
					id: v[0] as string,
					key: v[3] as string,
					user_id: v[4] as string,
					workspace_id: v[5] as string,
					name: v[6] as string | null,
					status: v[7] as string,
					metadata: v[8] as string | null,
				};
				audits++;
			}
			return [];
		},
	};
	const repositories = {
		client: { driver: "d1", raw },
		users: {
			getById: async (id: string) => (id === user.id ? { ...user } : null),
			getByExternalPair: async (s: string, u: string) =>
				user.external_system === s && user.external_user_id === u
					? { ...user }
					: null,
			createUser: async (input: {
				id: string;
				email: string;
				externalSystem: string;
				externalUserId: string;
				budgetMax: number;
				budgetBase: number;
				budgetPeriod: string;
			}) => {
				user = {
					...user,
					id: input.id,
					email: input.email,
					external_system: input.externalSystem,
					external_user_id: input.externalUserId,
					budget_max: input.budgetMax,
					budget_base: input.budgetBase,
					budget_spent: 0,
					budget_period: input.budgetPeriod,
				};
			},
		},
		apiKeys: {
			getAllApiKeys: async () => {
				reads++;
				if (options.fail) throw new Error("injected storage failure");
				return { keys: [row()], total: 1 };
			},
			getApiKeyWithUserById: async () => {
				reads++;
				return row();
			},
			getApiKeyWithUserByKey: async () => row(),
			getApiKeyByKeyAnyStatus: async () => row(),
			scrubLegacyApiKeySecrets: async () => ({ scrubbed: 0, remaining: 0 }),
			applyAdminKeyMutationWithAudit: options.missingAtomic
				? undefined
				: async (m: AdminKeyMutationWithAudit) => {
						mutations.push(m);
						if (options.race) key = { ...key, workspace_id: "moved-workspace" };
						if (
							m.expected.workspaceId !== key.workspace_id ||
							m.expected.name !== key.name ||
							m.expected.metadata !== key.metadata ||
							m.expected.status !== key.status
						)
							return "conflict";
						if (options.fail) throw new Error("injected audit failure");
						key = { ...key, ...m.patch };
						if (m.audit) audits++;
						return "applied";
				  },
		},
		requestLogs: {
			getRequestLogsByKeyId: async () => ({ logs: [], total: 0 }),
		},
		userAuditLogs: {
			insertUserAuditLog: async () => {
				audits++;
			},
		},
	} as unknown as GatewayRepositories;
	const bindings = {
		STORAGE_CONTEXT: { repositories },
		ADMIN_PRINCIPAL:
			options.principal === null ? undefined : options.principal ?? CONSOLE,
		CINATOKEN_ADMIN_KEYS_REQUIRE_REVISION: options.requireRevision,
	} as unknown as AdminBindings;
	const app = createAdminApp();
	return {
		row,
		user: () => user,
		audits: () => audits,
		reads: () => reads,
		mutations,
		created: () => created,
		change: (patch: Partial<typeof key>) => {
			key = { ...key, ...patch };
		},
		request: (path = "", method = "GET", body?: unknown) => {
			const serialized = body === undefined ? undefined : JSON.stringify(body);
			return app.request(
				`/admin/keys${path}`,
				{
					method,
					body: serialized,
					...(serialized === undefined
						? {}
						: {
								headers: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(serialized)),
								},
						  }),
				},
				bindings
			);
		},
	};
}

test("global Key list has a strict public projection and verified independent capabilities", async () => {
	for (const secret of [
		"x",
		"sk-a",
		"sk-abcdef",
		"sk-abcde…abcd",
		`sk-${"a".repeat(1000)}`,
	]) {
		const subject = fixture({ key: secret });
		const response = await subject.request();
		const body = await readResponse<ListEnvelope>(response);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(body.data[0].key, "sk-…");
		assert.equal(body.data[0].metadata_preview, '{"field_count":2}');
		assert.equal("metadata" in body.data[0], false);
		assert.equal("metadata_raw" in body.data[0], false);
		assert.equal(JSON.stringify(body).includes("hidden"), false);
		assert.match(body.data[0].profile_revision, /^sha256:[0-9a-f]{64}$/u);
		assert.deepEqual(body.capabilities, {
			user_detail: true,
			request_logs: true,
			budget_audit: true,
			effective_guardrails: true,
			can_write: true,
		});
	}
	const bearer = fixture({
		principal: {
			type: "api_key",
			id: "admin_key:reader",
			keyId: "reader",
			permissions: ["user_keys.read", "logs.read"],
		},
	});
	assert.deepEqual(
		(await readResponse<ListEnvelope>(await bearer.request())).capabilities,
		{
			user_detail: false,
			request_logs: true,
			budget_audit: true,
			effective_guardrails: false,
			can_write: false,
		}
	);
});

test("paging, duplicates, unknown queries, IDs, filters and sort are strict before repository reads", async () => {
	for (const query of [
		"?page=0",
		"?page=-1",
		"?page=01",
		"?page=1x",
		"?page=1.5",
		"?page=1000001",
		"?page_size=101",
		"?page_size=",
		"?page=1&page=2",
		"?sort=",
		"?sort= created_at",
		"?order=DESC",
		"?email=",
		"?email=a%00b",
		"?user_id=",
		"?user_id=x%2Fy",
		"?unknown=x",
	]) {
		const subject = fixture();
		const response = await subject.request(query);
		assert.equal(response.status, 400, query);
		assert.equal(subject.reads(), 0, query);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	for (const query of [
		"?page=1&page_size=100&sort=budget_spent&order=asc",
		"?email=owner@example.test&user_id=owner-1",
	])
		assert.equal((await fixture().request(query)).status, 200);
	for (const suffix of [
		"/bad%20id",
		"/key-1?unknown=x",
		"/key-1/logs?page=2x",
		"/key-1/logs?include_statuses=success,unknown",
		"/key-1/logs?exclude_status=wat",
		"/key-1/logs?include_statuses=success,success",
	])
		assert.equal((await fixture().request(suffix)).status, 400, suffix);
});

test("client profile revisions prevent stale PATCH/DELETE and bind exact raw metadata and workspace", async () => {
	const subject = fixture();
	const detail = (await readResponse(await subject.request(`/${KEY}`))).data;
	assert.equal(detail.key, "sk-…");
	assert.equal(detail.metadata_raw, subject.row().metadata);
	subject.change({ metadata: '{ "token":"hidden","team":"ops" }' });
	for (const method of ["PATCH", "DELETE"]) {
		const response = await subject.request(`/${KEY}`, method, {
			expected_revision: detail.profile_revision,
			...(method === "PATCH" ? { name: "After" } : {}),
		});
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(subject.mutations.length, 0);
	assert.equal(subject.audits(), 0);
	const current = await gatewayKeyRevision(subject.row());
	const updated = await readResponse(
		await subject.request(`/${KEY}`, "PATCH", {
			expected_revision: current,
			name: "After",
			status: "disabled",
		})
	);
	assert.equal(updated.data.status, "disabled");
	assert.equal(updated.data.name, "After");
	assert.equal(updated.data.workspace_id, subject.row().workspace_id);
	const deleted = await readResponse(
		await subject.request(`/${KEY}`, "DELETE", {
			expected_revision: updated.data.profile_revision,
			reason: "Operator revocation",
		})
	);
	assert.equal(deleted.data.status, "revoked");
	assert.match(deleted.message, /tombstone/u);
	assert.equal(subject.audits(), 2);
	const race = fixture({ race: true });
	const revision = await gatewayKeyRevision(race.row());
	assert.equal(
		(
			await race.request(`/${KEY}`, "PATCH", {
				expected_revision: revision,
				name: "After",
			})
		).status,
		409
	);
	assert.equal(race.row().name, "Before");
	assert.equal(race.audits(), 0);
});

test("revision rollout stays optional by default, exact true requires a valid client condition", async () => {
	for (const flag of [undefined, "false", "TRUE", "1"])
		assert.equal(
			(
				await fixture({ requireRevision: flag }).request(`/${KEY}`, "PATCH", {
					name: "After",
				})
			).status,
			200
		);
	for (const method of ["PATCH", "DELETE"]) {
		const subject = fixture({ requireRevision: "true" });
		assert.equal(
			(
				await subject.request(
					`/${KEY}`,
					method,
					method === "PATCH" ? { name: "After" } : undefined
				)
			).status,
			428
		);
		assert.equal(subject.mutations.length, 0);
		assert.equal(
			(
				await subject.request(`/${KEY}`, method, {
					expected_revision: "invalid",
					...(method === "PATCH" ? { name: "After" } : {}),
				})
			).status,
			400
		);
	}
});

test("PATCH whitelist, JSON metadata bounds and unavailable legacy data cannot erase unreviewed contents", async () => {
	for (const body of [
		null,
		[],
		{ status: "mystery" },
		{ name: 1 },
		{ name: "x".repeat(256) },
		{ budget_max: 100 },
		{ workspace_id: "move" },
		{ metadata: [] },
		{ metadata: "[]" },
		{ metadata: {}, metadata_replace: "{}" },
		{ metadata: { a: "x".repeat(65536) } },
		{ metadata: JSON.parse('{"__proto__":{"polluted":true}}') },
	]) {
		const subject = fixture();
		assert.equal(
			(await subject.request(`/${KEY}`, "PATCH", body)).status,
			400,
			JSON.stringify(body).slice(0, 60)
		);
		assert.equal(subject.mutations.length, 0);
	}
	for (const raw of [
		"bad json",
		"[]",
		"1",
		'{"a":"' + "x".repeat(65536) + '"}',
		'{"constructor":{}}',
	]) {
		const subject = fixture({ metadata: raw });
		const detail = (await readResponse(await subject.request(`/${KEY}`))).data;
		assert.equal(detail.metadata_unavailable, true);
		assert.equal(detail.metadata_raw, null);
		assert.equal("metadata" in detail, false);
		assert.equal(
			(await subject.request(`/${KEY}`, "PATCH", { metadata_replace: "{}" }))
				.status,
			400
		);
		assert.equal(
			(await subject.request(`/${KEY}`, "PATCH", { name: "Safe rename" }))
				.status,
			200
		);
		assert.equal(subject.row().metadata, raw);
	}
	const subject = fixture();
	await subject.request(`/${KEY}`, "PATCH", { metadata: { team: "new" } });
	assert.deepEqual(JSON.parse(subject.row().metadata!), {
		token: "hidden",
		team: "new",
	});
});

test("metadata service calls reject non-JSON values, cycles, deep structures and large containers", () => {
	const cycle: Record<string, unknown> = {};
	cycle.cycle = cycle;
	let deep: object = {};
	for (let i = 0; i < 18; i++) deep = { nested: deep };
	for (const value of [
		{ a: Infinity },
		{ a: undefined },
		{ a: 1n },
		{ a: new Date() },
		cycle,
		deep,
		Object.fromEntries(Array.from({ length: 1001 }, (_, i) => [`f${i}`, i])),
	])
		assert.throws(() => keyMetadata(value));
	assert.equal(
		keyMetadataProjection(JSON.stringify(deep)).metadata_unavailable,
		true
	);
});

test("existing and external ownership creation returns authoritative owner and personal workspace with one-time secret", async () => {
	for (const body of [
		{ user_id: USER, name: "Created" },
		{
			external_system: "billing",
			external_user_id: "ext-1",
			email: "new@example.test",
			name: "Created",
		},
	]) {
		const subject = fixture();
		const response = await subject.request("", "POST", body);
		const data = (await readResponse(response)).data;
		assert.equal(response.status, 200);
		assert.match(data.key, /^sk-[A-Za-z0-9]{32}$/u);
		assert.equal(data.id, data.key_id);
		assert.equal(
			data.workspace_id,
			defaultWorkspaceId("personal", data.user_id)
		);
		assert.equal(data.status, "active");
		assert.deepEqual(data.owner, {
			email: subject.user().email,
			external_system: subject.user().external_system,
			external_user_id: subject.user().external_user_id,
		});
		if ("external_system" in body) {
			assert.equal(subject.user().budget_max, 0);
			assert.equal(subject.user().budget_base, 0);
			assert.equal(subject.user().budget_period, "none");
		}
		assert.equal(subject.created(), 1);
		assert.equal(
			(await readResponse(await subject.request(`/${data.id}`))).data.key,
			"sk-…"
		);
	}
	for (const body of [
		{ user_id: USER, external_system: "x" },
		{ user_id: USER, budget_max: 0 },
		{ external_system: "x", external_user_id: "y", email: "invalid" },
		{ user_id: "" },
		{ user_id: USER, metadata: "invalid" },
	])
		assert.equal((await fixture().request("", "POST", body)).status, 400);
});

test("all Key subroutes keep auth, permission, validation and storage failures private", async () => {
	const routes = [
		["", "GET"],
		["", "POST"],
		[`/${KEY}`, "GET"],
		[`/${KEY}`, "PATCH"],
		[`/${KEY}`, "DELETE"],
		[`/${KEY}/logs`, "GET"],
		["/maintenance/scrub-legacy-secrets", "POST"],
	] as const;
	for (const [path, method] of routes) {
		for (const [principal, expected] of [
			[null, 401],
			[
				{ type: "api_key", id: "admin_key:no", keyId: "no", permissions: [] },
				403,
			],
		] as const) {
			const response = await fixture({
				principal: principal as AdminPrincipal | null,
			}).request(path, method, method === "POST" ? {} : undefined);
			assert.equal(response.status, expected, `${path} ${method}`);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
		}
		const outer = protectAdminConfigResponse(
			new Request(`https://admin.example/api/admin/keys${path}`),
			new Response("early origin/storage rejection", { status: 403 })
		);
		assert.equal(outer.headers.get("cache-control"), "private, no-store");
	}
	for (const options of [{ fail: true }, { missingAtomic: true }]) {
		const subject = fixture(options);
		const response = await subject.request(`/${KEY}`, "PATCH", {
			name: "After",
		});
		assert.equal(response.status, 500);
		assert.equal(subject.row().name, "Before");
		assert.equal(subject.audits(), 0);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(
		(await fixture({ fail: true }).request()).headers.get("cache-control"),
		"private, no-store"
	);
});

test("body-limit and unmatched Key subroutes remain private before auth", async () => {
	const app = createAdminApp();
	for (const path of [
		"/admin/keys",
		"/admin/keys/key/logs",
		"/admin/keys/maintenance/scrub-legacy-secrets",
	]) {
		const response = await app.request(path, {
			method: "POST",
			headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
			body: "x",
		});
		assert.equal(response.status, 413);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
	}
	assert.equal(
		(await fixture().request("/unknown/child")).headers.get("cache-control"),
		"private, no-store"
	);
	const storageFailure = await app.request("/admin/keys", {}, {
		DATABASE_DRIVER: "invalid",
	} as unknown as AdminBindings);
	assert.equal(storageFailure.status, 500);
	assert.equal(
		storageFailure.headers.get("cache-control"),
		"private, no-store"
	);
	for (const suffix of ["", "/key/logs", "/maintenance/scrub-legacy-secrets"]) {
		const preflight = await fixture().request(suffix, "OPTIONS");
		assert.equal(preflight.headers.get("cache-control"), "private, no-store");
		const request = new Request(
			`https://admin.example/api/admin/keys${suffix}`,
			{ method: "PATCH", headers: { Origin: "https://attacker.example" } }
		);
		const rejected = rejectInvalidAdminMutationOrigin(request, "console");
		assert.ok(rejected);
		assert.equal(
			protectAdminConfigResponse(request, rejected).headers.get(
				"cache-control"
			),
			"private, no-store"
		);
	}
});

test("service sort/order and maintenance inputs reject invalid explicit values", async () => {
	for (const input of [{ sort: "mystery" }, { order: "UP" }])
		await assert.rejects(
			() =>
				listAdminKeys(
					{} as GatewayRepositories,
					input as Parameters<typeof listAdminKeys>[1]
				),
			/Invalid/u
		);
	for (const body of [
		null,
		[],
		{ limit: 0 },
		{ limit: 1.5 },
		{ limit: 1001 },
		{ unknown: true },
	])
		assert.equal(
			(
				await fixture().request(
					"/maintenance/scrub-legacy-secrets",
					"POST",
					body
				)
			).status,
			400
		);
});

test("outer early auth/Origin/storage responses protect encoded and nested-encoded Key paths", () => {
	for (const path of [
		"/api/admin/%6beys",
		"/api/admin/keys%2Fid",
		"/api/admin/%256beys",
		"/api/admin/%25256beys%252Fid",
		"/%61pi/%61dmin/%6beys",
		"/api/%61dmin/%6Beys",
		"/api/admin/keys/%69d",
		"/api/admin/%6beys%ZZ",
	]) {
		for (const status of [401, 403, 500]) {
			const request = new Request(`https://admin.example${path}`);
			const response = protectAdminConfigResponse(
				request,
				new Response("early rejection", { status })
			);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				`${path}: ${status}`
			);
		}
	}
	const neighbor = protectAdminConfigResponse(
		new Request("https://admin.example/api/admin/keys-backup"),
		new Response("neighbor")
	);
	assert.equal(neighbor.headers.get("cache-control"), null);
});
