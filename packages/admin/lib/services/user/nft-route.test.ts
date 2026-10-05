import assert from "node:assert/strict";
import test from "node:test";
import type {
	GatewayRepositories,
	InsertNftMintParams,
	NftMintRow,
	UserEarningsRow,
} from "@octafuse/core";
import { Hono } from "hono";
import { userNftRoutes } from "@/lib/routes/user/nft";
import type { UserEnv } from "@/lib/user-env";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";

type Metadata = {
	sellerUserId: string;
	workspaceId: string;
	contributionCurrency: string;
	amountUnit: string;
	availability: string;
};
type TiersBody = Metadata & {
	data: {
		contributionValue: number;
		walletBound: boolean;
		chainConfigured: boolean;
		tiers: { badgeTokenId: number }[];
		mints: NftMintRow[];
	};
};

function fixture(
	options: {
		capability?: boolean;
		chain?: boolean;
		queueFailure?: boolean;
		earnings?: UserEarningsRow | null;
		rows?: NftMintRow[];
		role?: string;
	} = {}
) {
	const rows = [...(options.rows ?? [])];
	const queue: unknown[] = [];
	const reads: string[] = [];
	const earnings =
		options.earnings === undefined
			? {
					userId: "seller-1",
					balance: 25.123456,
					lockedAmount: 0,
					lifetimeEarned: 25.123456,
					lifetimeWithdrawn: 0,
					contributionValue: 25.123456,
					walletAddress: `0x${"1".repeat(40)}`,
					walletVerifiedAt: null,
					highestBadgeTier: 0,
					updatedAt: "2026-09-27T00:00:00Z",
			  }
			: options.earnings;
	const repositories = {
		client: {
			driver: "d1",
			drizzle: {
				select: () => ({
					from: () => ({ where: () => ({ limit: async () => [] }) }),
				}),
			},
		},
		systemConfig: { getConfig: async () => null },
		portalLedger: {
			ensureUserEarnings: async (id: string) => {
				reads.push(id);
			},
			getUserEarnings: async (id: string) => {
				reads.push(id);
				return earnings;
			},
			getNftMintsByUser: async (id: string) => {
				reads.push(id);
				return rows.filter((row) => row.userId === id);
			},
			insertNftMint: async (input: InsertNftMintParams) => {
				if (
					rows.some(
						(row) =>
							row.userId === input.userId &&
							row.badgeTokenId === input.badgeTokenId
					)
				)
					return false;
				rows.push({
					id: input.id,
					userId: input.userId,
					badgeTokenId: input.badgeTokenId,
					tierName: input.tierName,
					walletAddress: input.walletAddress,
					status: "pending",
					valueSnapshot: input.valueSnapshot,
					createdAt: input.nowIso,
					txHash: null,
					chainId: null,
					failureReason: null,
					confirmedAt: null,
				});
				return true;
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.onError(
		() =>
			new Response(
				JSON.stringify({ success: false, message: "Queue unavailable" }),
				{ status: 500, headers: { "Content-Type": "application/json" } }
			)
	);
	app.use("*", async (c, next) => {
		c.env = {
			...(options.chain === false
				? {}
				: {
						CHAIN_JOBS: {
							send: async (item: unknown) => {
								queue.push(item);
								if (options.queueFailure) throw new Error("Queue unavailable");
							},
						},
				  }),
		} as UserEnv["Bindings"];
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "seller-1",
			subject: "subject-1",
			email: "seller@example.com",
			isAdmin: false,
			capabilities: options.capability === false ? [] : ["nft.read"],
		});
		c.set("workspaceContext", {
			currentWorkspace: {
				id: "org-workspace",
				scopeType: "organization",
				role: options.role ?? "member",
			},
		} as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/nft", userNftRoutes);
	const mint = (
		badgeTokenId: unknown,
		extra: object = {},
		workspace = "org-workspace"
	) =>
		app.request("/nft/mint", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-CinaToken-Workspace": workspace,
			},
			body: JSON.stringify({ badgeTokenId, ...extra }),
		});
	return { app, mint, rows, reads, queue, earnings };
}
const row: NftMintRow = {
	id: "existing",
	userId: "seller-1",
	badgeTokenId: 105,
	tierName: "Bronze",
	walletAddress: `0x${"1".repeat(40)}`,
	status: "failed",
	valueSnapshot: 10.123456,
	createdAt: "2026-09-26T00:00:00Z",
	txHash: null,
	chainId: null,
	failureReason: "chain failed",
	confirmedAt: null,
};
test("NFT metadata and decimal USD contribution remain user-owned in an organization member workspace", async () => {
	const f = fixture({
		rows: [row, { ...row, id: "foreign", userId: "other" }],
	});
	const response = await f.app.request("/nft/tiers");
	const body = (await response.json()) as TiersBody;
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(body.sellerUserId, "seller-1");
	assert.equal(body.workspaceId, "org-workspace");
	assert.equal(body.contributionCurrency, "USD");
	assert.equal(body.amountUnit, "major");
	assert.equal(body.data.contributionValue, 25.123456);
	assert.equal(body.data.walletBound, true);
	assert.equal(body.data.tiers[0].badgeTokenId, 105);
	assert.equal(body.data.mints.length, 1);
	assert.ok(f.reads.every((id) => id === "seller-1"));
});
test("empty history has owner/scope metadata; missing ledger and missing chain are distinct", async () => {
	const f = fixture({ earnings: null, chain: false });
	const tiers = (await (await f.app.request("/nft/tiers")).json()) as TiersBody;
	assert.equal(tiers.availability, "unavailable");
	assert.equal(tiers.data.chainConfigured, false);
	assert.equal(tiers.data.walletBound, false);
	const history = (await (
		await f.app.request("/nft/mints")
	).json()) as Metadata & { data: NftMintRow[] };
	assert.deepEqual(history.data, []);
	assert.equal(history.sellerUserId, "seller-1");
	assert.equal(history.workspaceId, "org-workspace");
});
test("request uses authenticated owner/wallet and inserts pending, ignoring supplied foreign selectors", async () => {
	for (const role of ["member", "admin"]) {
		const f = fixture({ role });
		const response = await f.mint(105, {
			userId: "other",
			sellerUserId: "other",
			walletAddress: "foreign",
			workspaceId: "other",
		});
		const body = (await response.json()) as Metadata & { data: NftMintRow };
		assert.equal(response.status, 200);
		assert.equal(body.sellerUserId, "seller-1");
		assert.equal(body.data.userId, "seller-1");
		assert.equal(body.data.walletAddress, f.earnings?.walletAddress);
		assert.equal(body.data.valueSnapshot, 25.123456);
		assert.equal(body.data.status, "pending");
		assert.equal(f.queue.length, 1);
	}
});
test("malformed tier, unconfigured chain, absent wallet and insufficient contribution cannot enqueue", async () => {
	const basic = fixture();
	assert.equal((await basic.mint("invalid")).status, 400);
	assert.equal((await basic.mint(999)).status, 404);
	assert.equal((await basic.mint(106)).status, 403);
	assert.equal(basic.queue.length, 0);
	const noChain = fixture({ chain: false });
	assert.equal((await noChain.mint(105)).status, 503);
	assert.equal(noChain.rows.length, 0);
	const noWallet = fixture({
		earnings: { ...basic.earnings!, walletAddress: null },
	});
	assert.equal((await noWallet.mint(105)).status, 400);
	assert.equal(noWallet.queue.length, 0);
});
test("existing failed or pending tier requests preserve ledger uniqueness and never enqueue again", async () => {
	for (const status of ["failed", "pending", "confirmed"] as const) {
		const f = fixture({ rows: [{ ...row, status }] });
		assert.equal((await f.mint(105)).status, 409);
		assert.equal(f.rows.length, 1);
		assert.equal(f.queue.length, 0);
	}
});
test("changed workspace precondition rejects before personal ledger read or mint", async () => {
	const f = fixture();
	const response = await f.mint(105, {}, "old-workspace");
	assert.equal(response.status, 409);
	assert.equal(
		((await response.json()) as { code: string }).code,
		"workspace_mismatch"
	);
	assert.equal(f.reads.length, 0);
	assert.equal(f.rows.length, 0);
	assert.equal(f.queue.length, 0);
});

test("a queue failure can leave a pending row; refresh reveals it and a replay cannot create another row", async () => {
	const f = fixture({ queueFailure: true });
	assert.equal((await f.mint(105)).status, 500);
	const history = (await (
		await f.app.request("/nft/mints")
	).json()) as Metadata & { data: NftMintRow[] };
	assert.equal(history.data.length, 1);
	assert.equal(history.data[0].status, "pending");
	assert.equal((await f.mint(105)).status, 409);
	assert.equal(f.rows.length, 1);
	assert.equal(f.queue.length, 1);
});

test("nft.read is required for every NFT route; organization admin role alone cannot grant it", async () => {
	const f = fixture({ capability: false, role: "admin" });
	for (const path of ["/nft/tiers", "/nft/mints"])
		assert.equal((await f.app.request(path)).status, 403);
	assert.equal((await f.mint(105)).status, 403);
	assert.equal(f.reads.length, 0);
	assert.equal(f.rows.length, 0);
	assert.equal(f.queue.length, 0);
});
