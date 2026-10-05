import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import {
	sharedKeyAdminRevision,
	sharedKeyStateExpectation,
	type AdminSharedKeyAuditRow,
	type AdminSharedKeyDelete,
	type AdminSharedKeyUpdate,
	type GatewayRepositories,
	type SharedKeyRow,
} from "@octafuse/core";
import type { AdminBindings, AdminEnv } from "@/lib/admin-env";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { cinaAuthSessionUsername } from "@/lib/cinaauth/principal";
import { adminSharedKeysRoutes } from "@/lib/routes/admin/shared-keys";
import { EXPECTED_CONSOLE_SUBJECT_HEADER } from "./expected-console-subject";
import type {
	AdminSharedKeyDetail,
	AdminSharedKeysOverview,
	SafeAdminSharedKeyRow,
} from "./shared-key-admin-dto";

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}
type MutationData = { id: string; outcome: string; auditId: string | null };
type AuditData = {
	entries: AdminSharedKeyAuditRow[];
	next_cursor: string | null;
	page_size: number;
};

const principal: AdminPrincipal = {
	type: "console",
	id: "console:operator-1",
	username: "operator",
};
const row = (extra: Partial<SharedKeyRow> = {}): SharedKeyRow => ({
	id: "key-1",
	sellerUserId: "seller-1",
	channelType: "openai",
	apiKey: "short-legacy-secret",
	keyFingerprint: "f".repeat(64),
	label: "Ordinary label",
	status: "disabled",
	sellerPriority: 0,
	weight: 1,
	inputPrice: 1.25,
	outputPrice: 2.5,
	cacheReadPrice: null,
	cacheWritePrice: 0.25,
	validatedAt: "2026-09-30T01:02:03.123456Z",
	lastUsedAt: null,
	lastFailureAt: null,
	failureReason: null,
	servedInputTokens: 1,
	servedOutputTokens: 2,
	earnedTotal: 3.5,
	earnedTotalExact: "3.500000",
	createdAt: "2026-09-01T00:00:00.000Z",
	updatedAt: "2026-09-30T00:00:00.000Z",
	...extra,
});
type Options = {
	rows?: SharedKeyRow[];
	total?: number;
	principal?: AdminPrincipal;
	currency?: string | null;
	failCurrency?: boolean;
	outcome?: "applied" | "unchanged" | "conflict" | "not_found";
	writeError?: unknown;
	audit?: AdminSharedKeyAuditRow[];
	missing?: string;
};
function fixture(options: Options = {}) {
	let rows = options.rows ?? [row()];
	const calls: {
		lists: unknown[];
		details: string[];
		mutations: Array<AdminSharedKeyUpdate | AdminSharedKeyDelete>;
		audits: unknown[];
		currency: number;
		users: string[];
		unsafe: number;
	} = {
		lists: [],
		details: [],
		mutations: [],
		audits: [],
		currency: 0,
		users: [],
		unsafe: 0,
	};
	const sharedKeys: Record<string, unknown> = {
		listAdminSharedKeys: async (query: unknown) => {
			calls.lists.push(query);
			return { keys: rows, total: options.total ?? rows.length };
		},
		getAdminSharedKeyById: async (id: string) => {
			calls.details.push(id);
			return rows.find((r) => r.id === id) ?? null;
		},
		updateSharedKeyAdminWithAudit: async (input: AdminSharedKeyUpdate) => {
			calls.mutations.push(input);
			if (options.writeError) throw options.writeError;
			return options.outcome ?? "applied";
		},
		deleteSharedKeyAdminWithAudit: async (input: AdminSharedKeyDelete) => {
			calls.mutations.push(input);
			if (options.writeError) throw options.writeError;
			return options.outcome ?? "applied";
		},
		listSharedKeyAdminAudit: async (id: string, query: unknown) => {
			calls.audits.push({ id, query });
			return options.audit ?? [];
		},
		listAllSharedKeys: async () => {
			calls.unsafe++;
			throw new Error("unbounded legacy list prohibited");
		},
		getSharedKeyById: async () => {
			calls.unsafe++;
			throw new Error("decrypting lazy writer prohibited");
		},
		updateSharedKey: async () => {
			calls.unsafe++;
			throw new Error("unaudited mutation prohibited");
		},
		deleteSharedKey: async () => {
			calls.unsafe++;
			throw new Error("unaudited deletion prohibited");
		},
	};
	if (options.missing) delete sharedKeys[options.missing];
	const repos = {
		sharedKeys,
		users: {
			getById: async (id: string) => {
				calls.users.push(id);
				return {
					id,
					email: `owner-${rows.map((r) => r.apiKey).join("-")}@example.test`,
				};
			},
		},
		systemConfig: {
			getConfig: async () => {
				calls.currency++;
				if (options.failCurrency) throw new Error("currency read failure");
				return options.currency === undefined ? "CNY" : options.currency;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<AdminEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repos);
		c.set("principal", options.principal ?? principal);
		await next();
	});
	app.route("/admin/shared-keys", adminSharedKeysRoutes);
	return {
		calls,
		rows: () => rows,
		replace: (next: SharedKeyRow[]) => {
			rows = next;
		},
		request: (
			path: string,
			method = "GET",
			body?: unknown,
			bindings: AdminBindings = {},
			headers: HeadersInit = {}
		) => {
			const requestHeaders = new Headers(headers);
			if (body !== undefined)
				requestHeaders.set("Content-Type", "application/json");
			return app.request(
				`/admin/shared-keys${path}`,
				{
					method,
					headers: requestHeaders,
					...(body === undefined
						? {}
						: {
								body: typeof body === "string" ? body : JSON.stringify(body),
						  }),
				},
				bindings
			);
		},
	};
}
const revision = (r: SharedKeyRow = row()) =>
	sharedKeyAdminRevision(r.id, sharedKeyStateExpectation(r));
