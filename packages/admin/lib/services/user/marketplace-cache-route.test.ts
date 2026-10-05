import assert from "node:assert/strict";
import test from "node:test";
import type { UserBindings } from "@/lib/user-env";
import { createUserApp } from "@/lib/user-app";
import { protectUserMarketplaceResponse } from "@/lib/user-marketplace-cache";

test("user marketplace authentication, setup failures and body-limit early returns stay private", async () => {
	for (const path of [
		"/user/shared-keys",
		"/user/shared-keys/key-1/revalidate",
		"/user/earnings/summary",
		"/user/earnings/unknown/child",
	]) {
		const anonymous = {
			STORAGE_CONTEXT: { repositories: {} },
		} as unknown as UserBindings;
		const unauthenticated = await createUserApp().request(path, {}, anonymous);
		assert.equal(unauthenticated.status, 401, path);
		assert.equal(
			unauthenticated.headers.get("cache-control"),
			"private, no-store"
		);
		const setupFailure = {
			...anonymous,
			USER_PRINCIPAL: {
				userId: "seller",
				subject: "subject:seller",
				email: "seller@example.test",
				isAdmin: false,
				capabilities: [],
			},
		} as UserBindings;
		const failed = await createUserApp().request(path, {}, setupFailure);
		assert.equal(failed.status, 500, path);
		assert.equal(failed.headers.get("cache-control"), "private, no-store");
		const body = JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) });
		const oversized = await createUserApp().request(
			path,
			{
				method: "POST",
				body,
				headers: {
					"Content-Type": "application/json",
					"Content-Length": String(Buffer.byteLength(body)),
				},
			},
			anonymous
		);
		assert.equal(oversized.status, 413, path);
		assert.equal(oversized.headers.get("cache-control"), "private, no-store");
	}
});

test("outer user marketplace policy protects every response without altering the original request or status", () => {
	for (const path of [
		"/api/user/shared-keys",
		"/api/user/shared-keys/",
		"/api/user/shared-keys/key-1/revalidate",
		"/api/user/earnings",
		"/api/user/earnings/summary",
		"/api/user/%73hared-keys",
		"/api/user/%2565arnings/summary",
	]) {
		for (const status of [200, 201, 400, 401, 403, 404, 413, 500, 503]) {
			const request = new Request(`https://gateway.example.test${path}`);
			const response = new Response("", {
				status,
				headers: { "Cache-Control": "public" },
			});
			assert.equal(protectUserMarketplaceResponse(request, response), response);
			assert.equal(
				response.headers.get("cache-control"),
				"private, no-store",
				path
			);
			assert.equal(response.status, status);
			assert.equal(request.url, `https://gateway.example.test${path}`);
		}
	}
	for (const path of [
		"/api/user/shared-keys-backup",
		"/api/user/shared-key",
		"/api/user/earnings-export",
		"/api/user/other/earnings",
	]) {
		const response = protectUserMarketplaceResponse(
			new Request(`https://gateway.example.test${path}`),
			new Response("", { headers: { "Cache-Control": "public" } })
		);
		assert.equal(response.headers.get("cache-control"), "public", path);
	}
});
