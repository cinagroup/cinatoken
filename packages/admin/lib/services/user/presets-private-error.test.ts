import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { GatewayRepositories } from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userPresetsRoutes } from "@/lib/routes/user/presets";

test("preset save failure never echoes private configuration into responses or server logs", async () => {
	const secret = "private-preset-prompt-value";
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("principal", {
			userId: "owner",
			subject: "owner",
			email: "owner@example.test",
			isAdmin: false,
			capabilities: ["account.read"],
		});
		c.set("workspaceContext", {
			workspaces: [],
			currentWorkspace: { id: "workspace" },
		} as unknown as UserEnv["Variables"]["workspaceContext"]);
		c.set("repositories", {
			requestPresets: {
				getBySlug: async () => {
					throw new Error(secret);
				},
			},
		} as unknown as GatewayRepositories);
		await next();
	});
	app.route("/presets", userPresetsRoutes);
	const messages: unknown[][] = [];
	const original = console.error;
	console.error = (...parts: unknown[]) => {
		messages.push(parts);
	};
	try {
		const response = await app.request("/presets", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ slug: "good", systemPrompt: secret, config: {} }),
		});
		assert.equal(response.status, 409);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		assert.equal((await response.text()).includes(secret), false);
		assert.equal(JSON.stringify(messages).includes(secret), false);
	} finally {
		console.error = original;
	}
});
