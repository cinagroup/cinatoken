import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import type {
	GatewayRepositories,
	SharedKeyEarningRow,
	UserEarningsRow,
	WorkspaceAccessProjection,
} from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userEarningsRoutes } from "@/lib/routes/user/earnings";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";
import { getAccountCapabilities } from "@/lib/unified-session";

const summary: UserEarningsRow = {
	userId: "seller-1",
	balance: 1.234567,
	lockedAmount: 0.5,
	lifetimeEarned: 10.25,
	lifetimeWithdrawn: 8.515433,
	contributionValue: 10.25,
	walletAddress: null,
	walletVerifiedAt: null,
	highestBadgeTier: 0,
	updatedAt: "2026-09-27 09:00:00",
};
const earning: SharedKeyEarningRow = {
	id: "earning-1",
	sellerUserId: "seller-1",
	requestLogId: "request-1",
	sharedKeyId: "shared-1",
	inputTokens: 10,
	outputTokens: 5,
	cacheReadTokens: 2,
	cacheWriteTokens: 1,
	grossAmount: 0.123456,
	platformFee: 0.012346,
	netAmount: 0.11111,
	currency: "USD",
	createdAt: summary.updatedAt,
};
type Metadata = {
	sellerUserId: string;
	workspaceId: string;
	earningsCurrency: string;
	amountUnit: string;
};
type SummaryResponse = Metadata & {
	data: UserEarningsRow | null;
	availability: string;
};
type ListResponse = Metadata & {
	data: SharedKeyEarningRow[];
	total: number;
	page: number;
	pageSize: number;
};
function fixture(
	options: {
		missing?: boolean;
		organization?: boolean;
		userId?: string;
		total?: number;
		capabilities?: ReturnType<typeof getAccountCapabilities>;
		isAdmin?: boolean;
		organizationAdmin?: boolean;
	} = {}
) {
	const calls: unknown[][] = [];
	const userId = options.userId ?? "seller-1";
	const workspace = {
		id: "workspace-1",
		scopeType: options.organization ? "organization" : "personal",
		organizationId: options.organization ? "organization-1" : null,
		role: options.organizationAdmin ? "admin" : "owner",
		organizationRoles: options.organizationAdmin ? ["billing-admin"] : [],
	} as WorkspaceAccessProjection;
	const repositories = {
		portalLedger: {
			ensureUserEarnings: async (id: string) => {
				calls.push(["ensure", id]);
			},
			getUserEarnings: async (id: string) => {
				calls.push(["summary", id]);
				return options.missing ? null : { ...summary, userId: id };
			},
			listEarningsBySeller: async (
				id: string,
				page: number,
				pageSize: number
			) => {
				calls.push(["list", id, page, pageSize]);
				return {
					rows: [{ ...earning, sellerUserId: id }],
					total: options.total ?? 1,
				};
			},
		},
		systemConfig: {
			getConfig: async () => {
				throw new Error(
					"Deployment billing currency must not label the seller ledger"
				);
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.set("repositories", repositories);
		c.set("principal", {
			userId,
			subject: `subject:${userId}`,
			email: "seller@example.test",
			isAdmin: options.isAdmin ?? false,
			capabilities:
				options.capabilities ??
				getAccountCapabilities(options.isAdmin ?? false),
		});
		c.set("workspaceContext", {
			workspaces: [workspace],
			currentWorkspace: workspace,
			preferredWorkspaceAvailable: true,
		});
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/earnings", userEarningsRoutes);
	return { app, calls };
}

test("summary publishes seller identity and USD major units without converting repository amounts again", async () => {
	const { app, calls } = fixture();
	const response = await app.request("/earnings/summary");
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as SummaryResponse;
	assert.deepEqual(body.data, summary);
	assert.ok(body.data);
	assert.equal(body.data.balance, 1.234567);
	assert.equal(body.sellerUserId, "seller-1");
	assert.equal(body.workspaceId, "workspace-1");
	assert.equal(body.earningsCurrency, "USD");
	assert.equal(body.amountUnit, "major");
	assert.equal(body.availability, "available");
	assert.deepEqual(calls, [
		["ensure", "seller-1"],
		["summary", "seller-1"],
	]);
});

test("missing ledger remains null and unavailable instead of being reported as zero", async () => {
	const { app } = fixture({ missing: true });
	const response = await app.request("/earnings/summary");
	const body = (await response.json()) as SummaryResponse;
	assert.equal(body.data, null);
	assert.equal(body.availability, "unavailable");
	assert.equal(body.sellerUserId, "seller-1");
});

test("organization workspace does not redirect seller ownership to the organization", async () => {
	const { app, calls } = fixture({
		organization: true,
		userId: "seller-2",
		total: 41,
	});
	const response = await app.request("/earnings?page=2&pageSize=20");
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	const body = (await response.json()) as ListResponse;
	assert.deepEqual(calls, [["list", "seller-2", 2, 20]]);
	assert.equal(body.sellerUserId, "seller-2");
	assert.equal(body.data[0].sellerUserId, "seller-2");
	assert.equal(body.data[0].currency, "USD");
	assert.equal(body.total, 41);
	assert.equal(body.page, 2);
	assert.equal(body.pageSize, 20);
});

test("legacy pagination clamps remain unchanged and metadata is additive", async () => {
	const { app, calls } = fixture();
	const response = await app.request("/earnings?page=0&pageSize=1000");
	const body = (await response.json()) as ListResponse;
	assert.deepEqual(calls, [["list", "seller-1", 1, 100]]);
	assert.deepEqual(body.data, [earning]);
	assert.equal(body.earningsCurrency, "USD");
	assert.equal(body.amountUnit, "major");
});

test("workspace mismatch or invalid precondition prevents all ledger reads", async () => {
	for (const [header, status] of [
		["different-workspace", 409],
		["%00", 400],
	] as const) {
		const { app, calls } = fixture();
		const response = await app.request("/earnings/summary", {
			headers: { "X-CinaToken-Workspace": header },
		});
		assert.equal(response.status, status);
		assert.deepEqual(calls, []);
	}
});

for (const scenario of [
	{ name: "ordinary account.read", capabilities: ["account.read"] as const },
	{
		name: "console administrator",
		capabilities: ["account.read", "admin.console"] as const,
		isAdmin: true,
	},
	{
		name: "organization administrator",
		capabilities: ["account.read"] as const,
		organization: true,
		organizationAdmin: true,
	},
]) {
	test(`${scenario.name} cannot read or ensure any ledger without earnings.read`, async () => {
		for (const path of ["/earnings/summary", "/earnings?page=1&pageSize=20"]) {
			const { app, calls } = fixture({
				...scenario,
				capabilities: [...scenario.capabilities],
			});
			const response = await app.request(path, {
				headers: { "X-CinaToken-Workspace": "workspace-1" },
			});
			assert.equal(response.status, 403);
			assert.equal(response.headers.get("Cache-Control"), "private, no-store");
			assert.deepEqual(await response.json(), {
				success: false,
				message: "Earnings access is not available",
			});
			assert.deepEqual(calls, []);
		}
	});
}