const auditRow = (
	extra: Partial<AdminSharedKeyAuditRow> = {}
): AdminSharedKeyAuditRow => ({
	id: "00000000-0000-4000-8000-000000000001",
	createdAt: "2026-09-30T01:02:03.123456Z",
	keyId: "key-1",
	action: "updated",
	changeMask: 4,
	actorKind: "api_key",
	actorId: "admin_key:legacy-master",
	source: "admin_api",
	reason: "operator reviewed",
	before: { status: "disabled", sellerPriority: 0, weight: 1, validated: true },
	after: { status: "disabled", sellerPriority: 0, weight: 2, validated: true },
	beforeRevision: `sha256:${"a".repeat(64)}`,
	afterRevision: `sha256:${"b".repeat(64)}`,
	...extra,
});

function consolePrincipal(subject: string): AdminPrincipal {
	const username = cinaAuthSessionUsername(subject);
	return { type: "console", id: `console:${username}`, username };
}
function assertNoRepositoryAccess(f: ReturnType<typeof fixture>) {
	assert.deepEqual(f.calls, {
		lists: [],
		details: [],
		mutations: [],
		audits: [],
		currency: 0,
		users: [],
		unsafe: 0,
	});
}

test("trusted 583, 584 and 600-character subjects can read and govern with their exact principal actor", async () => {
	for (const length of [583, 584, 600]) {
		const subject = "x".repeat(length);
		const principal = consolePrincipal(subject);
		const f = fixture({
			principal,
			audit: [auditRow({ actorKind: "console", actorId: principal.id })],
		});
		const headers = {
			[EXPECTED_CONSOLE_SUBJECT_HEADER]: encodeURIComponent(subject),
		};
		for (const path of ["/overview", "/key-1/detail", "/key-1/audit"]) {
			const response = await f.request(path);
			assert.equal(response.status, 200, `${length} ${path}`);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			if (path.endsWith("/audit")) {
				const data = (await json<{ data: AuditData }>(response)).data;
				assert.equal(data.entries[0].actorId, principal.id);
				assert.equal(data.entries[0].actorId.length, length + 17);
			}
		}
		for (const method of ["PATCH", "DELETE"]) {
			const body = {
				expected_revision: await revision(),
				reason: "Reviewed current profile",
				...(method === "PATCH" ? { weight: 2 } : {}),
			};
			const response = await f.request(
				"/key-1",
				method,
				body,
				{ CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: "true" },
				headers
			);
			assert.equal(response.status, 200, `${length} ${method}`);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			const mutation = f.calls.mutations.at(-1)!;
			assert.equal(mutation.audit.actorKind, "console");
			assert.equal(mutation.audit.actorId, principal.id);
			assert.equal(mutation.audit.actorId.length, length + 17);
			assert.equal(mutation.audit.source, "admin_api");
			assert.equal(mutation.audit.reason, body.reason);
		}
		assert.equal(f.calls.mutations.length, 2);
		assert.equal(f.calls.unsafe, 0);
	}
});

