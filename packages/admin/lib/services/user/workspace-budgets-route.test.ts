import assert from "node:assert/strict";
import test from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type {
	D1DatabaseClient,
	GatewayRepositories,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import { Hono } from "hono";
import { userWorkspaceBudgetsRoutes } from "@/lib/routes/user/workspace-budgets";
import type { UserEnv } from "@/lib/user-env";
import { getAccountCapabilities } from "@/lib/unified-session";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";

class SqliteD1Statement {
	constructor(
		private readonly state: FakeD1State,
		private readonly sql: string,
		private readonly values: unknown[] = []
	) {}

	bind(...values: unknown[]): D1PreparedStatement {
		return new SqliteD1Statement(
			this.state,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}

	run(): D1Result {
		if (this.sql.includes("INSERT INTO workspace_budgets")) {
			const [id, workspaceId, interval, limitMicros, createdAt, updatedAt] =
				this.values as [string, string, string, number, string, string];
			const existing = this.state.budgets.get(interval);
			this.state.budgets.set(interval, {
				id: existing?.id ?? id,
				workspace_id: workspaceId,
				reset_interval: interval,
				limit_micros: limitMicros,
				config_epoch: existing ? existing.config_epoch + 1 : 0,
				workspace_created_at: this.state.createdAt,
				created_at: existing?.created_at ?? createdAt,
				updated_at: updatedAt,
			});
		}
		if (this.sql.includes("DELETE FROM workspace_budgets")) {
			this.state.budgets.delete(String(this.values[1]));
		}
		return {
			success: true,
			results: [],
			meta: { changes: 1 },
		} as unknown as D1Result;
	}

	first<T>(): T | null {
		if (this.sql.includes("FROM guardrail_budget_windows")) return null;
		if (this.sql.includes("FROM api_key_request_logs"))
			return { spent_micros: 0 } as T;
		return (
			this.state.workspaceExists ? { id: "workspace-1" } : null
		) as T | null;
	}

	all<T>(): D1Result<T> {
		const order = ["daily", "weekly", "monthly", "lifetime"];
		const results = [...this.state.budgets.values()].sort(
			(left, right) =>
				order.indexOf(left.reset_interval) - order.indexOf(right.reset_interval)
		) as T[];
		return { success: true, results, meta: {} } as unknown as D1Result<T>;
	}
}

type FakeBudget = {
	id: string;
	workspace_id: string;
	reset_interval: string;
	limit_micros: number;
	config_epoch: number;
	workspace_created_at: string;
	created_at: string;
	updated_at: string;
};

type FakeD1State = {
	workspaceExists: boolean;
	createdAt: string;
	budgets: Map<string, FakeBudget>;
	queryCount: number;
};

function workspace(
	role: "owner" | "admin" | "member"
): WorkspaceAccessProjection {
	return {
		id: "workspace-1",
		name: "Production",
		slug: "production",
		description: null,
		scopeType: role === "owner" ? "personal" : "organization",
		organizationId: role === "owner" ? null : "org-1",
		organizationName: role === "owner" ? null : "Example Org",
		organizationSlug: role === "owner" ? null : "example-org",
		personalOwnerUserId: role === "owner" ? "user-1" : null,
		isDefault: true,
		status: "active",
		role,
		accessSource: role === "owner" ? "personal_owner" : "organization_default",
		createdAt: "2026-08-31T00:00:00.000Z",
		updatedAt: "2026-08-31T00:00:00.000Z",
	};
}

function fixture(
	role: "owner" | "admin" | "member",
	options: {
		organizationRoles?: string[];
		configuredRoles?: string;
		billingCurrency?: string;
	} = {}
) {
	const state: FakeD1State = {
		workspaceExists: true,
		createdAt: "2026-08-31T00:00:00.000Z",
		budgets: new Map(),
		queryCount: 0,
	};
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			state.queryCount++;
			return new SqliteD1Statement(
				state,
				sql
			) as unknown as D1PreparedStatement;
		},
	} as unknown as D1Database;
	const client: D1DatabaseClient = {
		driver: "d1",
		raw,
		drizzle: {} as D1DatabaseClient["drizzle"],
	};
	const repositories = {
		client,
		systemConfig: { getConfig: async () => options.billingCurrency ?? "cny" },
	} as unknown as GatewayRepositories;
	const currentWorkspace = workspace(role);
	currentWorkspace.organizationRoles = options.organizationRoles;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.env = { CINAAUTH_ORGANIZATION_ADMIN_ROLES: options.configuredRoles };
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
			subject: "subject-1",
			email: "user@example.com",
			isAdmin: false,
			capabilities: getAccountCapabilities(false),
		});
		c.set("workspaceContext", {
			workspaces: [currentWorkspace],
			currentWorkspace,
			preferredWorkspaceAvailable: true,
		});
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/workspace-budgets", userWorkspaceBudgetsRoutes);
	return { app, state };
}

