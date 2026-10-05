import assert from "node:assert/strict";
import test from "node:test";
import { validateSharedKey } from "@/lib/shared-key-validation";

test("transport failures cannot persist an echoed credential", async (t) => {
	const secret = "sk-synthetic-validation-secret";
	t.mock.method(globalThis, "fetch", async () => {
		throw new TypeError(
			`Headers.append: Bearer ${secret} is not a valid header value`
		);
	});
	const result = await validateSharedKey("openai", secret);
	assert.deepEqual(result, {
		valid: false,
		inconclusive: true,
		reason: "validation request failed",
	});
	assert.equal(JSON.stringify(result).includes(secret), false);
});

test("cancelled validation stays inconclusive with a safe reason", async (t) => {
	t.mock.method(globalThis, "fetch", async () => {
		throw new DOMException("synthetic-private-error", "AbortError");
	});
	assert.deepEqual(
		await validateSharedKey("openai", "sk-synthetic-validation-secret"),
		{
			valid: false,
			inconclusive: true,
			reason: "validation request timed out",
		}
	);
});

test("provider responses preserve valid, rejected and unavailable distinctions", async (t) => {
	let status = 200;
	const requests: RequestInit[] = [];
	t.mock.method(
		globalThis,
		"fetch",
		async (_url: string, init: RequestInit) => {
			requests.push(init);
			return new Response(null, { status });
		}
	);
	for (const current of [200, 401, 403, 429, 503]) {
		status = current;
		const result = await validateSharedKey(
			"openai",
			"sk-synthetic-validation-secret"
		);
		assert.equal(result.valid, current === 200);
		assert.equal(result.inconclusive, current === 429 || current === 503);
		assert.equal(
			result.reason?.includes("sk-synthetic-validation-secret") ?? false,
			false
		);
	}
	assert.equal(requests.length, 5);
	assert.equal(requests[0].cache, "no-store");
	assert.equal(
		new Headers(requests[0].headers).get("authorization"),
		"Bearer sk-synthetic-validation-secret"
	);
});
