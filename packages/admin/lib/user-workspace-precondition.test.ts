import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type { WorkspaceAccessProjection } from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import {
	rejectUserWorkspacePrecondition,
	userWorkspacePrecondition,
	USER_WORKSPACE_PRECONDITION_HEADER,
} from "./user-workspace-precondition";

const workspace: WorkspaceAccessProjection = {
	id: "personal:user-1",
	name: "Personal",
	slug: "personal",
	description: null,
	scopeType: "personal",
	organizationId: null,
	organizationName: null,
	organizationSlug: null,
	personalOwnerUserId: "user-1",
	isDefault: true,
	status: "active",
	role: "owner",
	accessSource: "personal_owner",
	createdAt: "",
	updatedAt: "",
};

function fixture(authenticated = true) {
	let operations = 0;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		if (!authenticated) return c.json({ success: false }, 401);
		if (c.req.path !== "/user/auth/logout")
			c.set("workspaceContext", {
				workspaces: [workspace, { ...workspace, id: "workspace:team" }],
				currentWorkspace: workspace,
				preferredWorkspaceAvailable: true,
			});
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.all("/user/operation", (c) => {
		operations += 1;
		return c.json({
			success: true,
			workspaceId: c.get("workspaceContext").currentWorkspace.id,
		});
	});
	app.post("/user/auth/logout", (c) => c.json({ success: true }));
	return { app, operations: () => operations };
}

test("legacy clients with no precondition remain compatible", async () => {
	const { app, operations } = fixture();
	assert.equal(
		(await app.request("/user/operation", { method: "POST" })).status,
		200
	);
	assert.equal(operations(), 1);
});

test("matching encoded workspace allows requests after server authorization", async () => {
	const { app, operations } = fixture();
	const response = await app.request("/user/operation", {
		headers: {
			[USER_WORKSPACE_PRECONDITION_HEADER]: encodeURIComponent(workspace.id),
		},
	});
	assert.equal(response.status, 200);
	assert.equal(operations(), 1);
});

test("a stale precondition blocks reads and writes even when that workspace is also authorized", async () => {
	for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
		const { app, operations } = fixture();
		const response = await app.request("/user/operation", {
			method,
			headers: {
				[USER_WORKSPACE_PRECONDITION_HEADER]:
					encodeURIComponent("workspace:team"),
			},
		});
		assert.equal(response.status, 409);
		assert.equal(operations(), 0);
		assert.equal(
			((await response.json()) as { code: string }).code,
			"workspace_mismatch"
		);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	}
});

test("malformed, duplicated, oversized and control-bearing preconditions never reach route operations", async () => {
	for (const header of [
		"",
		"%invalid",
		"%00",
		"%0A",
		"personal%3Auser-1, workspace%3Ateam",
		"x".repeat(601),
		"%20user-1%20",
	]) {
		const { app, operations } = fixture();
		const response = await app.request("/user/operation", {
			method: "POST",
			headers: {
				[USER_WORKSPACE_PRECONDITION_HEADER]: header,
			},
		});
		assert.equal(response.status, 400, header);
		assert.equal(operations(), 0);
	}
});

test("the precondition cannot authenticate or establish membership", async () => {
	const { app, operations } = fixture(false);
	assert.equal(
		(
			await app.request("/user/operation", {
				method: "POST",
				headers: {
					[USER_WORKSPACE_PRECONDITION_HEADER]: encodeURIComponent(
						workspace.id
					),
				},
			})
		).status,
		401
	);
	assert.equal(operations(), 0);
});

test("workspace preference loss does not prevent browser session logout", async () => {
	const { app } = fixture();
	assert.equal(
		(
			await app.request("/user/auth/logout", {
				method: "POST",
				headers: {
					[USER_WORKSPACE_PRECONDITION_HEADER]: "%invalid",
				},
			})
		).status,
		200
	);
});

test("opaque Unicode workspace ids round-trip without becoming membership authority", () => {
	const id = "workspace:团队/100%";
	const request = new Request("https://cinatoken.example/user/operation", {
		headers: { [USER_WORKSPACE_PRECONDITION_HEADER]: encodeURIComponent(id) },
	});
	assert.equal(rejectUserWorkspacePrecondition(request, id), null);
	assert.equal(
		rejectUserWorkspacePrecondition(request, workspace.id)?.status,
		409
	);
});
