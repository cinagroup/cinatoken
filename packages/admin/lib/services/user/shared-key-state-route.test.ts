import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Hono } from "hono";
import type { D1Database } from "@cloudflare/workers-types";
import { createD1DatabaseClient } from "@octafuse/core";
import type { GatewayRepositories } from "@octafuse/core";
import { createD1SharedKeysRepository } from "../../../../core/src/db/d1/portal-marketplace.impl";
import type { D1DatabaseClient } from "../../../../core/src/storage/database-client";
import type { UserEnv } from "@/lib/user-env";
import { userSharedKeysRoutes } from "@/lib/routes/user/shared-keys";

const secret = "sk-synthetic-state-secret";
const stamp = "2026-09-30T00:00:00.000Z";

// Admin's installed Node declarations predate node:sqlite. Keep this actual Node SQLite
// runtime boundary typed locally; do not replace database execution with a mock.
type SQLInputValue = string | number | bigint | null | Uint8Array;
type SqliteDatabase = {
	exec(sql: string): void;
	close(): void;
	prepare(sql: string): {
		get(...values: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
		all(...values: SQLInputValue[]): Record<string, SQLInputValue>[];
		run(...values: SQLInputValue[]): { changes: number | bigint };
	};
};
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
	DatabaseSync: new (path: string) => SqliteDatabase;
};
type SharedStateResponse = {
	success: boolean;
	code?: string;
	data: {
		status: string;
		validatedAt: string | null;
		label: string;
		apiKey?: string;
	};
};
async function responseBody(response: Response): Promise<SharedStateResponse> {
	return (await response.json()) as SharedStateResponse;
}

function fixture(
	status = "paused",
	validatedAt: string | null = stamp,
	canManage = true
) {
	const database = new DatabaseSync(":memory:");
	database.exec(`CREATE TABLE shared_keys (
		id TEXT PRIMARY KEY, seller_user_id TEXT, channel_type TEXT, api_key TEXT, key_fingerprint TEXT, label TEXT,
		status TEXT, seller_priority INTEGER DEFAULT 0, weight INTEGER, input_price REAL, output_price REAL,
		cache_read_price REAL, cache_write_price REAL, validated_at TEXT, last_used_at TEXT, last_failure_at TEXT,
		failure_reason TEXT, served_input_tokens INTEGER DEFAULT 0, served_output_tokens INTEGER DEFAULT 0,
		earned_total REAL DEFAULT 0, created_at TEXT, updated_at TEXT
	)`);
	database
		.prepare(
			`INSERT INTO shared_keys
		(id,seller_user_id,channel_type,api_key,key_fingerprint,label,status,weight,input_price,output_price,validated_at,created_at,updated_at)
		VALUES ('key-1','seller-1','openai',?,'…tail','before',?,10,1.5,2,?,?,?)`
		)
		.run(secret, status, validatedAt, stamp, stamp);
	const raw = {
		prepare: (sql: string) => {
			const bound = (values: unknown[]) => ({
				async first() {
					return (
						database.prepare(sql).get(...(values as SQLInputValue[])) ?? null
					);
				},
				async all() {
					return {
						success: true,
						results: database.prepare(sql).all(...(values as SQLInputValue[])),
					};
				},
				async run() {
					return {
						success: true,
						meta: {
							changes: Number(
								database.prepare(sql).run(...(values as SQLInputValue[]))
									.changes
							),
						},
					};
				},
			});
			return { ...bound([]), bind: (...values: unknown[]) => bound(values) };
		},
	};
	const keys = createD1SharedKeysRepository({
		raw,
	} as unknown as D1DatabaseClient);
	const configuration = new Map([
		["BILLING_CURRENCY", "USD"],
		["SHARED_KEY_ENABLED_CHANNELS", "openai"],
		["SHARED_KEY_MAX_INPUT_PRICE", "3"],
		["SHARED_KEY_MAX_OUTPUT_PRICE", "6"],
		["SHARED_KEY_COMMISSION_RATE", "0.1"],
	]);
	let configHook: (() => void) | null = null;
	const configurationDatabase = {
		prepare: () => ({
			bind: (key: string) => ({
				raw: async () => {
					const hook = configHook;
					configHook = null;
					hook?.();
					return configuration.has(key) ? [[configuration.get(key)]] : [];
				},
			}),
		}),
	} as unknown as D1Database;
	const repositories = {
		client: createD1DatabaseClient(configurationDatabase),
		sharedKeys: keys,
		systemConfig: {
			getConfig: async (key: string) => configuration.get(key) ?? null,
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "seller-1",
			capabilities: canManage ? ["shared_keys.manage"] : [],
		} as UserEnv["Variables"]["principal"]);
		await next();
	});
	app.route("/shared-keys", userSharedKeysRoutes);
	return {
		app,
		database,
		repositories,
		current: () => ({
			...database
				.prepare("SELECT * FROM shared_keys WHERE id = ?")
				.get("key-1")!,
		}),
		change: (column: string, value: SQLInputValue) => {
			database
				.prepare(`UPDATE shared_keys SET ${column} = ? WHERE id = ?`)
				.run(value, "key-1");
		},
		onConfig: (hook: () => void) => {
			configHook = hook;
		},
	};
}

