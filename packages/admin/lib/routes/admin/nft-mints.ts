/** Admin CinaBadge monitoring and queue dispatch. */
import { Hono } from "hono";
import type { AdminEnv } from "@/lib/admin-env";
import { requireAdminPrincipal } from "@/lib/middleware/admin-auth";
import {
	assertExpectedConsoleSubject,
	EXPECTED_CONSOLE_SUBJECT_HEADER,
	ExpectedConsoleSubjectError,
} from "@/lib/services/admin/expected-console-subject";
import {
	ChainOperationsError,
	NFT_MINT_STATUSES,
	chainOperationsLimit,
	chainOperationsMetadata,
	chainOperationsStatus,
	projectAdminChainRows,
	projectAdminNftMint,
} from "@/lib/services/admin/chain-operations-contract";
import { handleAdminRouteError } from "./error-response";

export const adminNftMintsRoutes = new Hono<AdminEnv>();
adminNftMintsRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminNftMintsRoutes.use("*", requireAdminPrincipal);

function handleError(
	c: Parameters<typeof handleAdminRouteError>[0],
	error: unknown,
	message: string
) {
	if (
		error instanceof ChainOperationsError ||
		error instanceof ExpectedConsoleSubjectError
	)
		return c.json(
			{ success: false, code: error.code, message: error.message },
			error.status
		);
	return handleAdminRouteError(c, error, message);
}

adminNftMintsRoutes.get("/", async (c) => {
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER)
		);
		const status = chainOperationsStatus(c.req.url, NFT_MINT_STATUSES);
		const rows = projectAdminChainRows(
			await c.get("repositories").portalLedger.listAllNftMints(status),
			projectAdminNftMint,
			status
		);
		return c.json({
			success: true,
			data: rows,
			total: rows.length,
			meta: chainOperationsMetadata("nft_mint", Boolean(c.env.CHAIN_JOBS)),
		});
	} catch (error) {
		return handleError(c, error, "Failed to list NFT mints");
	}
});

adminNftMintsRoutes.post("/process", async (c) => {
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER)
		);
		const limit = chainOperationsLimit(c.req.url);
		if ((await c.req.text()).trim())
			throw new ChainOperationsError(
				400,
				"invalid_chain_operations_input",
				"Process accepts no request body"
			);
		if (!c.env.CHAIN_JOBS)
			return c.json(
				{
					success: false,
					code: "chain_queue_unavailable",
					message: "cinachain queue not configured",
				},
				503
			);
		const rows = projectAdminChainRows(
			await c.get("repositories").portalLedger.listAllNftMints("pending"),
			projectAdminNftMint,
			"pending"
		);
		const pending = rows.slice(0, limit);
		if (pending.length > 0)
			await c.env.CHAIN_JOBS.sendBatch(
				pending.map((row) => ({
					body: { kind: "nft_mint" as const, id: row.id },
				}))
			);
		return c.json({
			success: true,
			data: { queued: pending.length },
			meta: { result: "queued", chainConfirmation: false },
		});
	} catch (error) {
		return handleError(
			c,
			error,
			"NFT queue outcome is unavailable; review before retrying"
		);
	}
});
