import assert from "node:assert/strict";
import test from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type {
	ApiKeyRow,
	GatewayRepositories,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import { Hono } from "hono";
import { getAccountCapabilities } from "@/lib/unified-session";
import type { UserEnv } from "@/lib/user-env";
import { userGatewayKeysRoutes } from "@/lib/routes/user/gateway-keys";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";

class CapturingStatement {
	values: unknown[] = [];
	constructor(readonly sql: string) {}
	bind(...values: unknown[]): D1PreparedStatement {
		this.values = values;
		return this as unknown as D1PreparedStatement;
	}
}

const workspace: WorkspaceAccessProjection = {
	id: "personal:user-1",
	name: "Default",
	slug: "default",
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
	createdAt: "2026-08-31T00:00:00.000Z",
	updatedAt: "2026-08-31T00:00:00.000Z",
};

function fixture(
	rows: Pick<
		ApiKeyRow,
		| "id"
		| "key"
		| "workspace_id"
		| "name"
		| "status"
		| "limit_micros"
		| "limit_reset"
		| "expires_at"
		| "last_used_at"
		| "created_at"
	>[] = []
) {
	const batches: CapturingStatement[][] = [];
	const raw = {
		prepare: (sql: string) =>
			new CapturingStatement(sql) as unknown as D1PreparedStatement,
		async batch(statements: D1PreparedStatement[]) {
			batches.push(statements as unknown as CapturingStatement[]);
			return statements.map(
				() => ({ success: true, results: [], meta: {} } as unknown as D1Result)
			);
		},
	} as unknown as D1Database;
	const repositories = {
		systemConfig: { getConfig: async () => " cny " },
		apiKeys: {
			listKeysByWorkspaceId: async (
				workspaceId: string,
				options: { creatorUserId: string }
			) => {
				assert.equal(workspaceId, workspace.id);
				assert.equal(options.creatorUserId, "user-1");
				return rows;
			},
		},
		client: { driver: "d1", raw, drizzle: {} },
		users: {
			getById: async () => ({
				id: "user-1",
				email: "user@example.com",
				budget_max: null,
				budget_base: 0,
				budget_spent: 0,
				budget_period: "none",
				budget_reset_at: null,
				budget_epoch: 0,
				budget_reserved_micros: 0,
				status: "active",
				metadata: null,
				charged_cost_factors: null,
				external_system: "cinaauth",
				external_user_id: "subject-1",
				created_at: "2026-08-31T00:00:00.000Z",
				updated_at: "2026-08-31T00:00:00.000Z",
			}),
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
			subject: "subject-1",
			email: "user@example.com",
			isAdmin: false,
			capabilities: getAccountCapabilities(false),
		});
		c.set("workspaceContext", {
			workspaces: [workspace],
			currentWorkspace: workspace,
			preferredWorkspaceAvailable: true,
		});
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/gateway-keys", userGatewayKeysRoutes);
	return { app, batches };
}

test("portal stores a canonical future Gateway Key expiry", async () => {
	const { app, batches } = fixture();
	const response = await app.request("/gateway-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			name: "CI",
			expires_at: "2099-01-01T00:00:00.000Z",
			limit: 10,
			limit_reset: "weekly",
		}),
	});
	assert.equal(response.status, 200);
	const keyInsert = batches[0]?.find((statement) =>
		statement.sql.includes("INSERT INTO api_keys")
	);
	assert.ok(keyInsert);
	assert.equal(keyInsert.values[9], "2099-01-01T00:00:00.000Z");
	assert.equal(keyInsert.values[10], 10_000_000);
	assert.equal(keyInsert.values[11], "weekly");
});

test("portal rejects expired or non-canonical Gateway Key expiry", async () => {
	for (const expiresAt of [
		"2020-01-01T00:00:00.000Z",
		"2099-01-01T00:00:00Z",
	]) {
		const { app, batches } = fixture();
		const response = await app.request("/gateway-keys", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: "Invalid", expires_at: expiresAt }),
		});
		assert.equal(response.status, 400);
		assert.equal(batches.length, 0);
	}
});

test("portal rejects an invalid Gateway Key limit", async () => {
	const { app, batches } = fixture();
	const response = await app.request("/gateway-keys", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ name: "Invalid", limit: -1 }),
	});
	assert.equal(response.status, 400);
	assert.equal(batches.length, 0);
});

test("empty gateway list identifies the authorized workspace and normalized billing currency", async () => {
	const { app } = fixture();
	const response = await app.request("/gateway-keys");
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		success: true,
		data: [],
		workspaceId: workspace.id,
		billingCurrency: "CNY",
	});
});

test("gateway listings preserve disabled state while exposing only a masked credential", async () => {
	const secret = `sk-${"a".repeat(32)}`;
	const { app } = fixture([
		{
			id: "key-1",
			key: secret,
			workspace_id: workspace.id,
			name: "Disabled",
			status: "disabled",
			limit_micros: 1,
			limit_reset: "monthly",
			expires_at: null,
			last_used_at: null,
			created_at: "",
		},
	]);
	const response = await app.request("/gateway-keys");
	const body = (await response.json()) as {
		data: { key: string; status: string; limit: number }[];
	};
	assert.equal(body.data[0]?.status, "disabled");
	assert.equal(body.data[0]?.limit, 0.000001);
	assert.equal(body.data[0]?.key, `${secret.slice(0, 8)}…${secret.slice(-4)}`);
	assert.equal(JSON.stringify(body).includes(secret), false);
});

test("stale workspace prevents gateway creation before any storage batch", async () => {
	const { app, batches } = fixture();
	const response = await app.request("/gateway-keys", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-CinaToken-Workspace": encodeURIComponent("workspace:team"),
		},
		body: JSON.stringify({ name: "Do not create" }),
	});
	assert.equal(response.status, 409);
	assert.equal(batches.length, 0);
});