const json = (method: string, input: unknown) => ({
	method,
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(input),
});

test("seller cannot activate or pause invalid/validating/disabled keys, or resume an unstamped legacy paused key", async () => {
	for (const status of ["disabled", "invalid", "validating"]) {
		const f = fixture(status, null);
		try {
			for (const target of ["active", "paused"]) {
				const before = f.current();
				const response = await f.app.request(
					"/shared-keys/key-1",
					json("PATCH", { status: target, label: "must not write" })
				);
				assert.equal(response.status, status === "disabled" ? 403 : 400);
				assert.equal(
					response.headers.get("cache-control"),
					"private, no-store"
				);
				assert.deepEqual(f.current(), before);
			}
		} finally {
			f.database.close();
		}
	}
	const legacy = fixture("paused", null);
	try {
		assert.equal(
			(
				await legacy.app.request(
					"/shared-keys/key-1",
					json("PATCH", { status: "active" })
				)
			).status,
			400
		);
	} finally {
		legacy.database.close();
	}
});

test("verified seller resume returns authoritative active row, while disabled keys can edit profile without lifting governance", async () => {
	for (const status of ["paused", "disabled"]) {
		const f = fixture(status);
		try {
			const response = await f.app.request(
				"/shared-keys/key-1",
				json("PATCH", {
					label: "after",
					weight: 20,
					inputPrice: 2,
					...(status === "paused" ? { status: "active" } : {}),
				})
			);
			assert.equal(response.status, 200);
			const result = await responseBody(response);
			assert.equal(
				result.data.status,
				status === "paused" ? "active" : "disabled"
			);
			assert.equal(result.data.validatedAt, stamp);
			assert.equal(result.data.label, "after");
			assert.equal(JSON.stringify(result).includes(secret), false);
		} finally {
			f.database.close();
		}
	}
});

test("governance changes between seller read and write reject the whole patch with private 409", async () => {
	const f = fixture();
	try {
		f.onConfig(() => f.change("status", "disabled"));
		const response = await f.app.request(
			"/shared-keys/key-1",
			json("PATCH", {
				status: "active",
				label: "must not write",
				inputPrice: 2,
			})
		);
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("cache-control"), "private, no-store");
		assert.equal(
			(await responseBody(response)).code,
			"shared_key_state_conflict"
		);
		assert.equal(f.current().status, "disabled");
		assert.equal(f.current().label, "before");
		assert.equal(f.current().input_price, 1.5);
	} finally {
		f.database.close();
	}
});

test("revalidation writes a fresh proof only on success and clears proof on authoritative rejection", async (t) => {
	let status = 200;
	t.mock.method(
		globalThis,
		"fetch",
		async () => new Response(null, { status })
	);
	for (const httpStatus of [200, 401, 503]) {
		status = httpStatus;
		const f = fixture("invalid", null);
		try {
			const response = await f.app.request("/shared-keys/key-1/revalidate", {
				method: "POST",
			});
			assert.equal(response.status, 200);
			const result = await responseBody(response);
			assert.equal(
				result.data.status,
				httpStatus === 200 ? "active" : "invalid"
			);
			assert.equal(
				httpStatus === 200
					? typeof result.data.validatedAt
					: result.data.validatedAt,
				httpStatus === 200 ? "string" : null
			);
			assert.equal(JSON.stringify(result).includes(secret), false);
		} finally {
			f.database.close();
		}
	}
});

