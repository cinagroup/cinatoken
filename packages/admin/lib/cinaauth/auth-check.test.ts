import assert from "node:assert/strict";
import { test } from "node:test";
import type { AdminPrincipal } from "@/lib/admin-principal";
import { createAdminAuthCheckResponse } from "./auth-check";

const request = new Request(
	"https://cinatoken.com/api/auth/check?subject=untrusted-query"
);
const principal: AdminPrincipal = {
	type: "console",
	id: "console:cinaauth:verified-user",
	username: "cinaauth:verified-user",
};

async function configured(run: () => Promise<void>): Promise<void> {
	const values = {
		CINATOKEN_OIDC_BRIDGE_SECRET:
			"test-auth-check-bridge-secret-more-than-32-characters",
		CINATOKEN_REQUIRED_ROLES: "security_admin",
		CINAAUTH_ISSUER: "https://auth.cinaseek.si",
		CINAAUTH_ACCOUNT_ORIGIN: "https://accounts.cinaseek.si",
		CINATOKEN_APP_ORIGIN: "https://cinatoken.com",
		CINATOKEN_OIDC_CLIENT_ID: "cinatoken-admin",
	};
	const previous = new Map(
		Object.keys(values).map((name) => [name, process.env[name]])
	);
	Object.assign(process.env, values);
	try {
		await run();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function service(fetch: (input: Request) => Promise<Response>): {
	CINAAUTH_AUTH_SERVICE: Fetcher;
} {
	return { CINAAUTH_AUTH_SERVICE: { fetch } as unknown as Fetcher };
}

async function checkBody(response: Response): Promise<Record<string, unknown>> {
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "no-store");
	assert.equal(response.headers.get("Set-Cookie"), null);
	return response.json();
}

test("missing local authentication preserves the old response and makes no bridge request", async () => {
	let calls = 0;
	const result = await createAdminAuthCheckResponse(
		request,
		null,
		service(async () => {
			calls += 1;
			throw new Error("Must not verify an absent principal");
		})
	);
	assert.deepEqual(await checkBody(result), {
		authenticated: false,
		verification: "none",
	});
	assert.equal(calls, 0);
});

test("only live role verification adds the exact stored console subject; query cannot choose it", async () => {
	await configured(async () => {
		let calls = 0;
		const result = await createAdminAuthCheckResponse(
			request,
			principal,
			service(async (upstream) => {
				calls += 1;
				assert.equal(upstream.method, "POST");
				assert.equal(upstream.cache, "no-store");
				assert.deepEqual(await upstream.json(), { subject: "verified-user" });
				return Response.json({
					ok: true,
					user: { id: "verified-user", role: "security_admin" },
				});
			})
		);
		assert.deepEqual(await checkBody(result), {
			authenticated: true,
			principalType: "console",
			verification: "verified",
			subject: "verified-user",
		});
		assert.equal(calls, 1);
	});
});

test("a different bridge user cannot produce a verified subject even with an eligible role", async () => {
	await configured(async () => {
		const result = await createAdminAuthCheckResponse(
			request,
			principal,
			service(async () =>
				Response.json({
					ok: true,
					user: { id: "other-user", role: "security_admin" },
				})
			)
		);
		assert.deepEqual(await checkBody(result), {
			authenticated: false,
			verification: "rejected",
		});
	});
});

test("revoked live roles omit subject and reject the locally valid console", async () => {
	await configured(async () => {
		const result = await createAdminAuthCheckResponse(
			request,
			principal,
			service(async () =>
				Response.json({
					ok: true,
					user: { id: "verified-user", role: "user" },
				})
			)
		);
		assert.deepEqual(await checkBody(result), {
			authenticated: false,
			verification: "rejected",
		});
	});
});

test("bridge access rejection returns rejected without claiming a verified subject", async () => {
	await configured(async () => {
		const result = await createAdminAuthCheckResponse(
			request,
			principal,
			service(async () => new Response("Forbidden", { status: 403 }))
		);
		assert.deepEqual(await checkBody(result), {
			authenticated: false,
			verification: "rejected",
		});
	});
});

test("bridge outages retain degraded legacy validity but never expose verified subject", async () => {
	await configured(async () => {
		for (const unavailable of [
			async () => new Response("Unavailable", { status: 503 }),
			async () => new Response("Rate limited", { status: 429 }),
			async () => {
				throw new Error("private bridge failure");
			},
			async () => new Response("Not JSON"),
		]) {
			const result = await createAdminAuthCheckResponse(
				request,
				principal,
				service(unavailable)
			);
			assert.deepEqual(await checkBody(result), {
				authenticated: true,
				principalType: "console",
				verification: "degraded",
			});
		}
	});
});

test("API-key validity preserves compatibility but does not assert a console subject", async () => {
	let calls = 0;
	const key: AdminPrincipal = {
		type: "api_key",
		id: "admin_key:key-1",
		keyId: "key-1",
		permissions: ["*"],
	};
	const result = await createAdminAuthCheckResponse(
		request,
		key,
		service(async () => {
			calls += 1;
			throw new Error("API keys do not invoke CinaAuth console verification");
		})
	);
	assert.deepEqual(await checkBody(result), {
		authenticated: true,
		principalType: "api_key",
		verification: "verified",
	});
	assert.equal(calls, 0);
});

test("legacy local console usernames are rejected without fabricating a CinaAuth subject", async () => {
	let calls = 0;
	const result = await createAdminAuthCheckResponse(
		request,
		{ type: "console", id: "console:admin", username: "admin" },
		service(async () => {
			calls += 1;
			throw new Error("No subject is available");
		})
	);
	assert.deepEqual(await checkBody(result), {
		authenticated: false,
		verification: "rejected",
	});
	assert.equal(calls, 0);
});

test("every check revalidates live roles: outage and revoked role cannot reuse an earlier subject proof", async () => {
	await configured(async () => {
		let calls = 0;
		const upstream = service(async () => {
			calls += 1;
			if (calls === 2) return new Response("Unavailable", { status: 503 });
			return Response.json({
				ok: true,
				user: {
					id: "verified-user",
					role: calls === 3 ? "user" : "security_admin",
				},
			});
		});
		const first = await checkBody(
			await createAdminAuthCheckResponse(request, principal, upstream)
		);
		assert.equal(first.subject, "verified-user");
		const outage = await checkBody(
			await createAdminAuthCheckResponse(request, principal, upstream)
		);
		assert.equal(outage.verification, "degraded");
		assert.equal("subject" in outage, false);
		const revoked = await checkBody(
			await createAdminAuthCheckResponse(request, principal, upstream)
		);
		assert.deepEqual(revoked, {
			authenticated: false,
			verification: "rejected",
		});
		const recovered = await checkBody(
			await createAdminAuthCheckResponse(request, principal, upstream)
		);
		assert.equal(recovered.subject, "verified-user");
		assert.equal(recovered.verification, "verified");
		assert.equal(calls, 4);
	});
});
