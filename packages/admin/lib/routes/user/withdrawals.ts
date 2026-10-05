/** USD seller-ledger withdrawal, locked atomically before asynchronous chain dispatch. */
import { Hono, type Context } from "hono";
import { roundGatewayMoney, type WithdrawalRow } from "@octafuse/core";
import type { UserEnv } from "@/lib/user-env";
import { loadPortalMarketplaceConfig } from "@/lib/portal-config";
import { walletChainId } from "./wallet";

export const userWithdrawalsRoutes = new Hono<UserEnv>();
userWithdrawalsRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (!c.get("principal").capabilities?.includes("withdrawals.manage"))
		return c.json(
			{ success: false, message: "Withdrawal access is not available" },
			403
		);
	await next();
});

/** Explicit public row whitelist; repository micros and worker internals never leak. */
function publicWithdrawal(row: WithdrawalRow) {
	return {
		id: row.id,
		userId: row.userId,
		amount: row.amount,
		fee: row.fee,
		netAmount: row.netAmount,
		currency: row.currency,
		walletAddress: row.walletAddress,
		status: row.status,
		tokenAmount: row.tokenAmount,
		txHash: row.txHash,
		chainId: row.chainId,
		failureReason: row.failureReason,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		confirmedAt: row.confirmedAt,
	};
}
async function state(c: Context<UserEnv>) {
	const ledger = c.get("repositories").portalLedger;
	const userId = c.get("principal").userId;
	const [config, earnings, active, history] = await Promise.all([
		loadPortalMarketplaceConfig(c.get("repositories")),
		ledger.getUserEarnings(userId),
		ledger.getActiveWithdrawalByUser(userId),
		ledger.listWithdrawalsByUser(userId, 1, 100),
	]);
	// Retains the current policy: runtime-local calendar day, first 100 historic rows.
	const dayStart = new Date();
	dayStart.setHours(0, 0, 0, 0);
	const todayCount = history.rows.filter(
		(row) => new Date(row.createdAt).getTime() >= dayStart.getTime()
	).length;
	const chainId = walletChainId(c.env);
	return {
		userId,
		workspaceId: c.get("workspaceContext").currentWorkspace.id,
		withdrawalCurrency: "USD" as const,
		amountUnit: "major" as const,
		tokenSymbol: "CINA-C" as const,
		tokenAmountUnit: "major" as const,
		policy: {
			minAmount: config.withdrawalMinAmount,
			fee: roundGatewayMoney(config.withdrawalFee),
			tokenRate: config.withdrawalTokenRate,
			dailyLimit: config.withdrawalDailyLimit,
		},
		availability:
			c.env.CHAIN_JOBS && chainId && config.withdrawalTokenRate > 0
				? ("available" as const)
				: ("unavailable" as const),
		queueConfigured: Boolean(c.env.CHAIN_JOBS),
		chainId,
		balance: earnings?.balance ?? null,
		lockedAmount: earnings?.lockedAmount ?? null,
		walletAddress: earnings?.walletAddress ?? null,
		walletVerifiedAt: earnings?.walletVerifiedAt ?? null,
		activeWithdrawal: active ? publicWithdrawal(active) : null,
		dailyRemaining: Math.max(0, config.withdrawalDailyLimit - todayCount),
	};
}
type WithdrawalState = Awaited<ReturnType<typeof state>>;
function amountError(
	amount: number,
	current: WithdrawalState
): { status: 400 | 429 | 503; message: string } | null {
	if (!Number.isFinite(amount) || amount <= 0)
		return { status: 400, message: "Invalid withdrawal amount" };
	if (amount < current.policy.minAmount)
		return {
			status: 400,
			message: `Minimum withdrawal amount is ${current.policy.minAmount}`,
		};
	if (!current.queueConfigured)
		return { status: 503, message: "Withdrawal channel is not configured" };
	if (!current.walletAddress)
		return { status: 400, message: "Bind a receiving wallet first" };
	if (!current.dailyRemaining)
		return {
			status: 429,
			message: `Daily withdrawal limit is ${current.policy.dailyLimit}`,
		};
	if (amount - current.policy.fee < 0.000001)
		return { status: 400, message: "Amount does not cover the fee" };
	return null;
}
function calculate(amount: number, current: WithdrawalState) {
	const fee = current.policy.fee;
	const netAmount = roundGatewayMoney(amount - fee);
	return {
		amount,
		fee,
		netAmount,
		tokenAmount: roundGatewayMoney(netAmount * current.policy.tokenRate),
	};
}
async function fingerprint(
	amount: number,
	current: WithdrawalState
): Promise<string> {
	// Consistency token only; authorization always uses the freshly resolved principal.
	const value = JSON.stringify({ ...current, ...calculate(amount, current) });
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}
userWithdrawalsRoutes.get("/", async (c) => {
	const page = Math.max(1, Math.floor(Number(c.req.query("page") ?? "1") || 1));
	const pageSize = Math.min(
		100,
		Math.max(1, Math.floor(Number(c.req.query("pageSize") ?? "20") || 20))
	);
	if (!Number.isSafeInteger(page))
		return c.json({ success: false, message: "Invalid page" }, 400);
	const current = await state(c);
	const result = await c
		.get("repositories")
		.portalLedger.listWithdrawalsByUser(current.userId, page, pageSize);
	return c.json({
		success: true,
		data: result.rows.map(publicWithdrawal),
		total: result.total,
		page,
		pageSize,
		...current,
	});
});

