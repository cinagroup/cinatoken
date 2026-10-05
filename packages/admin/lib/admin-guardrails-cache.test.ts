import assert from "node:assert/strict";
import test from "node:test";
import { protectAdminConfigResponse } from "./admin-config-cache";

test("Guardrails and config early failures override cacheability even before Hono routes run", () => {
	for (const path of [
		"/api/admin/guardrails",
		"/api/admin/guardrails/",
		"/api/admin/guardrails/summaries",
		"/api/admin/guardrails/guardrail-1/version-summaries",
		"/api/admin/config/overview",
		"/api/admin/config/overview/",
		"/api/admin/config/overview-extra",
	]) {
		for (const status of [400, 401, 403, 404, 409, 500, 503]) {
			const response = protectAdminConfigResponse(
				new Request(`https://admin.example.test${path}`),
				Response.json(
					{ success: false },
					{
						status,
						headers: { "Cache-Control": "public, max-age=600" },
					}
				)
			);
			assert.equal(response.status, status);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
		}
	}
});

test("similarly named routes are not captured by sensitive-prefix cache handling", () => {
	for (const path of [
		"/api/admin/guardrails-extra",
		"/api/admin/config-extra",
		"/api/admin/other",
	]) {
		const response = protectAdminConfigResponse(
			new Request(`https://admin.example.test${path}`),
			Response.json({ success: false }, { status: 403 })
		);
		assert.equal(response.headers.get("cache-control"), null, path);
	}
});
