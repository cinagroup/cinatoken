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
		const url = new URL("https://auth.cinaseek.ai/api/auth/oauth2/authorize");
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