test("overlong and control-bearing trusted actors are rejected before any read or mutation repository access", async () => {
	const overlongKeyId = "x".repeat(591);
	const principals: AdminPrincipal[] = [
		consolePrincipal("x".repeat(601)),
		consolePrincipal("subject\ncontrol"),
		consolePrincipal("subject\u202econtrol"),
		{
			type: "api_key",
			id: `admin_key:${overlongKeyId}`,
			keyId: overlongKeyId,
			permissions: ["providers.read", "providers.write"],
		},
	];
	for (const principal of principals)
		for (const [path, method] of [
			["/overview", "GET"],
			["/key-1/detail", "GET"],
			["/key-1/audit", "GET"],
			["/key-1", "PATCH"],
			["/key-1", "DELETE"],
		]) {
			const f = fixture({ principal });
			const response = await f.request(
				path,
				method,
				method === "PATCH" ? { weight: 2 } : undefined
			);
			assert.equal(response.status, 403);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.equal(
				(await json<{ code: string }>(response)).code,
				"shared_key_trusted_actor_required"
			);
			assertNoRepositoryAccess(f);
		}
});

test("600-character Console subjects retain strict header bounds and reject mismatches before repository access", async () => {
	const subject = "x".repeat(600);
	for (const [header, status, code] of [
		[
			encodeURIComponent("x".repeat(601)),
			400,
			"invalid_console_subject_precondition",
		],
		[encodeURIComponent("y".repeat(600)), 403, "console_subject_mismatch"],
		[
			encodeURIComponent("subject\ncontrol"),
			400,
			"invalid_console_subject_precondition",
		],
		[
			encodeURIComponent("subject\u202econtrol"),
			400,
			"invalid_console_subject_precondition",
		],
	] as const)
		for (const method of ["PATCH", "DELETE"]) {
			const f = fixture({ principal: consolePrincipal(subject) });
			const response = await f.request(
				"/key-1",
				method,
				{
					expected_revision: await revision(),
					reason: "Reviewed current profile",
					...(method === "PATCH" ? { weight: 2 } : {}),
				},
				{},
				{ [EXPECTED_CONSOLE_SUBJECT_HEADER]: header }
			);
			assert.equal(response.status, status);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			const payload = await json<{ code: string }>(response);
			assert.equal(payload.code, code);
			assert.ok(!JSON.stringify(payload).includes(subject));
			assertNoRepositoryAccess(f);
		}
});

test("long-subject Console compatibility stays audited and the strict missing-header guard stays 428", async () => {
	const principal = consolePrincipal("x".repeat(600));
	for (const method of ["PATCH", "DELETE"]) {
		const compatible = fixture({ principal });
		assert.equal(
			(
				await compatible.request(
					"/key-1",
					method,
					method === "PATCH" ? { weight: 2 } : undefined
				)
			).status,
			200
		);
		assert.equal(compatible.calls.mutations[0].audit.actorId, principal.id);
		assert.equal(compatible.calls.mutations[0].audit.source, "legacy_admin");
		const strict = fixture({ principal });
		const response = await strict.request(
			"/key-1",
			method,
			{
				expected_revision: await revision(),
				reason: "Reviewed current profile",
				...(method === "PATCH" ? { weight: 2 } : {}),
			},
			{ CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: "true" }
		);
		assert.equal(response.status, 428);
		assert.equal(
			(await json<{ code: string }>(response)).code,
			"console_subject_required"
		);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assertNoRepositoryAccess(strict);
	}
});

