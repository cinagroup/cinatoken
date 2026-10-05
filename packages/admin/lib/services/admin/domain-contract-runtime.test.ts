import assert from "node:assert/strict";
import test from "node:test";
import type { D1Database } from "@cloudflare/workers-types";
import { resolveAdminRequestRuntime } from "@/lib/admin-request-runtime";

test("model policy guard uses actual Cloudflare binding and never inherits Node process override", async () => {
	const before =
		process.env.CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION;
	process.env.CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION = "true";
	try {
		for (const configured of [undefined, "false", "true"]) {
			let databaseCalls = 0;
			const request = new Request(
				"https://test.invalid/api/admin/models"
			) as Request & { env: unknown };
			request.env = {
				DB: {
					prepare() {
						databaseCalls++;
						throw new Error("No database read allowed");
					},
				} as unknown as D1Database,
				SHARED_KEY_ENCRYPTION_SECRET:
					"test-only-domain-runtime-secret-0123456789",
				...(configured === undefined
					? {}
					: {
							CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION:
								configured,
					  }),
			};
			const result = await resolveAdminRequestRuntime(request);
			assert.equal(
				result.bindings
					.CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION,
				configured
			);
			assert.equal(databaseCalls, 0);
		}
	} finally {
		if (before === undefined)
			delete process.env
				.CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION;
		else
			process.env.CINATOKEN_ADMIN_MODELS_REQUIRE_ROUTE_POLICY_PRECONDITION =
				before;
	}
});
