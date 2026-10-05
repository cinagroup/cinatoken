import assert from "node:assert/strict";
import test from "node:test";
import { logUnauthorizedAdminRequest } from "@/lib/security-log";

function captureUnauthorized(request: Request) {
	const warnings: string[] = [];
	const previous = console.warn;
	try {
		console.warn = (value: unknown) => warnings.push(String(value));
		logUnauthorizedAdminRequest(request);
	} finally {
		console.warn = previous;
	}
	assert.equal(warnings.length, 1);
	return {
		line: warnings[0],
		payload: JSON.parse(warnings[0]) as Record<string, unknown>,
	};
}

test("the BFF unauthenticated log helper omits secret-shaped Key IDs, query and body", () => {
	const secret = "sk-synthetic-original-secret-in-invalid-url";
	const hash = "hashref:sha256:" + "a".repeat(64);
	for (const id of [
		"key-1",
		secret,
		hash,
		encodeURIComponent(hash),
		secret + "%2Fextra",
	]) {
		const request = new Request(
			"https://admin.invalid/api/admin/keys/" +
				id +
				"/verify-secret?secret=" +
				secret,
			{ method: "POST", body: JSON.stringify({ secret }) }
		);
		const { line, payload } = captureUnauthorized(request);
		assert.equal(payload.event, "admin.auth.unauthorized");
		assert.equal(payload.path, "/api/admin/keys/:id/verify-secret");
		assert.equal(payload.method, "POST");
		assert.equal("key_prefix" in payload, false);
		for (const value of [secret, hash, encodeURIComponent(hash), "secret="])
			assert.equal(line.includes(value), false);
		assert.equal(request.bodyUsed, false);
	}
});

test("encoded binding endpoints and trailing slashes have the same nonsecret log path", () => {
	const secret = "sk-synthetic-encoded-path-secret";
	for (const path of [
		"/api/admin/keys/" + secret + "/verify-secret/",
		"/api/admin/keys/" + secret + "/verify%2Dsecret",
		"/api/admin/keys/" + secret + "/verify%252Dsecret",
		"/api/admin/%6Beys/" + secret + "/verify-secret",
		"/api/admin/keys/" + secret + "%ZZ/verify-secret",
	]) {
		const { line, payload } = captureUnauthorized(
			new Request("https://admin.invalid" + path)
		);
		assert.equal(payload.path, "/api/admin/keys/:id/verify-secret");
		assert.equal(line.includes(secret), false);
	}
});

test("other unauthorized paths and the existing Bearer prefix and client metadata stay unchanged", () => {
	const bearer = "sk-synthetic-admin-key-with-long-secret";
	for (const path of [
		"/api/admin/models",
		"/api/admin/keys/key-1/logs",
		"/api/admin/keys/key-1/verify-secret-neighbor",
	]) {
		const { line, payload } = captureUnauthorized(
			new Request(
				"https://admin.invalid" + path + "?secret=sk-private-query-only",
				{
					method: "GET",
					headers: {
						authorization: "Bearer " + bearer,
						"cf-connecting-ip": "192.0.2.1",
						"user-agent": "synthetic-agent",
					},
				}
			)
		);
		assert.equal(payload.path, path);
		assert.equal(payload.method, "GET");
		assert.equal(payload.key_prefix, bearer.slice(0, 12));
		assert.equal(payload.client_ip, "192.0.2.1");
		assert.equal(payload.user_agent, "synthetic-agent");
		assert.equal(line.includes(bearer), false);
		assert.equal(line.includes("sk-private-query-only"), false);
	}
});