test("named API actors keep 600-character capacity without a Console subject or expanded write permission", async () => {
	const keyId = "x".repeat(590);
	const principal: AdminPrincipal = {
		type: "api_key",
		id: `admin_key:${keyId}`,
		keyId,
		permissions: ["providers.read", "providers.write"],
	};
	for (const method of ["PATCH", "DELETE"]) {
		const f = fixture({ principal });
		const body = {
			expected_revision: await revision(),
			reason: "Named operator review",
			...(method === "PATCH" ? { weight: 2 } : {}),
		};
		assert.equal(
			(
				await f.request("/key-1", method, body, {
					CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: "true",
				})
			).status,
			200
		);
		assert.equal(f.calls.mutations[0].audit.actorKind, "api_key");
		assert.equal(f.calls.mutations[0].audit.actorId, principal.id);
		const withHeader = fixture({ principal });
		assert.equal(
			(
				await withHeader.request(
					"/key-1",
					method,
					body,
					{},
					{ [EXPECTED_CONSOLE_SUBJECT_HEADER]: "forged-console" }
				)
			).status,
			400
		);
		assertNoRepositoryAccess(withHeader);
		const reader = fixture({
			principal: { ...principal, permissions: ["providers.read"] },
		});
		assert.equal((await reader.request("/key-1", method, body)).status, 403);
		assertNoRepositoryAccess(reader);
	}
});

test("overview is paginated, constant-masked, explicitly denominated and contains only public fields", async () => {
	const key = row({
		apiKey: "abc",
		label: `before abc ${"f".repeat(64)} enc:v2:aGVsbG8=:c2VjcmV0 after`,
		failureReason: "upstream leaked Bearer sk-sensitive",
	});
	const subject = fixture({ rows: [key], total: 41 });
	const response = await subject.request("/overview?page=2&page_size=20");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	const data = (await json<{ data: AdminSharedKeysOverview }>(response)).data;
	assert.deepEqual(subject.calls.lists, [{ page: 2, pageSize: 20 }]);
	assert.equal(subject.calls.unsafe, 0);
	assert.deepEqual(
		[data.total, data.page, data.page_size, data.hasMore],
		[41, 2, 20, true]
	);
	assert.equal(data.currentBillingCurrency, "CNY");
	assert.equal(data.currentBillingCurrencyReferenceOnly, true);
	const item = data.items[0];
	assert.equal(item.apiKeyMasked, "••••••••");
	assert.equal(item.quoteCurrency, null);
	assert.equal(item.quoteCurrencyAvailability, "legacy_unrecorded");
	assert.equal(item.earningsCurrency, "USD");
	assert.equal(item.quoteUnit, "per_million_tokens");
	assert.equal(item.statisticsBasis, "legacy_cached_projection");
	assert.equal(item.failureCode, "unknown_failure");
	assert.equal(item.cacheReadPrice, null);
	for (const field of [
		"apiKey",
		"keyFingerprint",
		"failureReason",
		"earnedTotalExact",
	])
		assert.ok(!Object.hasOwn(item, field), field);
	for (const material of [
		"abc",
		"f".repeat(64),
		"enc:v2:",
		"sk-sensitive",
		"Bearer",
	])
		assert.ok(!JSON.stringify(data).includes(material), material);
	assert.deepEqual(data.capabilities, {
		can_write: true,
		user_detail: true,
		request_logs: true,
		can_review_earnings: true,
	});
});

test("old list stays an array capped at 100 and announces truncation", async () => {
	const subject = fixture({ total: 101 });
	const response = await subject.request("");
	assert.equal(response.status, 200);
	const payload = await json<{
		data: SafeAdminSharedKeyRow[];
		total: number;
		truncated: boolean;
	}>(response);
	assert.ok(Array.isArray(payload.data));
	assert.equal(payload.total, 101);
	assert.equal(payload.truncated, true);
	assert.deepEqual(subject.calls.lists, [{ page: 1, pageSize: 100 }]);
	assert.equal(subject.calls.unsafe, 0);
});

