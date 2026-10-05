/** Exact guard/foreign-key identities for append-only credited earning history. */
const historyMessage = "credited_shared_key_earning_history_immutable";
const postgresHistoryConstraint = "shared_key_earnings_history_immutable";
const postgresParentConstraints = new Set([
	"shared_key_earnings_request_log_id_fkey",
	"shared_key_earnings_shared_key_id_fkey",
	"shared_key_earnings_seller_user_id_fkey",
]);
const mysqlParentConstraint =
	/CONSTRAINT\s+[`"](?:fk_shared_key_earnings_log|fk_shared_key_earnings_key|fk_shared_key_earnings_user)[`"]/u;

export function isSharedKeyEarningHistoryDeleteError(error: unknown): boolean {
	const seen = new Set<object>();
	let candidate: unknown = error;
	for (
		let depth = 0;
		depth < 5 && candidate && typeof candidate === "object";
		depth++
	) {
		if (seen.has(candidate)) return false;
		seen.add(candidate);
		const value = candidate as {
			code?: unknown;
			errno?: unknown;
			constraint?: unknown;
			constraint_name?: unknown;
			message?: unknown;
			sqlMessage?: unknown;
			cause?: unknown;
		};
		const message = typeof value.message === "string" ? value.message : "";
		const sqlMessage =
			typeof value.sqlMessage === "string" ? value.sqlMessage : "";
		const constraint = value.constraint ?? value.constraint_name;
		if (message.includes(historyMessage) || sqlMessage.includes(historyMessage))
			return true;
		if (
			value.code === "23514" &&
			(constraint === postgresHistoryConstraint ||
				message.includes("Credited shared-key earning history is immutable"))
		)
			return true;
		if (
			value.code === "23503" &&
			typeof constraint === "string" &&
			postgresParentConstraints.has(constraint)
		)
			return true;
		if (
			(value.code === "ER_ROW_IS_REFERENCED_2" || value.errno === 1451) &&
			mysqlParentConstraint.test(`${message}\n${sqlMessage}`)
		)
			return true;
		candidate = value.cause;
	}
	return false;
}
