import assert from "node:assert/strict";
import { test } from "node:test";
import type { D1Database } from "@cloudflare/workers-types";
import { resolveAdminRequestRuntime } from "@/lib/admin-request-runtime";

test("actual Cloudflare Tools guard binding never inherits a Node process override", async () => {
	const before = process.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION;
	process.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION = "true";
	try {
		for (const configured of ["false", "true", undefined]) {
			let databaseCalls = 0;
			const request = new Request(
				"https://test.example/api/admin/config/tools/overview"
			) as Request & { env: unknown };
			request.env = {
				DB: {
					prepare() {
						databaseCalls++;
						throw new Error("Runtime must not query storage");
					},
				} as unknown as D1Database,
				SHARED_KEY_ENCRYPTION_SECRET:
					"test-only-tools-runtime-secret-0123456789",
				...(configured === undefined
					? {}
					: { CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION: configured }),
			};
			const resolved = await resolveAdminRequestRuntime(request);
			assert.equal(
				resolved.bindings.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION,
				configured
			);
			assert.equal(resolved.storage.client.driver, "d1");
			assert.equal(databaseCalls, 0);
		}
	} finally {
		if (before === undefined)
			delete process.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION;
		else process.env.CINATOKEN_ADMIN_TOOLS_REQUIRE_VERSION = before;
	}
});