test("unknown/duplicate list and audit queries, malformed body and bounds fail before repository reads", async () => {
	for (const path of [
		"/overview?status=",
		"/overview?page=1&page=2",
		"/overview?order=asc",
		"/overview?seller_user_id=bad%2Fowner",
		"/overview?search=%20x",
		"?page=2",
		"/key-1/detail?reveal=true",
		"/key-1/audit?limit=20",
		"/key-1/audit?cursor=bad",
	]) {
		const f = fixture();
		const response = await f.request(path);
		assert.equal(response.status, 400, path);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(
			[
				f.calls.lists.length,
				f.calls.details.length,
				f.calls.audits.length,
				f.calls.currency,
			],
			[0, 0, 0, 0]
		);
	}
	for (const body of [
		'{"weight":2,"weight":3}',
		'{"weight":"2"}',
		'{"weight":2,"actorId":"forged"}',
		'{"weight":2,"reason":""}',
		'{"sellerPriority":2147483648}',
	]) {
		const f = fixture();
		assert.equal((await f.request("/key-1", "PATCH", body)).status, 400);
		assert.equal(f.calls.details.length, 0);
		assert.equal(f.calls.mutations.length, 0);
	}
});

test("named Bearer read/write permissions retain exact link capabilities and do not become Console-only", async () => {
	for (const [permissions, caps] of [
		[
			["providers.read"],
			{
				can_write: false,
				user_detail: false,
				request_logs: false,
				can_review_earnings: false,
			},
		],
		[
			["providers.write", "users.write", "logs.read"],
			{
				can_write: true,
				user_detail: true,
				request_logs: true,
				can_review_earnings: true,
			},
		],
	] as const) {
		const f = fixture({
			principal: {
				type: "api_key",
				id: "admin_key:named",
				keyId: "named",
				permissions: [...permissions],
			},
		});
		const response = await f.request("/overview");
		assert.equal(response.status, 200);
		assert.deepEqual(
			(await json<{ data: AdminSharedKeysOverview }>(response)).data
				.capabilities,
			caps
		);
		const write = await f.request("/key-1", "PATCH", { weight: 2 });
		assert.equal(write.status, caps.can_write ? 200 : 403);
		if (caps.can_write)
			assert.deepEqual(
				{
					kind: f.calls.mutations[0].audit.actorKind,
					id: f.calls.mutations[0].audit.actorId,
				},
				{ kind: "api_key", id: "admin_key:named" }
			);
	}
});

test("detail is an explicit raw-storage read, same safe DTO and missing IDs are 404", async () => {
	const f = fixture({
		rows: [row({ apiKey: "enc:v2:bad:encrypted", status: "invalid" })],
	});
	const response = await f.request("/key-1/detail");
	assert.equal(response.status, 200);
	const data = (await json<{ data: AdminSharedKeyDetail }>(response)).data;
	assert.equal(data.apiKeyMasked, "••••••••");
	assert.equal(data.profile_revision, await revision(f.rows()[0]));
	assert.equal(f.calls.unsafe, 0);
	assert.deepEqual(f.calls.details, ["key-1"]);
	assert.equal((await f.request("/missing/detail")).status, 404);
});

test("currency missing and invalid remain explicit; read failure is an error without invented USD", async () => {
	for (const [currency, source] of [
		[null, "missing"],
		["usd", "invalid"],
		[" EUR ", "invalid"],
	] as const) {
		const response = await fixture({ currency }).request("/overview");
		assert.equal(response.status, 200);
		const data = (await json<{ data: AdminSharedKeysOverview }>(response)).data;
		assert.equal(data.currentBillingCurrency, null);
		assert.equal(data.currentBillingCurrencySource, source);
		assert.equal(data.items[0].quoteCurrency, null);
	}
	const response = await fixture({ failCurrency: true }).request("/overview");
	assert.equal(response.status, 500);
	assert.ok(!(await response.text()).includes("USD"));
});

