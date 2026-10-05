/**
 * 用户路由：`/user/earnings` — 卖家收益流水与账本汇总。
 */
import { Hono } from "hono";
import type { UserEnv } from "@/lib/user-env";

export const userEarningsRoutes = new Hono<UserEnv>();

userEarningsRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "private, no-store");
	if (!c.get("principal").capabilities?.includes("earnings.read")) {
		return c.json(
			{ success: false, message: "Earnings access is not available" },
			403
		);
	}
	await next();
});

userEarningsRoutes.get("/summary", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	await repositories.portalLedger.ensureUserEarnings(principal.userId);
	const earnings = await repositories.portalLedger.getUserEarnings(
		principal.userId
	);
	// Shared-key settlement credits this ledger in USD (core/shared-key-earnings).
	// Repository public rows already convert integer micros to major units.
	return c.json({
		success: true,
		data: earnings,
		sellerUserId: principal.userId,
		workspaceId: c.get("workspaceContext").currentWorkspace.id,
		earningsCurrency: "USD",
		amountUnit: "major",
		availability: earnings === null ? "unavailable" : "available",
	});
});

userEarningsRoutes.get("/", async (c) => {
	const repositories = c.get("repositories");
	const principal = c.get("principal");
	const page = Math.max(1, Number(c.req.query("page") ?? "1") || 1);
	const pageSize = Math.min(
		100,
		Math.max(1, Number(c.req.query("pageSize") ?? "20") || 20)
	);
	const result = await repositories.portalLedger.listEarningsBySeller(
		principal.userId,
		page,
		pageSize
	);
	return c.json({
		success: true,
		data: result.rows,
		total: result.total,
		page,
		pageSize,
		sellerUserId: principal.userId,
		workspaceId: c.get("workspaceContext").currentWorkspace.id,
		earningsCurrency: "USD",
		amountUnit: "major",
	});
});
