import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type { GatewayRepositories } from "@octafuse/core";
import { createD1SystemConfigRepository } from "../../../../core/src/db/d1/system-config.impl";
import type { D1DatabaseClient } from "../../../../core/src/storage/database-client";
import { createAdminApp } from "@/lib/admin-app";
import type { AdminPrincipal, AdminPermission } from "@/lib/admin-principal";
import { getAdminAuthorizationDecision } from "@/lib/admin-permissions";
import { protectAdminConfigResponse } from "@/lib/admin-config-cache";
import {
	TOOL_CONFIG_FAMILIES,
	TOOL_CONFIG_PROVIDERS,
	type ToolConfigFamily,
	type ToolConfigProvider,
	type ToolConfigOverview,
	type ToolConfigSaveResult,
	type ToolConfigRevealResult,
	type ToolConfigDetail,
	type ToolConfigAuditResult,
} from "./tool-config-contract";
import {
	toolConfigVersion,
	TOOL_CONFIG_KEYS,
	TOOL_CONFIG_OVERVIEW_KEYS,
	toolConfigCursor,
} from "./tool-config-input";

type SQLValue = string | number | null;
type SQLite = {
	exec(sql: string): void;
	close(): void;
	prepare(sql: string): {
		run(...values: SQLValue[]): { changes: number | bigint };
		get(...values: SQLValue[]): Record<string, unknown> | undefined;
		all(...values: SQLValue[]): Record<string, unknown>[];
	};
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
	DatabaseSync: new (path: string) => SQLite;
};
const root = resolve(
	process.cwd(),
	process.cwd().replaceAll("\\", "/").endsWith("/packages/admin")
		? "../.."
		: "."
);
const subject = "tools-operator";
const consolePrincipal: AdminPrincipal = {
	type: "console",
	id: ("console:cinaauth:" + subject) as `console:${string}`,
	username: "cinaauth:" + subject,
};
const bearer = (permissions: AdminPermission[]): AdminPrincipal => ({
	type: "api_key",
	id: "admin_key:tools-reader",
	keyId: "tools-reader",
	permissions,
});
const secret = "tvly-private-credential-123456";
class Statement {
	constructor(
		private db: SQLite,
		private calls: string[],
		private sql: string,
		private values: SQLValue[] = []
	) {}
	bind(...values: SQLValue[]) {
		return new Statement(
			this.db,
			this.calls,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}
	run() {
		this.calls.push(this.sql);
		return {
			success: true,
			results: [],
			meta: {
				changes: Number(this.db.prepare(this.sql).run(...this.values).changes),
			},
		} as unknown as D1Result;
	}
	first<T>() {
		this.calls.push(this.sql);
		return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}
	all<T>() {
		this.calls.push(this.sql);
		return {
			success: true,
			results: this.db.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
	execute() {
		return /^\s*SELECT/iu.test(this.sql) ? this.all() : this.run();
	}
}
function fixture(
	options: {
		principal?: AdminPrincipal | null;
		values?: Record<string, string>;
		strict?: string;
		missingRepo?: boolean;
	} = {}
) {
	const db = new DatabaseSync(":memory:");
	db.exec(
		"CREATE TABLE system_config (key TEXT PRIMARY KEY, value TEXT, description TEXT, updated_at TEXT, revision TEXT NOT NULL DEFAULT 'legacy'); CREATE TABLE config_change_audit(id TEXT PRIMARY KEY, config_key TEXT, channel TEXT, action TEXT, actor_kind TEXT, actor_id TEXT, created_at TEXT);"
	);
	db.exec(
		readFileSync(
			resolve(
				root,
				"packages/core/migrations-d1/0076_tools_config_group_audit.sql"
			),
			"utf8"
		)
	);
	for (const [key, value] of Object.entries(options.values ?? {}))
		db.prepare("INSERT INTO system_config(key,value) VALUES (?,?)").run(
			key,
			value
		);
	const calls: string[] = [];
	const raw = {
		prepare: (sql: string) => new Statement(db, calls, sql),
		async batch(statements: Statement[]) {
			db.exec("BEGIN");
			try {
				const results = statements.map((statement) => statement.execute());
				db.exec("COMMIT");
				return results;
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	const store = createD1SystemConfigRepository({
		driver: "d1",
		raw,
		drizzle: {},
	} as D1DatabaseClient);
	if (options.missingRepo)
		(store as Partial<typeof store>).applyConfigGroupIfRevisions = undefined;
	const repos = { systemConfig: store } as unknown as GatewayRepositories;
	const principal =
		options.principal === undefined ? consolePrincipal : options.principal;
	const app = createAdminApp();
	async function request(path: string, init?: RequestInit) {
		const response = await app.request("/admin/config" + path, init, {
			STORAGE_CONTEXT: { repositories: repos },
			ADMIN_PRINCIPAL: principal ?? undefined,
			CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION: options.strict,
		} as never);
		return protectAdminConfigResponse(
			new Request("https://test.example/api/admin/config" + path),
			response
		) as Omit<Response, "json"> & {
			json(): Promise<{
				success: boolean;
				code: string;
				data: ToolConfigOverview &
					ToolConfigSaveResult &
					ToolConfigRevealResult &
					ToolConfigDetail &
					ToolConfigAuditResult;
			}>;
		};
	}
	const vector = (family: ToolConfigFamily) =>
		TOOL_CONFIG_KEYS[family].map((key) => ({
			key,
			revision: (db
				.prepare("SELECT revision FROM system_config WHERE key=?")
				.get(key)?.revision ?? null) as string | null,
		}));
	return {
		db,
		calls,
		request,
		store,
		version: (family: ToolConfigFamily) =>
			toolConfigVersion(family, vector(family)),
		rows: () => db.prepare("SELECT * FROM system_config ORDER BY key").all(),
		audits: () =>
			db.prepare("SELECT * FROM config_group_audit ORDER BY id").all(),
	};
}
const endpoint = (
	family: ToolConfigFamily,
	provider: ToolConfigProvider,
	action: string
) => "/tools/" + family + "/providers/" + provider + "/" + action;
function post(
	body: unknown,
	expectedSubject: string | null = subject
): RequestInit {
	return {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			...(expectedSubject === null
				? {}
				: {
						"X-CinaToken-Expected-Console-Subject":
							encodeURIComponent(expectedSubject),
				  }),
		},
		body: JSON.stringify(body),
	};
}
function save(
	f: ReturnType<typeof fixture>,
	family: ToolConfigFamily,
	operation = "save_activate",
	fieldValue = secret
) {
	return {
		operation,
		expected_version: f.version(family),
		reason: "Verify configuration " + fieldValue,
		prices: { metered: 0.1, standard: 0.2, charged: 0.3 },
		credentials:
			family === "ai-detection"
				? {
						secretId: { op: "set", value: "AKID-private-123456" },
						secretKey: { op: "set", value: fieldValue },
				  }
				: { apiKey: { op: "set", value: fieldValue } },
		accept_loss_pricing: false,
	};
}

test("Tools exact method authorization separates read, write and audited reveal", () => {
	for (const [method, path, permission] of [
		["GET", "/overview", "config.read"],
		["HEAD", "/web-search/audit", "config.read"],
		["GET", "/web-fetch/providers/jina/detail", "config.read"],
		["POST", "/ai-detection/providers/tencent_tms/save", "config.write"],
		["POST", "/web-search/providers/tavily/reveal", "config.secrets.read"],
	] as const)
		assert.deepEqual(
			getAdminAuthorizationDecision(method, "/admin/config/tools" + path),
			{
				kind: "permission",
				permission,
			}
		);
	for (const path of [
		"/web-search/providers/tavily/reveal/extra",
		"/overview-extra",
		"/web-search/providers/tavily/activate",
		"/web_search/audit",
		"/web-search/providers/tavily/reveal%2fextra",
	])
		assert.deepEqual(
			getAdminAuthorizationDecision("POST", "/admin/config/tools" + path),
			{
				kind: "deny",
			}
		);
	assert.deepEqual(
		getAdminAuthorizationDecision(
			"GET",
			"/admin/config/tools/web-search/providers/tavily/reveal"
		),
		{ kind: "deny" }
	);
});
test("fixed overview reads one 15-key snapshot, retains missing USD and projects four families/ten providers without raw secrets", async () => {
	const f = fixture({
		values: {
			WEB_SEARCH_PROVIDER: "tavily",
			WEB_SEARCH_API_KEY: secret,
			WEB_SEARCH_COST: "0.7",
			PRIVATE_UNKNOWN_KEY: secret,
		},
	});
	try {
		const response = await f.request("/tools/overview");
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		const body = await response.json();
		assert.equal(body.data.families.length, 4);
		assert.equal(
			body.data.families.flatMap(
				(row: { providers: unknown[] }) => row.providers
			).length,
			10
		);
		assert.deepEqual(body.data.billingCurrency, {
			value: "USD",
			source: "missing",
		});
		assert.equal(body.data.families[0].effectiveProvider, "tavily");
		assert.equal(body.data.families[0].configurationReady, true);
		assert.equal(f.calls.length, 1);
		assert.match(f.calls[0], /WHERE key IN/u);
		assert.equal(JSON.stringify(body).includes(secret), false);
		assert.equal(JSON.stringify(body).includes("PRIVATE_UNKNOWN_KEY"), false);
	} finally {
		f.db.close();
	}
});
for (const family of TOOL_CONFIG_FAMILIES)
	for (const provider of TOOL_CONFIG_PROVIDERS[family])
		test(
			"atomic save_activate and safe detail support " + family + "/" + provider,
			async () => {
				const f = fixture();
				try {
					const response = await f.request(
						endpoint(family, provider, "save"),
						post(save(f, family))
					);
					assert.equal(response.status, 200, await response.clone().text());
					const body = await response.json();
					assert.equal(body.data.outcome, "applied");
					assert.match(body.data.auditId, /^[a-f0-9-]{36}$/u);
					assert.equal(
						body.data.detail.familyState.effectiveProvider,
						provider
					);
					assert.equal(body.data.detail.familyState.configurationReady, true);
					assert.equal(JSON.stringify(body).includes(secret), false);
					assert.equal(f.rows().length, 2);
					assert.equal(f.audits().length, 1);
					assert.equal(f.audits()[0].actor_id, consolePrincipal.id);
					assert.equal(f.audits()[0].reason, "Verify configuration [redacted]");
					assert.equal(
						f.audits()[0].revision_before_json?.toString().includes(secret),
						false
					);
					const detail = await f.request(endpoint(family, provider, "detail"));
					assert.equal(detail.status, 200);
					assert.equal(
						JSON.stringify(await detail.json()).includes(secret),
						false
					);
				} finally {
					f.db.close();
				}
			}
		);
test("normal save cannot silently first-activate default provider but save_activate atomically can", async () => {
	const f = fixture();
	try {
		const failed = await f.request(
			endpoint("web-search", "bocha", "save"),
			post(save(f, "web-search", "save"))
		);
		assert.equal(failed.status, 409);
		assert.equal((await failed.json()).code, "tools_activation_required");
		assert.deepEqual(f.rows(), []);
		assert.deepEqual(f.audits(), []);
		assert.equal(
			(
				await f.request(
					endpoint("web-search", "bocha", "save"),
					post(save(f, "web-search"))
				)
			).status,
			200
		);
	} finally {
		f.db.close();
	}
});
test("legacy migration preserves effective provider/readiness, seeds its complete price/key and leaves legacy/currency rows untouched", async () => {
	const values = {
		WEB_SEARCH_PROVIDER: "tavily",
		WEB_SEARCH_API_KEY: secret,
		WEB_SEARCH_COST: "0.5",
		WEB_SEARCH_ACTIVE: "bocha",
	};
	const f = fixture({ values });
	try {
		const response = await f.request(
			endpoint("web-search", "cleversee", "save"),
			post(save(f, "web-search", "save", "other-secret"))
		);
		assert.equal(response.status, 200, await response.clone().text());
		const body = await response.json();
		assert.equal(body.data.detail.familyState.effectiveProvider, "tavily");
		assert.equal(body.data.detail.familyState.configurationReady, true);
		const catalog = JSON.parse(
			String(
				f.db
					.prepare("SELECT value FROM system_config WHERE key=?")
					.get("WEB_SEARCH_CATALOG")?.value
			)
		);
		assert.equal(catalog.tavily.apiKey, secret);
		assert.deepEqual(
			[catalog.tavily.metered, catalog.tavily.standard, catalog.tavily.charged],
			[0.5, 0.5, 0.5]
		);
		assert.equal(catalog.cleversee.apiKey, "other-secret");
		for (const [key, value] of Object.entries(values).filter(
			([key]) => key !== "WEB_SEARCH_ACTIVE"
		))
			assert.equal(
				f.db.prepare("SELECT value FROM system_config WHERE key=?").get(key)
					?.value,
				value
			);
		assert.equal(
			f.db
				.prepare("SELECT value FROM system_config WHERE key=?")
				.get("BILLING_CURRENCY"),
			undefined
		);
	} finally {
		f.db.close();
	}
});
test("keep preserves all other providers/future AI union fields and unchanged saves emit no new audit/revision", async () => {
	const f = fixture({
		values: {
			AI_DETECTION_ACTIVE: "tencent_tms",
			AI_DETECTION_CATALOG: JSON.stringify({
				tencent_tms: {
					secretId: "owner-id",
					secretKey: secret,
					apiKey: "future-api",
					email: "future-email",
					region: "ap-shanghai",
					bizType: "safe-biz",
					billingUnitChars: "2000",
					cost: 0.3,
					metered: 0.1,
					standard: 0.2,
					charged: 0.3,
				},
			}),
		},
	});
	try {
		const before = f.rows();
		const version = f.version("ai-detection");
		const body = {
			...save(f, "ai-detection", "save"),
			credentials: { secretId: { op: "keep" }, secretKey: { op: "keep" } },
		};
		const response = await f.request(
			endpoint("ai-detection", "tencent_tms", "save"),
			post(body)
		);
		assert.equal(response.status, 200);
		const result = await response.json();
		assert.equal(result.data.outcome, "unchanged");
		assert.equal(result.data.auditId, null);
		assert.equal(result.data.detail.version, version);
		assert.deepEqual(f.rows(), before);
		assert.deepEqual(f.audits(), []);
	} finally {
		f.db.close();
	}
});
test("malformed/unknown/duplicate/alias-collision catalogs remain read-only and never get replaced", async () => {
	for (const raw of [
		"{",
		'{"tavily":{"apiKey":"hidden","future":true}}',
		'{"unknown":{"apiKey":"hidden"}}',
		'{"tavily":{"apiKey":"a"},"TAVILY":{"apiKey":"b"}}',
		'{"tavily":{"apiKey":"a","apiKey":"b"}}',
	]) {
		const f = fixture({ values: { WEB_SEARCH_CATALOG: raw } });
		try {
			const overview = await f.request("/tools/overview");
			assert.equal(overview.status, 200);
			const state = (await overview.json()).data.families[0];
			assert.equal(state.editable, false);
			const response = await f.request(
				endpoint("web-search", "tavily", "save"),
				post(save(f, "web-search"))
			);
			assert.equal(response.status, 409);
			assert.equal(f.rows()[0].value, raw);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});
test("invalid/unsupported currency blocks writes while missing USD stays version-tracked", async () => {
	for (const value of ["bad-currency", "EUR"]) {
		const f = fixture({ values: { BILLING_CURRENCY: value } });
		try {
			const response = await f.request("/tools/overview");
			const body = await response.json();
			assert.equal(body.data.billingCurrency.value, null);
			assert.equal(
				body.data.families.every((row: { editable: boolean }) => !row.editable),
				true
			);
			assert.equal(
				(
					await f.request(
						endpoint("web-fetch", "jina", "save"),
						post(save(f, "web-fetch"))
					)
				).status,
				409
			);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});
test("currency and any legacy dependency revision drift reject the complete vector without writes", async () => {
	for (const key of [
		"BILLING_CURRENCY",
		"WEB_SEARCH_COST",
		"WEB_SEARCH_PROVIDER",
		"WEB_SEARCH_API_KEY",
		"WEB_SEARCH_ACTIVE",
		"WEB_SEARCH_CATALOG",
	]) {
		const f = fixture();
		try {
			const body = save(f, "web-search");
			f.db
				.prepare("INSERT INTO system_config(key,value) VALUES (?,?)")
				.run(key, key === "BILLING_CURRENCY" ? "USD" : "");
			const before = f.rows();
			const response = await f.request(
				endpoint("web-search", "bocha", "save"),
				post(body)
			);
			assert.equal(response.status, 409);
			assert.equal((await response.json()).code, "tools_version_conflict");
			assert.deepEqual(f.rows(), before);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});
test("explicit reveal needs secrets+read but not write, audits exact field/vector and returns only the requested secret", async () => {
	const f = fixture({
		principal: bearer(["config.read", "config.secrets.read"]),
		values: {
			AI_DETECTION_CATALOG: JSON.stringify({
				tencent_tms: {
					secretId: "owner-id",
					secretKey: secret,
					email: "private-email",
					region: secret,
				},
			}),
		},
	});
	try {
		const response = await f.request(
			endpoint("ai-detection", "tencent_tms", "reveal"),
			post(
				{
					field: "secretKey",
					expected_version: f.version("ai-detection"),
					reason: "Inspect " + secret,
				},
				null
			)
		);
		assert.equal(response.status, 200, await response.clone().text());
		const body = await response.json();
		assert.equal(body.data.value, secret);
		assert.equal(body.data.expiresInSeconds, 60);
		assert.equal(f.audits().length, 1);
		assert.equal(f.audits()[0].reason, "Inspect [redacted]");
		const detail = await f.request(
			endpoint("ai-detection", "tencent_tms", "detail")
		);
		const result = await detail.json();
		assert.ok(result.data.settings);
		assert.equal(result.data.settings.region.value, null);
		assert.equal(result.data.settings.region.availability, "redacted");
		assert.equal(JSON.stringify(result).includes(secret), false);
	} finally {
		f.db.close();
	}
});
test("read-only/secrets-only/anonymous and Console subject mismatch fail before any repository read", async () => {
	for (const principal of [
		bearer(["config.read"]),
		bearer(["config.secrets.read"]),
		null,
	]) {
		const f = fixture({ principal });
		try {
			const response = await f.request(
				endpoint("web-search", "tavily", "reveal"),
				post(
					{
						field: "apiKey",
						expected_version: f.version("web-search"),
						reason: "Inspect",
					},
					null
				)
			);
			assert.equal(response.status, principal ? 403 : 401);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			assert.deepEqual(f.calls, []);
		} finally {
			f.db.close();
		}
	}
	for (const expected of [null, "another-subject"]) {
		const f = fixture();
		try {
			const response = await f.request(
				endpoint("web-search", "bocha", "save"),
				post(save(f, "web-search"), expected)
			);
			assert.equal(response.status, expected === null ? 428 : 403);
			assert.deepEqual(f.calls, []);
		} finally {
			f.db.close();
		}
	}
	const f = fixture({ principal: bearer(["*"]) });
	try {
		assert.equal(
			(
				await f.request(
					endpoint("web-search", "bocha", "save"),
					post(save(f, "web-search"))
				)
			).status,
			400
		);
		assert.deepEqual(f.calls, []);
	} finally {
		f.db.close();
	}
});
test("request validation rejects unknown/duplicate/oversize/controls/prices and cross-family versions before DB", async () => {
	const f = fixture();
	try {
		for (const body of [
			{ ...save(f, "web-search"), actorId: "forged" },
			{ ...save(f, "web-search"), expected_version: f.version("web-fetch") },
			{ ...save(f, "web-search"), reason: "bad\nreason" },
			{
				...save(f, "web-search"),
				prices: { metered: 1e308, standard: 1, charged: 1 },
			},
			{
				...save(f, "web-search"),
				prices: { metered: 1e-10, standard: 1, charged: 1 },
			},
			{
				...save(f, "web-search"),
				credentials: { apiKey: { op: "set", value: "a".repeat(4097) } },
			},
		]) {
			assert.equal(
				(await f.request(endpoint("web-search", "bocha", "save"), post(body)))
					.status,
				400
			);
			assert.deepEqual(f.calls, []);
		}
		const dup = post(save(f, "web-search"));
		dup.body = String(dup.body).replace(
			'"operation":"save_activate"',
			'"operation":"save_activate","operation":"save"'
		);
		assert.equal(
			(await f.request(endpoint("web-search", "bocha", "save"), dup)).status,
			400
		);
		assert.deepEqual(f.calls, []);
		for (const path of [
			"/tools/overview?x=1",
			"/tools/web-search/audit?limit=1&limit=2",
			"/tools/web-search/audit?limit=101",
			"/tools/web-search/providers/jina/detail",
		])
			assert.equal((await f.request(path)).status, 400);
		assert.deepEqual(f.calls, []);
	} finally {
		f.db.close();
	}
});
test("loss-pricing change requires explicit acknowledgment and never affects no-op saves", async () => {
	const f = fixture();
	try {
		const body = {
			...save(f, "web-search"),
			prices: { metered: 2, standard: 3, charged: 1 },
		};
		const failed = await f.request(
			endpoint("web-search", "bocha", "save"),
			post(body)
		);
		assert.equal(failed.status, 409);
		assert.equal(
			(await failed.json()).code,
			"tools_loss_pricing_confirmation_required"
		);
		assert.deepEqual(f.rows(), []);
		assert.deepEqual(f.audits(), []);
		assert.equal(
			(
				await f.request(
					endpoint("web-search", "bocha", "save"),
					post({ ...body, accept_loss_pricing: true })
				)
			).status,
			200
		);
		const noop = {
			...body,
			operation: "save",
			expected_version: f.version("web-search"),
			credentials: { apiKey: { op: "keep" } },
		};
		assert.equal(
			(await f.request(endpoint("web-search", "bocha", "save"), post(noop)))
				.status,
			200
		);
		assert.equal(f.audits().length, 1);
	} finally {
		f.db.close();
	}
});
test("D1 audit/target ABORT and IGNORE cannot leave half save_activate or return an unaudited reveal", async () => {
	for (const trigger of [
		"audit-abort",
		"audit-ignore",
		"catalog-abort",
		"catalog-ignore",
		"active-abort",
		"active-ignore",
	]) {
		const f = fixture();
		try {
			const audit = trigger.startsWith("audit");
			const ignore = trigger.endsWith("ignore");
			const condition = audit
				? ""
				: " WHEN NEW.key='" +
				  (trigger.startsWith("catalog")
						? "WEB_SEARCH_CATALOG"
						: "WEB_SEARCH_ACTIVE") +
				  "'";
			f.db.exec(
				"CREATE TRIGGER fail_write BEFORE INSERT ON " +
					(audit ? "config_group_audit" : "system_config") +
					condition +
					" BEGIN SELECT RAISE(" +
					(ignore ? "IGNORE" : "ABORT,'private-secret-error'") +
					"); END;"
			);
			const response = await f.request(
				endpoint("web-search", "bocha", "save"),
				post(save(f, "web-search"))
			);
			assert.equal(response.status, 500, trigger);
			assert.equal(
				(await response.text()).includes("private-secret-error"),
				false
			);
			assert.deepEqual(f.rows(), []);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
	for (const mode of ["IGNORE", "ABORT,'private-secret-error'"]) {
		const f = fixture({ values: { WEB_SEARCH_API_KEY: secret } });
		try {
			f.db.exec(
				"CREATE TRIGGER fail_reveal BEFORE INSERT ON config_group_audit BEGIN SELECT RAISE(" +
					mode +
					"); END;"
			);
			const response = await f.request(
				endpoint("web-search", "bocha", "reveal"),
				post({
					field: "apiKey",
					expected_version: f.version("web-search"),
					reason: "Inspect",
				})
			);
			assert.equal(response.status, 500);
			assert.equal((await response.text()).includes(secret), false);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});
test("generic eight-key writes share atomic group audit, reject six old keys and enforce full version flag", async () => {
	const f = fixture({ principal: bearer(["config.write"]) });
	try {
		const catalog = JSON.stringify({
			tavily: { apiKey: secret, metered: 1, standard: 1, charged: 1 },
		});
		const put = (body: unknown) => ({
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		assert.equal(
			(await f.request("", put({ key: "WEB_SEARCH_CATALOG", value: catalog })))
				.status,
			200
		);
		assert.equal(f.audits().length, 1);
		assert.equal(f.audits()[0].source, "legacy_admin");
		assert.equal(f.audits()[0].action, "legacy_save");
		assert.equal(
			f.db.prepare("SELECT COUNT(*) n FROM config_change_audit").get()?.n,
			0
		);
		const version = f.version("web-search");
		assert.equal(
			(
				await f.request(
					"",
					put({
						key: "WEB_SEARCH_ACTIVE",
						value: "tavily",
						tools_version: version,
						reason: "Enable after review",
					})
				)
			).status,
			200
		);
		assert.equal(f.audits().length, 2);
		assert.equal(
			f.audits().filter((row) => row.action === "activate").length,
			1
		);
		for (const key of [
			"WEB_SEARCH_PROVIDER",
			"WEB_SEARCH_API_KEY",
			"WEB_SEARCH_COST",
			"WEB_FETCH_PROVIDER",
			"WEB_FETCH_API_KEY",
			"WEB_FETCH_COST",
		])
			assert.equal((await f.request("", put({ key, value: "x" }))).status, 400);
		assert.equal(
			(
				await f.request(
					"",
					put({
						key: "WEB_SEARCH_ACTIVE",
						value: "tavily",
						tools_version: version,
						reason: "stale",
					})
				)
			).status,
			409
		);
		assert.equal(f.audits().length, 2);
	} finally {
		f.db.close();
	}
	const strict = fixture({
		strict: "true",
		principal: bearer(["config.write"]),
	});
	try {
		const response = await strict.request("", {
			method: "PUT",
			headers: { "Content-Type": "application/json", "If-None-Match": "*" },
			body: JSON.stringify({ key: "WEB_FETCH_CATALOG", value: "{}" }),
		});
		assert.equal(response.status, 428);
		assert.equal((await response.json()).code, "tools_version_required");
		assert.deepEqual(strict.calls, []);
	} finally {
		strict.db.close();
	}
});
test("missing atomic repository fails closed with 503 and no fallback single-key audit/writer", async () => {
	const f = fixture({ missingRepo: true });
	try {
		for (const path of [
			"/tools/overview",
			endpoint("web-search", "bocha", "detail"),
		])
			assert.equal((await f.request(path)).status, 503);
		assert.equal(
			(
				await f.request(
					endpoint("web-search", "bocha", "save"),
					post(save(f, "web-search"))
				)
			).status,
			503
		);
		assert.deepEqual(f.calls, []);
	} finally {
		f.db.close();
	}
});
test("audit returns safe snapshots/version metadata with six-digit tuple keyset paging and no secret/currency values", async () => {
	const f = fixture({ values: { WEB_SEARCH_API_KEY: secret } });
	try {
		for (let index = 0; index < 3; index++)
			assert.equal(
				(
					await f.request(
						endpoint("web-search", "bocha", "reveal"),
						post({
							field: "apiKey",
							expected_version: f.version("web-search"),
							reason: "Inspect " + secret,
						})
					)
				).status,
				200
			);
		const rows = f.audits();
		const ids = rows
			.map((row) => String(row.id))
			.sort()
			.reverse();
		for (const id of ids)
			f.db
				.prepare("UPDATE config_group_audit SET created_at=? WHERE id=?")
				.run(
					id === ids[2]
						? "2026-10-01T01:01:01.123455Z"
						: "2026-10-01T01:01:01.123456Z",
					id
				);
		const page1 = await f.request("/tools/web-search/audit?limit=2");
		assert.equal(page1.status, 200);
		const first = await page1.json();
		assert.deepEqual(
			first.data.entries.map((row: { id: string }) => row.id),
			ids.slice(0, 2)
		);
		assert.equal(
			first.data.entries[0].createdAt,
			"2026-10-01T01:01:01.123456Z"
		);
		assert.equal(
			first.data.next_cursor,
			toolConfigCursor("web-search", {
				createdAt: "2026-10-01T01:01:01.123456Z",
				id: ids[1],
			})
		);
		assert.equal(JSON.stringify(first).includes(secret), false);
		assert.equal(first.data.entries[0].reason, "Inspect [redacted]");
		assert.equal(
			first.data.entries[0].beforeVersion,
			first.data.entries[0].afterVersion
		);
		assert.deepEqual(first.data.entries[0].credentials, [
			{
				provider: "bocha",
				field: "apiKey",
				operation: "reveal",
				configuredBefore: true,
				configuredAfter: true,
			},
		]);
		const page2 = await f.request(
			"/tools/web-search/audit?limit=2&before=" + first.data.next_cursor
		);
		assert.equal(page2.status, 200);
		const second = await page2.json();
		assert.deepEqual(
			second.data.entries.map((row: { id: string }) => row.id),
			[ids[2]]
		);
		assert.equal(second.data.next_cursor, null);
		const before = f.calls.length;
		assert.equal(
			(
				await f.request(
					"/tools/web-fetch/audit?before=" + first.data.next_cursor
				)
			).status,
			400
		);
		assert.equal(f.calls.length, before);
	} finally {
		f.db.close();
	}
});
test("audit corrupt actor/source/vector/time or future raw columns never leak a raw storage error", async () => {
	for (const [column, value] of [
		["actor_id", "bad\u0001raw-secret"],
		["revision_after_json", "[]"],
		["created_at", "2026-10-01T01:01:01.999Z"],
		[
			"credentials_json",
			'[{"provider":"bocha","field":"apiKey","operation":"reveal","configuredBefore":"secret","configuredAfter":true}]',
		],
	] as const) {
		const f = fixture({ values: { WEB_SEARCH_API_KEY: secret } });
		try {
			assert.equal(
				(
					await f.request(
						endpoint("web-search", "bocha", "reveal"),
						post({
							field: "apiKey",
							expected_version: f.version("web-search"),
							reason: "Inspect",
						})
					)
				).status,
				200
			);
			f.db.prepare("UPDATE config_group_audit SET " + column + "=?").run(value);
			const response = await f.request("/tools/web-search/audit");
			assert.equal(response.status, 500);
			const raw = await response.text();
			assert.equal(raw.includes(secret), false);
			assert.equal(raw.includes(value), false);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
		} finally {
			f.db.close();
		}
	}
});
test("nonterminal or invalid repository success after commit is an unknown server failure, never a 400/false reveal", async () => {
	const f = fixture({ values: { WEB_SEARCH_API_KEY: secret } });
	try {
		f.store.applyConfigGroupIfRevisions = async () => ({
			outcome: "unchanged",
			auditId: null,
			revisionVector: [],
		});
		const response = await f.request(
			endpoint("web-search", "bocha", "reveal"),
			post({
				field: "apiKey",
				expected_version: f.version("web-search"),
				reason: "Inspect",
			})
		);
		assert.equal(response.status, 503);
		assert.equal((await response.text()).includes(secret), false);
		assert.deepEqual(f.audits(), []);
	} finally {
		f.db.close();
	}
});
test("all eight generic Tools keys use group storage and malformed active/catalog are 400 without commits", async () => {
	for (const family of TOOL_CONFIG_FAMILIES) {
		const f = fixture({ principal: bearer(["config.write"]) });
		try {
			const provider = TOOL_CONFIG_PROVIDERS[family].at(-1)!;
			assert.equal(
				(
					await f.request(
						endpoint(family, provider, "save"),
						post(save(f, family), null)
					)
				).status,
				200
			);
			const keys = TOOL_CONFIG_KEYS[family].filter(
				(key) => key.endsWith("_CATALOG") || key.endsWith("_ACTIVE")
			);
			for (const key of keys) {
				const current = f.db
					.prepare("SELECT value FROM system_config WHERE key=?")
					.get(key)?.value;
				const response = await f.request("", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						key,
						value: current,
						tools_version: f.version(family),
						reason: "Same reviewed value",
					}),
				});
				assert.equal(response.status, 200);
				assert.equal(f.audits().length, 1);
			}
			for (const key of keys) {
				const value = key.endsWith("_ACTIVE")
					? "unknown"
					: '{"' + provider + '":{"apiKey":"hidden","future":true}}';
				const before = f.rows();
				const response = await f.request("", {
					method: "PUT",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ key, value }),
				});
				assert.equal(response.status, 400);
				assert.deepEqual(f.rows(), before);
				assert.equal(f.audits().length, 1);
			}
		} finally {
			f.db.close();
		}
	}
});
test("target UPDATE ABORT/IGNORE rolls back both existing catalog/active and audit on save_activate", async () => {
	for (const target of ["WEB_SEARCH_CATALOG", "WEB_SEARCH_ACTIVE"])
		for (const mode of ["IGNORE", "ABORT,'private-update-secret'"]) {
			const f = fixture();
			try {
				assert.equal(
					(
						await f.request(
							endpoint("web-search", "bocha", "save"),
							post(save(f, "web-search"))
						)
					).status,
					200
				);
				const before = f.rows();
				const audit = f.audits();
				f.db.exec(
					"CREATE TRIGGER fail_update BEFORE UPDATE ON system_config WHEN NEW.key='" +
						target +
						"' BEGIN SELECT RAISE(" +
						mode +
						"); END;"
				);
				const response = await f.request(
					endpoint("web-search", "tavily", "save"),
					post(save(f, "web-search", "save_activate", "second-secret"))
				);
				assert.equal(response.status, 500);
				assert.equal(
					(await response.text()).includes("private-update-secret"),
					false
				);
				assert.deepEqual(f.rows(), before);
				assert.deepEqual(f.audits(), audit);
			} finally {
				f.db.close();
			}
		}
});
test("cross-family old/new credentials are redacted without broadening the target CAS dependencies", async () => {
	const other = "other-family-plain-secret";
	const f = fixture({
		values: { WEB_FETCH_CATALOG: JSON.stringify({ jina: { apiKey: other } }) },
	});
	try {
		const body = {
			...save(f, "web-search"),
			reason: "Keep " + other + " and " + secret,
		};
		const response = await f.request(
			endpoint("web-search", "bocha", "save"),
			post(body)
		);
		assert.equal(response.status, 200);
		assert.equal(f.audits()[0].reason, "Keep [redacted] and [redacted]");
		const vector = JSON.parse(String(f.audits()[0].revision_before_json));
		assert.deepEqual(
			vector.map((row: { key: string }) => row.key),
			TOOL_CONFIG_KEYS["web-search"]
		);
		assert.equal(
			f.calls.filter(
				(sql) =>
					sql.startsWith(
						"SELECT key, value, revision FROM system_config WHERE key IN"
					) && (sql.match(/\?/gu)?.length ?? 0) === 15
			).length,
			1
		);
	} finally {
		f.db.close();
	}
});
test("activation of already loss-priced standby provider also requires acknowledgement", async () => {
	const f = fixture({
		values: {
			WEB_SEARCH_ACTIVE: "bocha",
			WEB_SEARCH_CATALOG: JSON.stringify({
				bocha: { apiKey: "bocha-secret", metered: 1, standard: 1, charged: 1 },
				tavily: { apiKey: secret, metered: 2, standard: 3, charged: 1 },
			}),
		},
	});
	try {
		const body = {
			...save(f, "web-search"),
			prices: { metered: 2, standard: 3, charged: 1 },
			credentials: { apiKey: { op: "keep" } },
		};
		const response = await f.request(
			endpoint("web-search", "tavily", "save"),
			post(body)
		);
		assert.equal(response.status, 409);
		assert.equal(
			(await response.json()).code,
			"tools_loss_pricing_confirmation_required"
		);
		assert.deepEqual(f.audits(), []);
		assert.equal(
			(
				await f.request(
					endpoint("web-search", "tavily", "save"),
					post({ ...body, accept_loss_pricing: true })
				)
			).status,
			200
		);
	} finally {
		f.db.close();
	}
});

test("strict generic Console writes need same-subject header, full token and human reason before repository access", async () => {
	const f = fixture({ strict: "true" });
	try {
		const body = {
			key: "WEB_SEARCH_CATALOG",
			value: JSON.stringify({ tavily: { apiKey: secret } }),
			tools_version: f.version("web-search"),
			reason: "Reviewed draft",
		};
		const put = (value: unknown, expected: string | null) => ({
			...post(value, expected),
			method: "PUT",
		});
		assert.equal((await f.request("", put(body, null))).status, 428);
		assert.equal(
			(await f.request("", put(body, "changed-subject"))).status,
			403
		);
		assert.deepEqual(f.calls, []);
		assert.equal(
			(await f.request("", put({ ...body, tools_version: undefined }, subject)))
				.status,
			428
		);
		assert.equal(
			(await f.request("", put({ ...body, reason: undefined }, subject)))
				.status,
			400
		);
		assert.deepEqual(f.calls, []);
		assert.equal((await f.request("", put(body, subject))).status, 200);
		assert.equal(f.audits()[0].source, "admin_api");
		assert.equal(f.audits()[0].actor_id, consolePrincipal.id);
	} finally {
		f.db.close();
	}
});
test("off-compatible If-Match remains a target condition and cannot substitute for strict complete version", async () => {
	const f = fixture({
		principal: bearer(["config.write"]),
		values: { WEB_SEARCH_CATALOG: "{}" },
	});
	try {
		const request = (condition: string) => ({
			method: "PUT",
			headers: { "Content-Type": "application/json", "If-Match": condition },
			body: JSON.stringify({
				key: "WEB_SEARCH_CATALOG",
				value: JSON.stringify({ tavily: { apiKey: secret } }),
			}),
		});
		assert.equal((await f.request("", request('"legacy"'))).status, 200);
		assert.equal(f.audits()[0].source, "legacy_admin");
		const before = f.rows();
		assert.equal((await f.request("", request('"legacy"'))).status, 409);
		assert.deepEqual(f.rows(), before);
		assert.equal(f.audits().length, 1);
	} finally {
		f.db.close();
	}
	const strict = fixture({
		strict: "true",
		principal: bearer(["config.write"]),
		values: { WEB_SEARCH_CATALOG: "{}" },
	});
	try {
		assert.equal(
			(
				await strict.request("", {
					method: "PUT",
					headers: {
						"Content-Type": "application/json",
						"If-Match": '"legacy"',
					},
					body: JSON.stringify({ key: "WEB_SEARCH_CATALOG", value: "{}" }),
				})
			).status,
			428
		);
		assert.deepEqual(strict.calls, []);
		assert.deepEqual(strict.audits(), []);
	} finally {
		strict.db.close();
	}
});
test("bounded private Tools failures reject oversized JSON and future reveal fields before credential reads", async () => {
	const f = fixture();
	try {
		assert.equal(
			(
				await f.request(
					endpoint("ai-detection", "tencent_tms", "reveal"),
					post({
						field: "email",
						expected_version: f.version("ai-detection"),
						reason: "Inspect",
					})
				)
			).status,
			400
		);
		const bounded = await f.request(
			endpoint("web-search", "bocha", "save"),
			post({ ...save(f, "web-search"), reason: "x".repeat(65536) })
		);
		assert.equal(bounded.status, 400);
		assert.equal(bounded.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(f.calls, []);
		const bodyLimit = await f.request(endpoint("web-search", "bocha", "save"), {
			...post({}),
			body: "x".repeat(2 * 1024 * 1024 + 1),
		});
		assert.equal(bodyLimit.status, 413);
		assert.equal(bodyLimit.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(f.calls, []);
	} finally {
		f.db.close();
	}
});

test("invalid legacy provider never echoes arbitrary stored material in overview/detail and blocks writes", async () => {
	for (const family of ["web-search", "web-fetch"] as const) {
		const prefix = family === "web-search" ? "WEB_SEARCH" : "WEB_FETCH";
		const raw = "raw-provider-private-material";
		const f = fixture({
			values: { [prefix + "_PROVIDER"]: raw, [prefix + "_API_KEY"]: secret },
		});
		try {
			const overview = await f.request("/tools/overview");
			assert.equal(overview.status, 200);
			const body = await overview.json();
			const state = body.data.families.find((row) => row.family === family)!;
			assert.equal(state.effectiveProvider, null);
			assert.equal(state.configurationIssue, "invalid_provider");
			assert.equal(state.editable, false);
			assert.equal(JSON.stringify(body).includes(raw), false);
			const detail = await f.request(
				endpoint(family, TOOL_CONFIG_PROVIDERS[family][0], "detail")
			);
			assert.equal(detail.status, 200);
			assert.equal(JSON.stringify(await detail.json()).includes(raw), false);
			assert.equal(
				(
					await f.request(
						endpoint(family, TOOL_CONFIG_PROVIDERS[family][0], "save"),
						post(save(f, family))
					)
				).status,
				409
			);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});

test("generic bulk GET masks all fourteen fixed Tools values and descriptions even for privileged readers", async () => {
	const keys: readonly string[] = TOOL_CONFIG_OVERVIEW_KEYS.filter(
		(key) => key !== "BILLING_CURRENCY"
	);
	assert.equal(keys.length, 14);
	const material = "arbitrary-stored-private-material";
	for (const principal of [
		consolePrincipal,
		bearer(["config.read", "config.secrets.read"]),
	]) {
		const f = fixture({
			principal,
			values: {
				...Object.fromEntries(keys.map((key) => [key, material + ":" + key])),
				BILLING_CURRENCY: "CNY",
				UNRELATED_API_KEY: "unrelated-private-key",
				MASTER_KEY: "removed-master-secret",
			},
		});
		try {
			for (const key of keys)
				f.db
					.prepare("UPDATE system_config SET description=? WHERE key=?")
					.run(material, key);
			const response = await f.request("");
			assert.equal(response.status, 200);
			assert.equal(response.headers.get("cache-control"), "private, no-store");
			const body = (await response.json()) as unknown as {
				data: Array<{
					key: string;
					value: string | null;
					description: string | null;
				}>;
			};
			assert.deepEqual(
				body.data
					.filter((row) => keys.includes(row.key))
					.map((row) => row.key)
					.sort(),
				keys
			);
			for (const row of body.data.filter((entry) => keys.includes(entry.key))) {
				assert.equal(row.value, "••••••••");
				assert.equal(row.description, null);
			}
			assert.equal(JSON.stringify(body).includes(material), false);
			assert.equal(
				body.data.find((row) => row.key === "BILLING_CURRENCY")?.value,
				"CNY"
			);
			assert.equal(
				body.data.find((row) => row.key === "UNRELATED_API_KEY")?.value,
				"unrelated-private-key"
			);
			assert.equal(
				JSON.stringify(body).includes("removed-master-secret"),
				false
			);
			assert.deepEqual(f.audits(), []);
		} finally {
			f.db.close();
		}
	}
});

test("generic bulk GET preserves unrelated secret permissions and refuses readers lacking config.read", async () => {
	const f = fixture({
		principal: bearer(["config.read"]),
		values: {
			WEB_SEARCH_CATALOG: '{"future":"private"}',
			UNRELATED_API_KEY: secret,
		},
	});
	try {
		const response = await f.request("");
		assert.equal(response.status, 200);
		const body = (await response.json()) as unknown as {
			data: Array<{ key: string; value: string | null }>;
		};
		assert.equal(
			body.data.find((row) => row.key === "WEB_SEARCH_CATALOG")?.value,
			"••••••••"
		);
		assert.equal(
			body.data.find((row) => row.key === "UNRELATED_API_KEY")?.value,
			"••••••••"
		);
		assert.equal(JSON.stringify(body).includes(secret), false);
	} finally {
		f.db.close();
	}
	const denied = fixture({ principal: bearer(["config.secrets.read"]) });
	try {
		const response = await denied.request("");
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(denied.calls, []);
	} finally {
		denied.db.close();
	}
});

test("Tools reasons preserve six hundred Unicode code points through HTTP auditing and reject six hundred one before reads", async () => {
	for (const character of ["😀", "中"]) {
		const reason = character.repeat(600);
		const f = fixture();
		try {
			const response = await f.request(
				endpoint("web-search", "bocha", "save"),
				post({ ...save(f, "web-search"), reason })
			);
			assert.equal(response.status, 200, await response.clone().text());
			assert.equal(f.audits().length, 1);
			assert.equal(f.audits()[0].reason, reason);
			const reveal = await f.request(
				endpoint("web-search", "bocha", "reveal"),
				post({
					field: "apiKey",
					expected_version: f.version("web-search"),
					reason,
				})
			);
			assert.equal(reveal.status, 200, await reveal.clone().text());
			assert.equal((await reveal.json()).data.value, secret);
			assert.equal(f.audits().length, 2);
			assert.ok(f.audits().every((row) => row.reason === reason));
			const audit = await f.request("/tools/web-search/audit");
			assert.equal(audit.status, 200, await audit.clone().text());
			assert.ok(
				(await audit.json()).data.entries.every((row) => row.reason === reason)
			);
			f.calls.length = 0;
			const tooLong = character.repeat(601);
			for (const [path, init] of [
				[
					endpoint("web-search", "bocha", "save"),
					post({ ...save(f, "web-search"), reason: tooLong }),
				],
				[
					endpoint("web-search", "bocha", "reveal"),
					post({
						field: "apiKey",
						expected_version: f.version("web-search"),
						reason: tooLong,
					}),
				],
				[
					"",
					{
						...post({
							key: "WEB_SEARCH_ACTIVE",
							value: "bocha",
							tools_version: f.version("web-search"),
							reason: tooLong,
						}),
						method: "PUT",
					},
				],
			] as const) {
				const rejected = await f.request(path, init);
				assert.equal(rejected.status, 400);
				assert.equal(
					rejected.headers.get("cache-control"),
					"private, no-store"
				);
				assert.deepEqual(f.calls, []);
				assert.equal(f.audits().length, 2);
			}
		} finally {
			f.db.close();
		}
	}
});