test("successful and rejected upstream validation cannot override a concurrent Admin disable or edited price", async (t) => {
	let duringFetch = () => {};
	let upstreamStatus = 200;
	t.mock.method(globalThis, "fetch", async () => {
		duringFetch();
		return new Response(null, { status: upstreamStatus });
	});
	for (const httpStatus of [200, 401])
		for (const drift of ["status", "input_price"]) {
			upstreamStatus = httpStatus;
			const f = fixture("validating", null);
			try {
				duringFetch = () =>
					f.change(drift, drift === "status" ? "disabled" : 2.5);
				const response = await f.app.request("/shared-keys/key-1/revalidate", {
					method: "POST",
				});
				assert.equal(response.status, 409);
				assert.equal(
					(await responseBody(response)).code,
					"shared_key_state_conflict"
				);
				assert.equal(
					f.current().status,
					drift === "status" ? "disabled" : "validating"
				);
				assert.equal(f.current().validated_at, null);
				assert.equal(f.current().failure_reason, null);
			} finally {
				f.database.close();
			}
		}
});

test("creation stamps successful validation, keeps inconclusive keys validating, and never echoes a secret after a governance race", async (t) => {
	let status = 200;
	let duringFetch = () => {};
	t.mock.method(globalThis, "fetch", async () => {
		duringFetch();
		return new Response(null, { status });
	});
	for (const mode of ["success", "inconclusive", "disabled"] as const) {
		const f = fixture();
		status = mode === "inconclusive" ? 503 : 200;
		try {
			duringFetch =
				mode === "disabled"
					? () => {
							f.database.exec(
								"UPDATE shared_keys SET status='disabled' WHERE id<>'key-1'"
							);
					  }
					: () => {};
			const response = await f.app.request(
				"/shared-keys",
				json("POST", {
					channelType: "openai",
					apiKey: secret,
					inputPrice: 1,
					outputPrice: 2,
				})
			);
			const result = await responseBody(response);
			assert.equal(response.status, mode === "disabled" ? 409 : 200);
			const created = f.database
				.prepare("SELECT * FROM shared_keys WHERE id<>'key-1'")
				.get()!;
			assert.equal(
				created.status,
				mode === "disabled"
					? "disabled"
					: mode === "inconclusive"
					? "validating"
					: "active"
			);
			assert.equal(
				mode === "success" ? typeof created.validated_at : created.validated_at,
				mode === "success" ? "string" : null
			);
			assert.equal(
				mode === "disabled"
					? JSON.stringify(result).includes(secret)
					: result.data.apiKey === secret,
				mode !== "disabled"
			);
		} finally {
			f.database.close();
		}
	}
});

test("ignored validation writes return 409 and missing atomic methods fail closed before probes or creation", async (t) => {
	let probes = 0;
	t.mock.method(globalThis, "fetch", async () => {
		probes++;
		return new Response(null, { status: 200 });
	});
	const f = fixture("validating", null);
	try {
		f.database.exec(
			"CREATE TRIGGER ignored_update BEFORE UPDATE ON shared_keys BEGIN SELECT RAISE(IGNORE); END"
		);
		assert.equal(
			(await f.app.request("/shared-keys/key-1/revalidate", { method: "POST" }))
				.status,
			409
		);
		assert.equal(f.current().status, "validating");
		assert.equal(f.current().validated_at, null);
		f.database.exec("DROP TRIGGER ignored_update");
		Object.defineProperty(
			f.repositories.sharedKeys,
			"completeSharedKeyValidation",
			{ value: undefined }
		);
		const beforeProbes = probes;
		assert.equal(
			(await f.app.request("/shared-keys/key-1/revalidate", { method: "POST" }))
				.status,
			503
		);
		assert.equal(
			(
				await f.app.request(
					"/shared-keys",
					json("POST", {
						channelType: "openai",
						apiKey: secret,
						inputPrice: 1,
						outputPrice: 2,
					})
				)
			).status,
			503
		);
		assert.equal(probes, beforeProbes);
		assert.equal(
			f.database.prepare("SELECT COUNT(*) AS n FROM shared_keys").get()!.n,
			1
		);
	} finally {
		f.database.close();
	}
});