test("strict writes require human reason and exact revisions; stale CAS never invokes mutation", async () => {
	const f = fixture();
	assert.equal(
		(
			await f.request(
				"/key-1",
				"PATCH",
				{ weight: 2 },
				{ CINATOKEN_ADMIN_SHARED_KEYS_REQUIRE_REVISION: "true" }
			)
		).status,
		428
	);
	assert.equal(
		(
			await f.request("/key-1", "PATCH", {
				expected_revision: await revision(),
				weight: 2,
			})
		).status,
		400
	);
	assert.equal(
		(
			await f.request("/key-1", "PATCH", {
				expected_revision: `sha256:${"0".repeat(64)}`,
				reason: "review",
				weight: 2,
			})
		).status,
		409
	);
	assert.equal(f.calls.mutations.length, 0);
	const response = await f.request("/key-1", "PATCH", {
		expected_revision: await revision(),
		reason: "operator approved disable",
		status: "disabled",
		weight: 2,
	});
	assert.equal(response.status, 200);
	const data = (await json<{ data: MutationData }>(response)).data;
	assert.equal(data.outcome, "applied");
	assert.match(data.auditId!, /^[0-9a-f-]{36}$/u);
	const mutation = f.calls.mutations[0];
	assert.equal(mutation.audit.source, "admin_api");
	assert.equal(mutation.audit.reason, "operator approved disable");
	assert.equal(mutation.audit.actorId, principal.id);
	assert.deepEqual(mutation.expected, sharedKeyStateExpectation(row()));
	assert.equal(f.calls.unsafe, 0);
});

test("compatibility writes still use complete server CAS and explicit legacy auditing", async () => {
	const f = fixture();
	assert.equal((await f.request("/key-1", "PATCH", { weight: 2 })).status, 200);
	assert.equal(f.calls.mutations[0].audit.source, "legacy_admin");
	assert.match(
		f.calls.mutations[0].audit.reason,
		/^legacy-admin-shared-key-update:/u
	);
	assert.deepEqual(
		f.calls.mutations[0].expected,
		sharedKeyStateExpectation(row())
	);
	assert.equal((await f.request("/key-1", "DELETE")).status, 200);
	assert.equal(f.calls.mutations[1].audit.source, "legacy_admin");
	assert.equal(f.calls.unsafe, 0);
});

test("restoration is disabled to paused only and activation keeps the legacy 409/404 meaning", async () => {
	for (const initial of [
		"active",
		"paused",
		"invalid",
		"validating",
	] as const) {
		const f = fixture({ rows: [row({ status: initial })] });
		assert.equal(
			(await f.request("/key-1", "PATCH", { status: "paused" })).status,
			409
		);
		assert.equal(f.calls.mutations.length, 0);
	}
	for (const exists of [true, false]) {
		const f = fixture({ rows: exists ? [row()] : [] });
		assert.equal(
			(await f.request("/key-1", "PATCH", { status: "active" })).status,
			exists ? 409 : 404
		);
		assert.equal(f.calls.mutations.length, 0);
	}
	const f = fixture();
	assert.equal(
		(await f.request("/key-1", "PATCH", { status: "paused" })).status,
		200
	);
	assert.deepEqual((f.calls.mutations[0] as AdminSharedKeyUpdate).patch, {
		status: "paused",
	});
});

test("atomic race conflicts, not-found and no-op outcomes are distinct without automatic replay", async () => {
	for (const outcome of ["conflict", "not_found", "unchanged"] as const) {
		const f = fixture({ outcome });
		const response = await f.request("/key-1", "PATCH", { weight: 2 });
		assert.equal(
			response.status,
			outcome === "conflict" ? 409 : outcome === "not_found" ? 404 : 200
		);
		if (outcome === "unchanged")
			assert.deepEqual((await json<{ data: MutationData }>(response)).data, {
				id: "key-1",
				outcome: "unchanged",
				auditId: null,
			});
		assert.equal(f.calls.mutations.length, 1);
		assert.equal(f.calls.unsafe, 0);
	}
});

test("missing raw/paged/atomic/audit methods fail 503 with no fallback; audit failures never report success", async () => {
	for (const [missing, path, method, body] of [
		["listAdminSharedKeys", "/overview", "GET", undefined],
		["getAdminSharedKeyById", "/key-1/detail", "GET", undefined],
		["updateSharedKeyAdminWithAudit", "/key-1", "PATCH", { weight: 2 }],
		["deleteSharedKeyAdminWithAudit", "/key-1", "DELETE", undefined],
		["listSharedKeyAdminAudit", "/key-1/audit", "GET", undefined],
	] as const) {
		const f = fixture({ missing });
		const response = await f.request(path, method, body);
		assert.equal(response.status, 503, missing);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(f.calls.unsafe, 0);
	}
	const f = fixture({
		writeError: new Error("secret raw SQL must not leave response"),
	});
	const response = await f.request("/key-1", "PATCH", { weight: 2 });
	assert.equal(response.status, 500);
	assert.ok(!(await response.text()).includes("raw SQL"));
});

