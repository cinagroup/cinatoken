import assert from "node:assert/strict";
import test from "node:test";
import {
	checkBrowserMutationOrigin,
	rejectInvalidAdminMutationOrigin,
} from "./browser-mutation";

const APP_ORIGIN = "https://cinatoken.com";

test("allows safe methods without an Origin header", () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(new Request(`${APP_ORIGIN}/api/user/me`)),
		{ allowed: true }
	);
});

test("allows an exact same-origin mutation", () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: "POST",
				headers: { origin: APP_ORIGIN, "sec-fetch-site": "same-origin" },
			})
		),
		{ allowed: true }
	);
});

test("accepts the public Host origin rather than the Next listening origin", () => {
	const request = new Request("http://localhost:8789/api/auth/logout", {
		method: "POST",
		headers: { host: "127.0.0.1:8791", origin: "http://127.0.0.1:8791" },
	});
	assert.deepEqual(checkBrowserMutationOrigin(request), { allowed: true });
});

test("rejects a listening origin that differs from the public authority", () => {
	const request = new Request("http://localhost:8789/api/auth/logout", {
		method: "POST",
		headers: { host: "127.0.0.1:8791", origin: "http://localhost:8789" },
	});
	assert.deepEqual(checkBrowserMutationOrigin(request), {
		allowed: false,
		reason: "origin_mismatch",
	});
});

test("does not accept a forged forwarding Host as browser origin", () => {
	const request = new Request("https://localhost:8789/api/auth/logout", {
		method: "POST",
		headers: {
			host: "cinatoken.com",
			"x-forwarded-host": "attacker.example",
			origin: "https://attacker.example",
		},
	});
	assert.deepEqual(checkBrowserMutationOrigin(request), {
		allowed: false,
		reason: "origin_mismatch",
	});
});

test("fails closed for malformed Host even when the listening Origin matches", () => {
	const request = new Request("http://localhost:8789/api/auth/logout", {
		method: "POST",
		headers: {
			host: "cinatoken.com,attacker.example",
			origin: "http://localhost:8789",
		},
	});
	assert.deepEqual(checkBrowserMutationOrigin(request), {
		allowed: false,
		reason: "origin_mismatch",
	});
});

test("preserves exact public scheme and port checks", () => {
	for (const origin of ["https://127.0.0.1:8791", "http://127.0.0.1:8789"]) {
		assert.deepEqual(
			checkBrowserMutationOrigin(
				new Request("http://localhost:8789/api/auth/logout", {
					method: "POST",
					headers: { host: "127.0.0.1:8791", origin },
				})
			),
			{ allowed: false, reason: "origin_mismatch" }
		);
	}
});

test("rejects a mutation with no Origin header", () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, { method: "POST" })
		),
		{ allowed: false, reason: "missing_origin" }
	);
});

test("rejects a cross-origin mutation", () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: "POST",
				headers: { origin: "https://attacker.example" },
			})
		),
		{ allowed: false, reason: "origin_mismatch" }
	);
});

test("rejects an explicitly cross-site request even when Origin is forged in a test client", () => {
	assert.deepEqual(
		checkBrowserMutationOrigin(
			new Request(`${APP_ORIGIN}/api/user/wallet`, {
				method: "POST",
				headers: { origin: APP_ORIGIN, "sec-fetch-site": "cross-site" },
			})
		),
		{ allowed: false, reason: "cross_site" }
	);
});

test("preserves cross-origin mutations authenticated by a named admin API key", () => {
	const request = new Request(`${APP_ORIGIN}/api/admin/providers`, {
		method: "POST",
		headers: {
			origin: "https://automation.example",
			authorization: "Bearer sk-admin-test",
		},
	});
	assert.equal(rejectInvalidAdminMutationOrigin(request, "api_key"), null);
});

test("blocks the same attacker request when authentication came from a console cookie", async () => {
	const request = new Request(`${APP_ORIGIN}/api/admin/providers`, {
		method: "POST",
		headers: {
			origin: "https://attacker.example",
			cookie: "admin_session=stolen",
		},
	});
	const response = rejectInvalidAdminMutationOrigin(request, "console");
	assert.equal(response?.status, 403);
	assert.deepEqual(await response?.json(), {
		success: false,
		message: "Forbidden: invalid request origin",
	});
});
