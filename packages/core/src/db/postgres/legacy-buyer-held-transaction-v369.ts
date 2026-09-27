import { sql, type SQL } from 'drizzle-orm';

/** The execute method on an existing PostgreSQL Drizzle transaction. */
export type LegacyBuyerHeldTransactionV369 = {
	execute(query: SQL): PromiseLike<unknown>;
};

const BUYER_LOGIN = 'cinatoken_gateway_buyer_settlement';
const MAX_MICROS = 9_007_199_254_740_991;

function validText(value: string, label: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 128
		|| value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
		throw new TypeError(`PostgreSQL legacy buyer ${label} invalid`);
	}
	return value;
}

function validMicros(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MICROS) {
		throw new TypeError(`PostgreSQL legacy buyer ${label} invalid`);
	}
	return value;
}

/**
 * Review-only seam for the already-open buyer critical-write transaction.
 * The caller must keep the log, audit, economic event and outer COMMIT on the
 * same `tx`. The return value acknowledges only a staged SQL transition.
 */
export async function stageLegacyBuyerHeldSettlementV369(
	tx: LegacyBuyerHeldTransactionV369,
	params: {
		requestId: string;
		ordinarySettledMicros: number;
		guardrailSettledMicros: number;
		reason: string;
	},
): Promise<Readonly<{
	status: 'staged_legacy_settlement';
	requestId: string;
	ordinarySettledMicros: number;
	guardrailSettledMicros: number;
	guardrailRows: number;
}>> {
	if (!tx || typeof tx.execute !== 'function') {
		throw new TypeError('PostgreSQL legacy buyer transaction required');
	}
	const requestId = validText(params.requestId, 'request ID');
	const reason = validText(params.reason, 'reason');
	const ordinarySettledMicros = validMicros(params.ordinarySettledMicros,
		'ordinary settled micros');
	const guardrailSettledMicros = validMicros(params.guardrailSettledMicros,
		'Guardrail settled micros');
	const identity = await tx.execute(sql`SELECT current_user AS current_role,
		session_user AS session_role,
		pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
	if (!Array.isArray(identity) || identity.length !== 1
		|| identity[0]?.current_role !== BUYER_LOGIN
		|| identity[0]?.session_role !== BUYER_LOGIN
		|| identity[0]?.transaction_isolation !== 'read committed') {
		throw new TypeError('PostgreSQL legacy buyer transaction LOGIN mismatch');
	}
	const rows = await tx.execute(sql`SELECT
		cinatoken_gateway.settle_legacy_buyer_held_v368(
			${requestId}::text,${ordinarySettledMicros}::bigint,
			${guardrailSettledMicros}::bigint,${reason}::text) AS value`);
	if (!Array.isArray(rows) || rows.length !== 1
		|| !rows[0]?.value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL legacy buyer staged response invalid');
	}
	const value = rows[0].value as Record<string, unknown>;
	if (value.status !== 'legacy_settled' || value.requestId !== requestId
		|| value.ordinarySettledMicros !== ordinarySettledMicros
		|| value.guardrailSettledMicros !== guardrailSettledMicros
		|| !Number.isSafeInteger(value.guardrailRows)
		|| (value.guardrailRows as number) < 1
		|| (value.guardrailRows as number) > 32) {
		throw new TypeError('PostgreSQL legacy buyer staged response mismatch');
	}
	return Object.freeze({
		status: 'staged_legacy_settlement', requestId,
		ordinarySettledMicros, guardrailSettledMicros,
		guardrailRows: value.guardrailRows as number,
	});
}