test("database credited-history parent guards become safe 409 on audited DELETE", async () => {
	for (const error of [
		new Error("D1_ERROR: credited_shared_key_earning_history_immutable"),
		{
			code: "23503",
			constraint_name: "shared_key_earnings_shared_key_id_fkey",
		},
		{
			code: "ER_ROW_IS_REFERENCED_2",
			errno: 1451,
			sqlMessage: "CONSTRAINT `fk_shared_key_earnings_key` FOREIGN KEY",
		},
	]) {
		const f = fixture({ writeError: error });
		const response = await f.request("/key-1", "DELETE");
		assert.equal(response.status, 409);
		assert.deepEqual(await response.json(), {
			success: false,
			code: "shared_key_earning_history_immutable",
			message: "Shared key has credited earnings and cannot be deleted",
		});
		assert.equal(f.calls.unsafe, 0);
	}
});

test("audit survives deletion, is key-bound, safe and preserves microsecond cursor boundaries", async () => {
	const entry = {
		...auditRow(),
		rawSecret: "sk-never-visible",
		before: { ...auditRow().before, keyFingerprint: "never-visible" },
	} as AdminSharedKeyAuditRow;
	const f = fixture({ rows: [], audit: [entry] });
	const response = await f.request("/key-1/audit?page_size=1");
	assert.equal(response.status, 200);
	const data = (await json<{ data: AuditData }>(response)).data;
	assert.equal(data.entries[0].createdAt, entry.createdAt);
	assert.equal(data.entries[0].actorId, "admin_key:legacy-master");
	assert.ok(!JSON.stringify(data).includes("never-visible"));
	assert.ok(data.next_cursor);
	assert.equal(f.calls.details.length, 0);
	assert.equal(f.calls.currency, 0);
	const crossKey = await f.request(`/other/audit?cursor=${data.next_cursor}`);
	assert.equal(crossKey.status, 400);
	assert.equal(f.calls.audits.length, 1);
	const next = fixture({
		rows: [],
		audit: [auditRow({ createdAt: "2026-09-30T01:02:03.123455Z" })],
	});
	assert.equal(
		(await next.request(`/key-1/audit?page_size=1&cursor=${data.next_cursor}`))
			.status,
		200
	);
	const same = await f.request(
		`/key-1/audit?page_size=1&cursor=${data.next_cursor}`
	);
	assert.equal(same.status, 500);
});

test("malformed or cross-key repository DTOs fail closed without revealing stored material", async () => {
	for (const options of [
		{ rows: [row({ earnedTotal: NaN })] },
		{ rows: [row()], total: -1 },
		{ rows: [row(), row()] },
	])
		assert.equal((await fixture(options).request("/overview")).status, 500);
	for (const entry of [
		auditRow({ keyId: "other" }),
		auditRow({ changeMask: 8 }),
		auditRow({
			after: {
				status: "disabled",
				weight: 2,
				sellerPriority: 0,
				validated: false,
			},
		}),
	])
		assert.equal(
			(await fixture({ audit: [entry] }).request("/key-1/audit")).status,
			500
		);
	assert.equal(
		(
			await fixture({
				audit: [
					auditRow({
						action: "deleted",
						changeMask: 8,
						after: null,
						afterRevision: null,
					}),
				],
			}).request("/key-1/audit")
		).status,
		200
	);
});

test("usage/encryption timestamps do not change the profile precondition; owner/price/label changes do", async () => {
	const initial = row();
	const original = await revision(initial);
	assert.equal(
		await revision({
			...initial,
			updatedAt: "2026-09-30T03:00:00.000Z",
			earnedTotal: 100,
			servedInputTokens: 999,
			apiKey: "enc:v2:rotated:cipher",
		}),
		original
	);
	for (const changed of [
		{ sellerUserId: "seller-other" },
		{ label: "changed" },
		{ inputPrice: 9 },
		{ keyFingerprint: "d".repeat(64) },
		{ validatedAt: "2026-09-30T01:02:03.123457Z" },
	])
		assert.notEqual(await revision({ ...initial, ...changed }), original);
});
