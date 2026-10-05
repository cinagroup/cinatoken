/** Admin withdrawal monitoring, queue dispatch and atomic pre-claim rejection. */
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
	WITHDRAWAL_STATUSES,
	chainOperationsId,
	chainOperationsLimit,
	chainOperationsMetadata,
	chainOperationsQuery,
	chainOperationsRejectReason,
	chainOperationsStatus,
	projectAdminChainRows,
	projectAdminWithdrawal,
} from "@/lib/services/admin/chain-operations-contract";
import { handleAdminRouteError } from "./error-response";

export const adminWithdrawalsRoutes = new Hono<AdminEnv>();
adminWithdrawalsRoutes.use("*", async (c, next) => {
	await next();
	c.header("Cache-Control", "private, no-store");
});
adminWithdrawalsRoutes.use("*", requireAdminPrincipal);

function handleError(
	c: Parameters<typeof handleAdminRouteError>[0],
	error: unknown,
	message: string
) {
	if (
		error instanceof ChainOperationsError ||
		error instanceof ExpectedConsoleSubjectError
	) {
		return c.json(
			{ success: false, code: error.code, message: error.message },
			error.status
		);
	}
	return handleAdminRouteError(c, error, message);
}

adminWithdrawalsRoutes.get("/", async (c) => {
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER)
		);
		const status = chainOperationsStatus(c.req.url, WITHDRAWAL_STATUSES);
		const rows = projectAdminChainRows(
			await c.get("repositories").portalLedger.listAllWithdrawals(status),
			projectAdminWithdrawal,
			status
		);
		return c.json({
			success: true,
			data: rows,
			total: rows.length,
			meta: chainOperationsMetadata("withdrawal", Boolean(c.env.CHAIN_JOBS)),
		});
	} catch (error) {
		return handleError(c, error, "Failed to list withdrawals");
	}
});

/** Queue acknowledgement is not a transaction submission or chain confirmation. */
adminWithdrawalsRoutes.post("/process", async (c) => {
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
			await c.get("repositories").portalLedger.listAllWithdrawals(),
			projectAdminWithdrawal
		);
		const pending = rows
			.filter((row) => row.status === "requested" || row.status === "submitted")
			.slice(0, limit);
		if (pending.length > 0)
			await c.env.CHAIN_JOBS.sendBatch(
				pending.map((row) => ({
					body: { kind: "withdrawal" as const, id: row.id },
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
			"Withdrawal queue outcome is unavailable; review before retrying"
		);
	}
});

adminWithdrawalsRoutes.post("/:id/reject", async (c) => {
	try {
		assertExpectedConsoleSubject(
			c.get("principal"),
			c.req.header(EXPECTED_CONSOLE_SUBJECT_HEADER)
		);
		chainOperationsQuery(c.req.url, []);
		const id = chainOperationsId(c.req.param("id"));
		const reason = await chainOperationsRejectReason(c.req.raw);
		const result = await c
			.get("repositories")
			.portalLedger.rejectRequestedWithdrawal(
				id,
				reason,
				new Date().toISOString()
			);
		if (result.kind === "not-found")
			return c.json(
				{
					success: false,
					code: "withdrawal_not_found",
					message: "Withdrawal not found",
				},
				404
			);
		if (result.kind === "conflict")
			return c.json(
				{
					success: false,
					code: "withdrawal_rejection_conflict",
					message:
						"Withdrawal cannot be safely rejected; review the current ledger and chain state",
				},
				409
			);
		if (result.kind !== "rejected" || result.withdrawalId !== id)
			throw new Error("Invalid atomic withdrawal rejection result");
		return c.json({
			success: true,
			message: "Withdrawal rejected and refunded",
			data: {
				withdrawalId: id,
				status: "failed",
				result: "rejected_and_refunded",
			},
		});
	} catch (error) {
		return handleError(
			c,
			error,
			"Withdrawal rejection outcome is unavailable; review before retrying"
		);
	}
});