userWithdrawalsRoutes.post("/quote", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		amount?: unknown;
	} | null;
	const amount = body?.amount;
	// Modern review accepts exact micro precision; legacy amount-only POST is retained.
	if (
		typeof amount !== "number" ||
		!Number.isSafeInteger(Math.round(amount * 1_000_000)) ||
		Math.abs(roundGatewayMoney(amount) - amount) > 1e-10
	)
		return c.json(
			{ success: false, message: "Amount must use at most six decimal places" },
			400
		);
	const current = await state(c);
	const error = amountError(amount, current);
	if (error)
		return c.json({ success: false, message: error.message }, error.status);
	if (current.availability !== "available")
		return c.json(
			{
				success: false,
				message: "Withdrawal token configuration is unavailable",
			},
			503
		);
	if (current.activeWithdrawal)
		return c.json(
			{ success: false, message: "An active withdrawal already exists" },
			409
		);
	if (current.balance === null || amount > current.balance)
		return c.json({ success: false, message: "Insufficient balance" }, 400);
	const quote = calculate(amount, current);
	if (quote.tokenAmount <= 0)
		return c.json(
			{ success: false, message: "Token amount is below supported precision" },
			400
		);
	return c.json({
		success: true,
		...current,
		data: { ...quote, fingerprint: await fingerprint(amount, current) },
	});
});

userWithdrawalsRoutes.post("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as {
		amount?: unknown;
		expectedQuote?: unknown;
	} | null;
	const amount = Number(body?.amount);
	if (!Number.isFinite(amount) || amount <= 0)
		return c.json(
			{ success: false, message: "Invalid withdrawal amount" },
			400
		);
	if (
		body?.expectedQuote !== undefined &&
		(typeof body.expectedQuote !== "string" ||
			!/^[a-f0-9]{64}$/u.test(body.expectedQuote))
	)
		return c.json({ success: false, message: "Invalid expected quote" }, 400);
	const current = await state(c);
	if (
		body?.expectedQuote !== undefined &&
		body.expectedQuote !== (await fingerprint(amount, current))
	)
		return c.json(
			{
				success: false,
				code: "withdrawal_quote_changed",
				message: "Withdrawal quote changed; review a new quote",
			},
			409
		);
	const error = amountError(amount, current);
	if (error)
		return c.json({ success: false, message: error.message }, error.status);
	const quote = calculate(amount, current);
	const id = crypto.randomUUID();
	const ledger = c.get("repositories").portalLedger;
	const creation = await ledger.createWithdrawalWithBalanceLock({
		id,
		userId: current.userId,
		...quote,
		currency: "USD",
		walletAddress: current.walletAddress!,
		nowIso: new Date().toISOString(),
	});
	if (creation === "active_withdrawal_exists")
		return c.json(
			{ success: false, message: "An active withdrawal already exists" },
			409
		);
	if (creation === "insufficient_balance")
		return c.json({ success: false, message: "Insufficient balance" }, 400);
	try {
		await c.env.CHAIN_JOBS!.send({ kind: "withdrawal", id });
	} catch {
		// The transaction has already locked money; never imply that repeating POST is safe.
		return c.json(
			{
				success: false,
				code: "withdrawal_dispatch_unconfirmed",
				message:
					"Withdrawal recorded; dispatch could not be confirmed. Refresh your orders.",
				withdrawalId: id,
			},
			503
		);
	}
	const created = await ledger.getWithdrawal(id);
	if (!created || created.userId !== current.userId)
		return c.json(
			{
				success: false,
				code: "withdrawal_dispatch_unconfirmed",
				message:
					"Withdrawal recorded; refresh your orders to confirm its status",
			},
			503
		);
	return c.json({ success: true, ...current, data: publicWithdrawal(created) });
});
