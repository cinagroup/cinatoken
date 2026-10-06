import type { SQLInputValue } from "node:sqlite";
import { DatabaseSync } from "node:sqlite";
import { ADMIN_OIDC_CLIENT_SECRET_PREFIX } from "@cinaauth/auth-web-contract";
import { describe, expect, it, vi } from "vitest";
import {
	CINATOKEN_OIDC_CLIENT_ID,
	ensureCinatokenOidcClient,
	isCinatokenOidcAuthorizationRequest,
} from "../src/cinatoken-oidc-client";

const CLIENT_SECRET_PAYLOAD =
	"cinatoken-client-secret-with-at-least-32-characters";
const CLIENT_SECRET = `${ADMIN_OIDC_CLIENT_SECRET_PREFIX}${CLIENT_SECRET_PAYLOAD}`;
const APPLICATION_ORIGIN = "https://cinatoken.com";

describe("cinatoken OIDC client bootstrap", () => {
	it("recognizes only fixed-client GET authorization requests", () => {
		const url = new URL("https://auth.cinaseek.si/api/auth/oauth2/authorize");
		url.searchParams.set("client_id", CINATOKEN_OIDC_CLIENT_ID);
		expect(isCinatokenOidcAuthorizationRequest(new Request(url))).toBe(true);
		expect(
			isCinatokenOidcAuthorizationRequest(new Request(url, { method: "POST" })),
		).toBe(false);
		url.searchParams.set("client_id", "other-client");
		expect(isCinatokenOidcAuthorizationRequest(new Request(url))).toBe(false);
	});

	it("stores only the secret hash and exact cinatoken redirect", async () => {
		const query = vi.fn(async (_sql: string, _values: readonly unknown[]) => ({
			rows: [],
		}));
		await ensureCinatokenOidcClient(
			{ query },
			CLIENT_SECRET,
			APPLICATION_ORIGIN,
		);
		const [sql, values] = query.mock.calls[0] ?? [];
		expect(sql).toContain('INSERT INTO "oauthClient"');
		expect(values).toContain(CINATOKEN_OIDC_CLIENT_ID);
		expect(values).toContain(
			JSON.stringify(["https://cinatoken.com/api/auth/cinaauth/callback"]),
		);
		expect(values).toContain("client_secret_basic");
		expect(values).toContain(true);
		expect(values).not.toContain(CLIENT_SECRET);
	});

	it("rejects weak or unprefixed secrets before querying", async () => {
		const query = vi.fn(async () => ({ rows: [] }));
		await expect(
			ensureCinatokenOidcClient(
				{ query },
				CLIENT_SECRET_PAYLOAD,
				APPLICATION_ORIGIN,
			),
		).rejects.toThrow(/cina_cs_/i);
		await expect(
			ensureCinatokenOidcClient(
				{ query },
				`${ADMIN_OIDC_CLIENT_SECRET_PREFIX}short`,
				APPLICATION_ORIGIN,
			),
		).rejects.toThrow(/strong payload/i);
		expect(query).not.toHaveBeenCalled();
	});
});