test("Workspace members can view budgets but cannot mutate them", async () => {
	const { app } = fixture("member");
	const listed = await app.request("/workspace-budgets");
	assert.equal(listed.status, 200);
	assert.deepEqual(await listed.json(), {
		success: true,
		data: [],
		workspaceId: "workspace-1",
		billingCurrency: "CNY",
		canManage: false,
	});
	const denied = await app.request("/workspace-budgets/daily", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ limit_usd: 10 }),
	});
	assert.equal(denied.status, 403);
});

test("Workspace owner/admin can manage limits and ordering is fail-closed", async () => {
	for (const role of ["owner", "admin"] as const) {
		const { app } = fixture(role);
		for (const [interval, limit] of [
			["daily", 10],
			["monthly", 100],
		] as const) {
			const response = await app.request(`/workspace-budgets/${interval}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ limit_usd: limit }),
			});
			assert.equal(response.status, 200, `${role} must manage ${interval}`);
			const body = (await response.json()) as {
				data: Record<string, unknown>;
				workspaceId: string;
				billingCurrency: string;
			};
			assert.equal(body.workspaceId, "workspace-1");
			assert.equal(body.billingCurrency, "CNY");
			assert.equal(body.data.spentUsd, 0);
			assert.equal(body.data.reservedUsd, 0);
			assert.equal(body.data.remainingUsd, limit);
			assert.equal(typeof body.data.periodStart, "string");
			assert.equal(typeof body.data.periodEnd, "string");
		}
		const invalid = await app.request("/workspace-budgets/weekly", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ limit_usd: 5 }),
		});
		assert.equal(invalid.status, 400);
		assert.match(
			((await invalid.json()) as { message: string }).message,
			/lifetime > monthly > weekly > daily/u
		);

		const deleted = await app.request("/workspace-budgets/daily", {
			method: "DELETE",
		});
		assert.equal(deleted.status, 200);
		assert.deepEqual(await deleted.json(), { success: true, deleted: true });
	}
});

test("budget management metadata uses authoritative configured organization roles", async () => {
	for (const allowed of [false, true]) {
		const { app, state } = fixture("member", {
			organizationRoles: ["billing-manager"],
			configuredRoles: allowed ? "billing-manager" : "other-manager",
		});
		const listed = await app.request("/workspace-budgets");
		assert.equal(
			((await listed.json()) as { canManage: boolean }).canManage,
			allowed
		);
		const response = await app.request("/workspace-budgets/daily", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ limit_usd: 0.0000005 }),
		});
		assert.equal(response.status, allowed ? 200 : 403);
		assert.equal(state.budgets.size, allowed ? 1 : 0);
	}
});

test("empty budget lists expose server scope and normalize billing currency without changing limits", async () => {
	for (const [raw, normalized] of [
		["usd", "USD"],
		["eur", "EUR"],
		["invalid-currency", "USD"],
	] as const) {
		const { app } = fixture("owner", { billingCurrency: raw });
		const listed = await app.request("/workspace-budgets");
		assert.equal(listed.headers.get("cache-control"), "private, no-store");
		assert.deepEqual(await listed.json(), {
			success: true,
			data: [],
			workspaceId: "workspace-1",
			billingCurrency: normalized,
			canManage: true,
		});
	}
});

test("budget scope mismatch and malformed preconditions block every read or mutation before SQL access", async () => {
	const { app, state } = fixture("owner");
	for (const [header, status] of [
		["workspace-other", 409],
		["%broken", 400],
	] as const) {
		for (const method of ["GET", "PUT", "DELETE"]) {
			const response = await app.request(
				method === "GET" ? "/workspace-budgets" : "/workspace-budgets/daily",
				{
					method,
					headers: {
						"X-CinaToken-Workspace": header,
						"content-type": "application/json",
					},
					...(method === "PUT"
						? { body: JSON.stringify({ limit_usd: 10 }) }
						: {}),
				}
			);
			assert.equal(response.status, status);
		}
	}
	assert.equal(state.queryCount, 0);
	assert.equal(state.budgets.size, 0);
});
