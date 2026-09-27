/** Exact database guard signature for credited shared-key earning history. */
const SQLITE_HISTORY_ERROR = 'credited_shared_key_earning_history_immutable';
const POSTGRES_HISTORY_ERROR = 'Credited shared-key earning history is immutable';
const POSTGRES_HISTORY_CONSTRAINT = 'shared_key_earnings_history_immutable';

export function isSharedKeyEarningHistoryDeleteError(error: unknown): boolean {
	const seen = new Set<object>();
	let candidate: unknown = error;
	for (let depth = 0; depth < 5 && candidate && typeof candidate === 'object'; depth++) {
		if (seen.has(candidate)) return false;
		seen.add(candidate);
		const value = candidate as {
			code?: unknown;
			constraint?: unknown;
			constraint_name?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		const message = typeof value.message === 'string' ? value.message : '';
		if (message.includes(SQLITE_HISTORY_ERROR)) return true;
		if (value.code === '23514' && (
			value.constraint === POSTGRES_HISTORY_CONSTRAINT ||
			value.constraint_name === POSTGRES_HISTORY_CONSTRAINT ||
			message.includes(POSTGRES_HISTORY_ERROR)
		)) return true;
		candidate = value.cause;
	}
	return false;
}
