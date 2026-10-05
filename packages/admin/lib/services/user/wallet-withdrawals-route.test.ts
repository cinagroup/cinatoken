import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { privateKeyToAccount } from "viem/accounts";
import type {
	GatewayRepositories,
	InsertWithdrawalParams,
	UserEarningsRow,
	WithdrawalRow,
} from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { userWalletRoutes } from "@/lib/routes/user/wallet";
import { userWithdrawalsRoutes } from "@/lib/routes/user/withdrawals";
import { userWorkspacePrecondition } from "@/lib/user-workspace-precondition";
import {
	createWalletChallenge,
	sealWalletChallenge,
} from "@/lib/wallet-challenge";

const account = privateKeyToAccount(
	"0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
);
const secret = "test-only-wallet-secret-at-least-32-characters";
function fixture(
	options: {
		capabilities?: ("wallet.manage" | "withdrawals.manage")[];
		queue?: boolean;
		queueFailure?: boolean;
		noSecret?: boolean;
	} = {}
) {
	const calls: string[] = [];
	const rows: WithdrawalRow[] = [];
	const queue: unknown[] = [];
	let configValue: string | null = null;
	let chainId = "84532";
	const earnings: UserEarningsRow = {
		userId: "user-1",
		balance: 100.123456,
		lockedAmount: 0,
		lifetimeEarned: 100.123456,
		lifetimeWithdrawn: 0,
		contributionValue: 100.123456,
		walletAddress: account.address,
		walletVerifiedAt: null,
		highestBadgeTier: 0,
		updatedAt: new Date().toISOString(),
	};
	const repositories = {
		client: {
			driver: "d1",
			drizzle: {
				select: () => ({
					from: () => ({
						where: () => ({
							limit: async () => {
								calls.push("config");
								return configValue === null ? [] : [{ value: configValue }];
							},
						}),
					}),
				}),
			},
		},
		portalLedger: {
			ensureUserEarnings: async (id: string) => {
				assert.equal(id, "user-1");
				calls.push("ensure");
			},
			getUserEarnings: async (id: string) => {
				assert.equal(id, "user-1");
				calls.push("earnings");
				return { ...earnings };
			},
			updateWalletIfChallengeUnused: async (
				id: string,
				address: string,
				verifiedAt: string,
				cutoff: string
			) => {
				assert.equal(id, "user-1");
				calls.push("cas");
				if (
					earnings.walletVerifiedAt &&
					new Date(earnings.walletVerifiedAt) >= new Date(cutoff)
				)
					return false;
				earnings.walletAddress = address;
				earnings.walletVerifiedAt = verifiedAt;
				return true;
			},
			listWithdrawalsByUser: async (
				id: string,
				page: number,
				pageSize: number
			) => {
				assert.equal(id, "user-1");
				calls.push(`list:${page}:${pageSize}`);
				return {
					rows: rows.slice((page - 1) * pageSize, page * pageSize),
					total: rows.length,
				};
			},
			getActiveWithdrawalByUser: async (id: string) => {
				assert.equal(id, "user-1");
				calls.push("active");
				return (
					rows.find((row) =>
						["requested", "processing", "submitted"].includes(row.status)
					) ?? null
				);
			},
			getWithdrawal: async (id: string) =>
				rows.find((row) => row.id === id) ?? null,
			createWithdrawalWithBalanceLock: async (
				input: InsertWithdrawalParams
			) => {
				calls.push("create");
				assert.equal(input.userId, "user-1");
				if (
					rows.some((row) =>
						["requested", "processing", "submitted"].includes(row.status)
					)
				)
					return "active_withdrawal_exists";
				if (earnings.balance < input.amount) return "insufficient_balance";
				earnings.balance -= input.amount;
				earnings.lockedAmount += input.amount;
				rows.push({
					id: input.id,
					userId: input.userId,
					amount: input.amount,
					fee: input.fee,
					netAmount: input.netAmount,
					currency: input.currency,
					walletAddress: input.walletAddress,
					tokenAmount: input.tokenAmount ?? null,
					status: "requested",
					txHash: null,
					chainId: null,
					failureReason: null,
					createdAt: input.nowIso,
					updatedAt: input.nowIso,
					confirmedAt: null,
				});
				return "created";
			},
		},
	} as unknown as GatewayRepositories;
	const app = new Hono<UserEnv>();
	app.use("*", async (c, next) => {
		c.env = {
			CINACHAIN_CHAIN_ID: chainId,
			CINATOKEN_OIDC_TRANSACTION_SECRET: options.noSecret ? "" : secret,
			...(options.queue === false
				? {}
				: {
						CHAIN_JOBS: {
							send: async (value: unknown) => {
								queue.push(value);
								if (options.queueFailure)
									throw new Error("private queue detail");
							},
						},
				  }),
		} as UserEnv["Bindings"];
		c.set("repositories", repositories);
		c.set("principal", {
			userId: "user-1",
			subject: "subject-1",
			email: "user@example.test",
			isAdmin: true,
			capabilities: options.capabilities ?? [
				"wallet.manage",
				"withdrawals.manage",
			],
		});
		c.set("workspaceContext", {
			currentWorkspace: {
				id: "workspace-1",
				scopeType: "organization",
				role: "admin",
				organizationRoles: ["billing-admin"],
			},
		} as UserEnv["Variables"]["workspaceContext"]);
		await next();
	});
	app.use("*", userWorkspacePrecondition);
	app.route("/wallet", userWalletRoutes);
	app.route("/withdrawals", userWithdrawalsRoutes);
	const post = (path: string, body: unknown, workspace = "workspace-1") =>
		app.request(`http://internal.test${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Host: "public.example.test",
				"X-CinaToken-Workspace": workspace,
			},
			body: JSON.stringify(body),
		});
	return {
		app,
		post,
		earnings,
		rows,
		calls,
		queue,
		setConfig: (value: string) => {
			configValue = value;
		},
		setChain: (value: string) => {
			chainId = value;
		},
	};
}
type Challenge = {
	data: {
		address: string;
		message: string;
		challengeToken: string;
		origin: string;
		chainId: number;
		issuedAt: string;
		expiresAt: string;
	};
};
type Quote = {
	userId: string;
	workspaceId: string;
	data: {
		amount: number;
		fee: number;
		netAmount: number;
		tokenAmount: number;
		fingerprint: string;
	};
};

test("exact domain capabilities deny every endpoint before repository operations even for organization/console admin", async () => {
	for (const [method, path] of [
		["GET", "/wallet"],
		["POST", "/wallet/challenge"],
		["POST", "/wallet/verify"],
		["POST", "/wallet"],
		["GET", "/withdrawals"],
		["POST", "/withdrawals/quote"],
		["POST", "/withdrawals"],
	]) {
		const f = fixture({ capabilities: [] });
		const response = await f.app.request(path, { method });
		assert.equal(response.status, 403);
		assert.equal(response.headers.get("Cache-Control"), "private, no-store");
		assert.deepEqual(f.calls, []);
	}
});
test("workspace preconditions reject writes and reads before any repository calls", async () => {
	for (const workspace of ["other", "%00"]) {
		const f = fixture();
		const response = await f.post("/withdrawals", { amount: 20 }, workspace);
		assert.equal(response.status, workspace === "other" ? 409 : 400);
		assert.deepEqual(f.calls, []);
		assert.equal(f.queue.length, 0);
	}
});
test("wallet metadata is user-owned and preserves legacy unverified bound wallet", async () => {
	const f = fixture();
	const response = await f.app.request("/wallet");
	const body = (await response.json()) as {
		userId: string;
		workspaceId: string;
		data: { walletAddress: string; verifiedAt: null };
	};
	assert.equal(response.headers.get("Cache-Control"), "private, no-store");
	assert.equal(body.userId, "user-1");
	assert.equal(body.workspaceId, "workspace-1");
	assert.equal(body.data.walletAddress, account.address);
	assert.equal(body.data.verifiedAt, null);
});
test("challenge uses public Host origin and real EOA signature; atomic consumption admits one concurrent winner", async () => {
	const f = fixture();
	const response = await f.post("/wallet/challenge", {
		walletAddress: account.address,
	});
	const { data } = (await response.json()) as Challenge;
	assert.equal(data.origin, "http://public.example.test");
	assert.match(data.message, /^public\.example\.test wants/u);
	assert.equal(Date.parse(data.expiresAt) - Date.parse(data.issuedAt), 300000);
	assert.match(data.message, /Request ID: user-1/u);
	const signature = await account.signMessage({ message: data.message });
	const results = await Promise.all([
		f.post("/wallet/verify", {
			challengeToken: data.challengeToken,
			signature,
		}),
		f.post("/wallet/verify", {
			challengeToken: data.challengeToken,
			signature,
		}),
	]);
	assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
	assert.equal(f.calls.filter((call) => call === "cas").length, 2);
	assert.equal(f.earnings.walletAddress, account.address);
});
test("invalid signature, tampered challenge and changed public origin never ensure or update a ledger", async () => {
	const f = fixture();
	const response = await f.post("/wallet/challenge", {
		walletAddress: account.address,
	});
	const { data } = (await response.json()) as Challenge;
	for (const payload of [
		{ challengeToken: data.challengeToken, signature: "0x00" },
		{ challengeToken: `${data.challengeToken}x`, signature: "0x00" },
	])
		assert.equal((await f.post("/wallet/verify", payload)).status, 400);
	const signature = await account.signMessage({ message: data.message });
	const changed = await f.app.request(
		"http://different.example.test/wallet/verify",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ challengeToken: data.challengeToken, signature }),
		}
	);
	assert.equal(changed.status, 400);
	assert.deepEqual(f.calls, []);
});
test("missing wallet signing configuration is unavailable, challenge 503 and direct legacy binding 410", async () => {
	const f = fixture({ noSecret: true });
	assert.equal(
		(await f.post("/wallet/challenge", { walletAddress: account.address }))
			.status,
		503
	);
	assert.equal(
		(await f.post("/wallet", { walletAddress: account.address })).status,
		410
	);
	const body = (await (await f.app.request("/wallet")).json()) as {
		availability: string;
	};
	assert.equal(body.availability, "unavailable");
});
test("quote is a pure read using USD major balances and post-fee token conversion", async () => {
	const f = fixture();
	const response = await f.post("/withdrawals/quote", { amount: 20.123456 });
	const body = (await response.json()) as Quote;
	assert.equal(response.status, 200);
	assert.equal(body.userId, "user-1");
	assert.equal(body.workspaceId, "workspace-1");
	assert.deepEqual(body.data, {
		amount: 20.123456,
		fee: 0,
		netAmount: 20.123456,
		tokenAmount: 20.123456,
		fingerprint: body.data.fingerprint,
	});
	assert.match(body.data.fingerprint, /^[a-f0-9]{64}$/u);
	assert.equal(f.calls.includes("ensure"), false);
	assert.equal(f.calls.includes("create"), false);
	assert.equal(f.queue.length, 0);
	assert.equal(f.earnings.balance, 100.123456);
});
test("modern quote rejects invalid precision, missing wallet, insufficient balance and unconfigured channel without writes", async () => {
	for (const amount of [0, 1, 200, 20.1234567, "20"]) {
		const f = fixture();
		assert.equal((await f.post("/withdrawals/quote", { amount })).status, 400);
		assert.equal(f.calls.includes("create"), false);
	}
	const missing = fixture();
	missing.earnings.walletAddress = null;
	assert.equal(
		(await missing.post("/withdrawals/quote", { amount: 20 })).status,
		400
	);
	const disabled = fixture({ queue: false });
	assert.equal(
		(await disabled.post("/withdrawals/quote", { amount: 20 })).status,
		503
	);
});
test("reviewed creation uses server computation, locks once, retains wallet snapshot and preserves amount-only legacy client", async () => {
	for (const reviewed of [true, false]) {
		const f = fixture();
		const quote = (await (
			await f.post("/withdrawals/quote", { amount: 20 })
		).json()) as Quote;
		const response = await f.post("/withdrawals", {
			amount: 20,
			...(reviewed ? { expectedQuote: quote.data.fingerprint } : {}),
		});
		assert.equal(response.status, 200);
		assert.equal(f.rows.length, 1);
		assert.equal(f.rows[0].currency, "USD");
		assert.equal(f.rows[0].walletAddress, account.address);
		assert.equal(f.earnings.balance, 80.123456);
		assert.equal(f.earnings.lockedAmount, 20);
		assert.equal(f.queue.length, 1);
		assert.equal((await f.post("/withdrawals", { amount: 20 })).status, 409);
		assert.equal(f.rows.length, 1);
	}
});
test("policy, wallet and balance changes reject old quote with stable 409 before locking", async () => {
	for (const change of ["policy", "wallet", "balance"]) {
		const f = fixture();
		const quote = (await (
			await f.post("/withdrawals/quote", { amount: 20 })
		).json()) as Quote;
		if (change === "policy") f.setConfig("1");
		if (change === "wallet") f.earnings.walletAddress = `0x${"2".repeat(40)}`;
		if (change === "balance") f.earnings.balance = 50;
		const response = await f.post("/withdrawals", {
			amount: 20,
			expectedQuote: quote.data.fingerprint,
		});
		assert.equal(response.status, 409);
		assert.equal(
			((await response.json()) as { code: string }).code,
			"withdrawal_quote_changed"
		);
		assert.equal(f.calls.includes("create"), false);
		assert.equal(f.queue.length, 0);
	}
});
test("queue failure leaves one discoverable locked order; response instructs reads instead of retrying a write", async () => {
	const f = fixture({ queueFailure: true });
	const response = await f.post("/withdrawals", { amount: 20 });
	assert.equal(response.status, 503);
	const body = (await response.json()) as {
		code: string;
		withdrawalId: string;
	};
	assert.equal(body.code, "withdrawal_dispatch_unconfirmed");
	assert.equal(body.withdrawalId, f.rows[0].id);
	assert.equal(f.earnings.lockedAmount, 20);
	const list = (await (
		await f.app.request("/withdrawals?page=1&pageSize=20")
	).json()) as {
		data: WithdrawalRow[];
		activeWithdrawal: WithdrawalRow;
		withdrawalCurrency: string;
		amountUnit: string;
	};
	assert.equal(list.data.length, 1);
	assert.equal(list.activeWithdrawal.id, body.withdrawalId);
	assert.equal(list.withdrawalCurrency, "USD");
	assert.equal(list.amountUnit, "major");
	assert.equal((await f.post("/withdrawals", { amount: 20 })).status, 409);
	assert.equal(f.rows.length, 1);
});
test("empty paginated lists still identify owner/workspace and preserve null semantics", async () => {
	const f = fixture();
	const response = await f.app.request("/withdrawals?page=2&pageSize=1");
	const body = (await response.json()) as {
		data: unknown[];
		total: number;
		page: number;
		pageSize: number;
		userId: string;
		workspaceId: string;
		activeWithdrawal: null;
		walletVerifiedAt: null;
	};
	assert.equal(response.status, 200);
	assert.deepEqual(body.data, []);
	assert.equal(body.page, 2);
	assert.equal(body.pageSize, 1);
	assert.equal(body.userId, "user-1");
	assert.equal(body.workspaceId, "workspace-1");
	assert.equal(body.activeWithdrawal, null);
	assert.equal(body.walletVerifiedAt, null);
});

test("expired and other-user signed challenges are rejected before ledger writes", async () => {
	for (const input of [
		{ userId: "other-user", now: Date.now() },
		{ userId: "user-1", now: Date.now() - 300001 },
	]) {
		const f = fixture();
		const challenge = createWalletChallenge({
			...input,
			address: account.address,
			origin: "http://public.example.test",
			chainId: 84532,
		});
		const challengeToken = await sealWalletChallenge(challenge, secret);
		const signature = await account.signMessage({ message: challenge.message });
		assert.equal(
			(await f.post("/wallet/verify", { challengeToken, signature })).status,
			400
		);
		assert.deepEqual(f.calls, []);
	}
});
test("binding chain config is reflected in challenge and quote and invalidates earlier context", async () => {
	const f = fixture();
	const wallet = (await (
		await f.post("/wallet/challenge", { walletAddress: account.address })
	).json()) as Challenge;
	const quote = (await (
		await f.post("/withdrawals/quote", { amount: 20 })
	).json()) as Quote;
	f.setChain("8453");
	const signature = await account.signMessage({ message: wallet.data.message });
	assert.equal(
		(
			await f.post("/wallet/verify", {
				challengeToken: wallet.data.challengeToken,
				signature,
			})
		).status,
		400
	);
	assert.equal(
		(
			await f.post("/withdrawals", {
				amount: 20,
				expectedQuote: quote.data.fingerprint,
			})
		).status,
		409
	);
	const updated = (await (
		await f.post("/wallet/challenge", { walletAddress: account.address })
	).json()) as Challenge;
	assert.equal(updated.data.chainId, 8453);
	assert.equal(f.calls.includes("create"), false);
});
test("quote uses configured fee before token conversion and zero token rate is unavailable without locking", async () => {
	const f = fixture();
	f.setConfig("1");
	const quote = (await (
		await f.post("/withdrawals/quote", { amount: 20 })
	).json()) as Quote;
	assert.equal(quote.data.fee, 1);
	assert.equal(quote.data.netAmount, 19);
	assert.equal(quote.data.tokenAmount, 19);
	f.setConfig("0");
	assert.equal(
		(await f.post("/withdrawals/quote", { amount: 20 })).status,
		503
	);
	assert.equal(f.calls.includes("create"), false);
});