/** @see https://www.rfc-editor.org/rfc/rfc8707.html#section-3 */
describe("cinatoken reserved resource initialization", () => {
	const createDatabase = () => {
		const database = new DatabaseSync(":memory:");
		database.exec([
			'PRAGMA foreign_keys = ON;',
			'CREATE TABLE "oauthClient" ("id" TEXT PRIMARY KEY, "clientId" TEXT UNIQUE, "clientSecret" TEXT, "disabled" INTEGER, "skipConsent" INTEGER, "enableEndSession" INTEGER, "subjectType" TEXT, "scopes" TEXT, "userId" TEXT, "referenceId" TEXT, "createdAt" TEXT, "updatedAt" TEXT, "name" TEXT, "uri" TEXT, "icon" TEXT, "redirectUris" TEXT, "postLogoutRedirectUris" TEXT, "tokenEndpointAuthMethod" TEXT, "grantTypes" TEXT, "responseTypes" TEXT, "public" INTEGER, "type" TEXT, "requirePKCE" INTEGER, "softwareId" TEXT, "softwareVersion" TEXT);',
			'CREATE TABLE "oauthResource" ("id" TEXT PRIMARY KEY, "identifier" TEXT UNIQUE NOT NULL, "name" TEXT, "disabled" INTEGER DEFAULT 0, "accessTokenTtl" INTEGER, "allowedScopes" TEXT, "createdAt" TEXT, "updatedAt" TEXT);',
			'CREATE TABLE "oauthClientResource" ("id" TEXT PRIMARY KEY, "clientId" TEXT NOT NULL, "resourceId" TEXT NOT NULL, "metadata" TEXT, "createdAt" TEXT, UNIQUE ("clientId", "resourceId"), FOREIGN KEY ("clientId") REFERENCES "oauthClient" ("clientId"), FOREIGN KEY ("resourceId") REFERENCES "oauthResource" ("identifier"));',
		].join("\n"));
		const query = async (sql: string, values: unknown[]) =>
			database.prepare(sql).run(
				Object.fromEntries(
					values.map((value, index) => [
						"$" + (index + 1),
						value instanceof Date
							? value.toISOString()
							: typeof value === "boolean"
								? Number(value)
								: (value as SQLInputValue),
					]),
				),
			);
		return { database, query };
	};

	it("initializes the missing exact resource and client association", async () => {
		const { database, query } = createDatabase();
		try {
			await ensureCinatokenOidcClient({ query }, CLIENT_SECRET, APPLICATION_ORIGIN);
			expect(database.prepare('SELECT "identifier", "disabled" FROM "oauthResource"').all()).toEqual([{ identifier: APPLICATION_ORIGIN, disabled: 0 }]);
			expect(database.prepare('SELECT "clientId", "resourceId" FROM "oauthClientResource"').all()).toEqual([{ clientId: CINATOKEN_OIDC_CLIENT_ID, resourceId: APPLICATION_ORIGIN }]);
			expect(database.prepare('SELECT "scopes", "requirePKCE", "tokenEndpointAuthMethod" FROM "oauthClient" WHERE "clientId" = ?').get(CINATOKEN_OIDC_CLIENT_ID)).toEqual({
				scopes: JSON.stringify(["openid", "profile", "email"]),
				requirePKCE: 1,
				tokenEndpointAuthMethod: "client_secret_basic",
			});
		} finally {
			database.close();
		}
	});

	it("is idempotent without replacing the original resource or link", async () => {
		const { database, query } = createDatabase();
		try {
			await ensureCinatokenOidcClient({ query }, CLIENT_SECRET, APPLICATION_ORIGIN);
			const resource = database.prepare('SELECT * FROM "oauthResource"').get();
			const link = database.prepare('SELECT * FROM "oauthClientResource"').get();
			await ensureCinatokenOidcClient({ query }, CLIENT_SECRET, APPLICATION_ORIGIN);
			expect(database.prepare('SELECT * FROM "oauthResource"').all()).toEqual([resource]);
			expect(database.prepare('SELECT * FROM "oauthClientResource"').all()).toEqual([link]);
			expect(database.prepare('SELECT count(*) AS count FROM "oauthClient"').get()).toEqual({ count: 1 });
		} finally {
			database.close();
		}
	});

	it("preserves disabled resource policy and operator-managed link metadata", async () => {
		const { database, query } = createDatabase();
		try {
			database.prepare('INSERT INTO "oauthClient" ("id", "clientId") VALUES (?, ?)').run("existing-client", CINATOKEN_OIDC_CLIENT_ID);
			database.prepare('INSERT INTO "oauthResource" ("id", "identifier", "name", "disabled", "accessTokenTtl", "allowedScopes", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run("operator-resource", APPLICATION_ORIGIN, "operator label", 1, 120, '["profile"]', "2000-01-01", "2000-01-02");
			database.prepare('INSERT INTO "oauthClientResource" ("id", "clientId", "resourceId", "metadata", "createdAt") VALUES (?, ?, ?, ?, ?)').run("operator-link", CINATOKEN_OIDC_CLIENT_ID, APPLICATION_ORIGIN, '{"owner":"operator"}', "2000-01-01");
			const resource = database.prepare('SELECT * FROM "oauthResource"').get();
			const link = database.prepare('SELECT * FROM "oauthClientResource"').get();
			await ensureCinatokenOidcClient({ query }, CLIENT_SECRET, APPLICATION_ORIGIN);
			expect(database.prepare('SELECT * FROM "oauthResource"').get()).toEqual(resource);
			expect(database.prepare('SELECT * FROM "oauthClientResource"').get()).toEqual(link);
			expect(database.prepare('SELECT "disabled" FROM "oauthResource"').get()).toEqual({ disabled: 1 });
		} finally {
			database.close();
		}
	});

	it("never links another client or enables an unrelated resource", async () => {
		const { database, query } = createDatabase();
		try {
			database.prepare('INSERT INTO "oauthClient" ("id", "clientId") VALUES (?, ?)').run("other-client-row", "other-client");
			database.prepare('INSERT INTO "oauthResource" ("id", "identifier", "name", "disabled", "accessTokenTtl") VALUES (?, ?, ?, ?, ?)').run("unrelated-resource", "https://unregistered.example.invalid", "unrelated", 1, 60);
			const unrelated = database.prepare('SELECT * FROM "oauthResource"').get();
			await ensureCinatokenOidcClient({ query }, CLIENT_SECRET, APPLICATION_ORIGIN);
			expect(database.prepare('SELECT * FROM "oauthResource" WHERE "identifier" = ?').get("https://unregistered.example.invalid")).toEqual(unrelated);
			expect(database.prepare('SELECT * FROM "oauthClientResource" WHERE "clientId" = ?').all("other-client")).toEqual([]);
			expect(database.prepare('SELECT "resourceId" FROM "oauthClientResource" WHERE "clientId" = ?').all(CINATOKEN_OIDC_CLIENT_ID)).toEqual([{ resourceId: APPLICATION_ORIGIN }]);
		} finally {
			database.close();
		}
	});
});

