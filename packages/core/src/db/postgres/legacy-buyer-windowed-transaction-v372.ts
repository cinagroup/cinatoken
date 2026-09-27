import { sql, type SQL } from 'drizzle-orm';
import {
	changedFieldsToJson,
	computeChangedFields,
	snapshotToJson,
	type UserAuditSnapshot,
} from '../user-audit-snapshot';

/** A method on the caller's existing PostgreSQL Drizzle transaction. */
export type LegacyBuyerWindowedTransactionV372 = {
	execute(query: SQL): PromiseLike<unknown>;
};

const BUYER_LOGIN = 'cinatoken_gateway_buyer_settlement';
const MAX_MICROS = 9_007_199_254_740_991;
const MICROS_PER_UNIT = 1_000_000n;

function validText(value: string, label: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 128
		|| value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} invalid`);
	}
	return value;
}

/**
 * Establish the request lock before the critical writer locks the API key.
 * The v371 SQL and request-log trigger use this same lock. Neither this
 * method nor the staged settlement acknowledges the outer COMMIT.
 */
export async function beginLegacyBuyerWindowedTransactionV372(
	tx: LegacyBuyerWindowedTransactionV372,
	requestId: string,
): Promise<void> {
	if (!tx || typeof tx.execute !== 'function') {
		throw new TypeError('PostgreSQL windowed buyer transaction required');
	}
	const id = validText(requestId, 'request ID');
	const identity = await tx.execute(sql`SELECT current_user AS current_role,
		session_user AS session_role,
		pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
	if (!Array.isArray(identity) || identity.length !== 1
		|| identity[0]?.current_role !== BUYER_LOGIN
		|| identity[0]?.session_role !== BUYER_LOGIN
		|| identity[0]?.transaction_isolation !== 'read committed') {
		throw new TypeError('PostgreSQL windowed buyer transaction LOGIN mismatch');
	}
	await tx.execute(sql`SELECT pg_catalog.pg_advisory_xact_lock(348,
		pg_catalog.hashtext(${id}::text))`);
}

/**
 * Stage v371 after the append-only log INSERT and before the v2 economic
 * event. The SQL derives the charge from that log and transitions both held
 * and applicable unreserved windows under one outer transaction.
 */
export async function stageLegacyBuyerWindowedSettlementV372(
	tx: LegacyBuyerWindowedTransactionV372,
	params: { requestId: string; reason: string; expectedChargeMicros: number },
): Promise<Readonly<{
	status: 'staged_windowed_legacy_settlement';
	requestId: string;
	chargeMicros: number;
	guardrailRows: number;
	unreservedWindowRows: number;
}>> {
	if (!tx || typeof tx.execute !== 'function') {
		throw new TypeError('PostgreSQL windowed buyer transaction required');
	}
	const requestId = validText(params.requestId, 'request ID');
	const reason = validText(params.reason, 'reason');
	if (!Number.isSafeInteger(params.expectedChargeMicros)
		|| params.expectedChargeMicros < 0
		|| params.expectedChargeMicros > MAX_MICROS) {
		throw new TypeError('PostgreSQL windowed buyer expected charge invalid');
	}
	const rows = await tx.execute(sql`SELECT
		cinatoken_gateway.settle_legacy_buyer_windowed_v371(
			${requestId}::text, ${reason}::text) AS value`);
	if (!Array.isArray(rows) || rows.length !== 1
		|| !rows[0]?.value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL windowed buyer staged response invalid');
	}
	const value = rows[0].value as Record<string, unknown>;
	if (value.status !== 'windowed_legacy_settled'
		|| value.requestId !== requestId
		|| value.chargeMicros !== params.expectedChargeMicros
		|| !Number.isSafeInteger(value.guardrailRows)
		|| (value.guardrailRows as number) < 1
		|| (value.guardrailRows as number) > 32
		|| !Number.isSafeInteger(value.unreservedWindowRows)
		|| (value.unreservedWindowRows as number) < 0) {
		throw new TypeError('PostgreSQL windowed buyer staged response mismatch');
	}
	return Object.freeze({
		status: 'staged_windowed_legacy_settlement', requestId,
		chargeMicros: params.expectedChargeMicros,
		guardrailRows: value.guardrailRows as number,
		unreservedWindowRows: value.unreservedWindowRows as number,
	});
}

function exactMicros(value: unknown, label: string): bigint {
	if (typeof value !== 'string'
		|| !/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(value)) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} is not exact decimal money`);
	}
	const negative = value.startsWith('-');
	const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
	const micros = BigInt(whole) * MICROS_PER_UNIT
		+ BigInt(fraction.padEnd(6, '0'));
	if (micros > BigInt(MAX_MICROS)) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} exceeds safe micros`);
	}
	return negative ? -micros : micros;
}

function exactInteger(value: unknown, label: string): number {
	if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} is not an integer`);
	}
	const parsed = BigInt(value);
	if (parsed > BigInt(MAX_MICROS)) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} exceeds safe micros`);
	}
	return Number(parsed);
}

function snapshotMoney(micros: bigint, label: string): number {
	const amount = Number(micros) / Number(MICROS_PER_UNIT);
	if (!Number.isFinite(amount)
		|| !Number.isSafeInteger(Math.round(amount * Number(MICROS_PER_UNIT)))
		|| BigInt(Math.round(amount * Number(MICROS_PER_UNIT))) !== micros) {
		throw new TypeError(`PostgreSQL windowed buyer ${label} loses snapshot precision`);
	}
	return amount;
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== 'string') {
		throw new TypeError(`PostgreSQL windowed buyer ${label} is missing`);
	}
	return value;
}

function nullableString(value: unknown, label: string): string | null {
	return value === null ? null : requiredString(value, label);
}

/**
 * v371 holds the account row lock until the outer transaction ends. Read the
 * account and the settled reservation from that same transaction, then invert
 * the two v368 account deltas. Caller beforeSpent and caller user snapshots do
 * not participate. This is an audit snapshot, not a COMMIT acknowledgement.
 */
export async function readLegacyBuyerWindowedAuditV372(
	tx: LegacyBuyerWindowedTransactionV372,
	params: { requestId: string; userId: string; expectedChargeMicros: number },
): Promise<Readonly<{
	beforeSpent: number;
	afterSpent: number;
	beforeUserSnapshot: string;
	afterUserSnapshot: string;
	changedFields: string | null;
}>> {
	if (!tx || typeof tx.execute !== 'function') {
		throw new TypeError('PostgreSQL windowed buyer transaction required');
	}
	const requestId = validText(params.requestId, 'request ID');
	const userId = validText(params.userId, 'user ID');
	if (!Number.isSafeInteger(params.expectedChargeMicros)
		|| params.expectedChargeMicros < 0
		|| params.expectedChargeMicros > MAX_MICROS) {
		throw new TypeError('PostgreSQL windowed buyer expected charge invalid');
	}
	const rows = await tx.execute(sql`SELECT
		u.id, u.email, u.budget_max::text AS budget_max,
		u.budget_base::text AS budget_base,
		u.budget_spent::text AS budget_spent,
		u.budget_period, u.budget_reset_at::text AS budget_reset_at,
		u.budget_epoch::text AS budget_epoch,
		u.budget_reserved_micros::text AS budget_reserved_micros,
		u.status, u.metadata, u.charged_cost_factors,
		u.external_system, u.external_user_id,
		r.user_id AS reservation_user_id,
		r.budget_epoch::text AS reservation_epoch,
		r.reserved_micros::text AS held_micros,
		r.settled_micros::text AS settled_micros,
		r.state AS reservation_state
		FROM cinatoken_gateway.users u
		JOIN cinatoken_gateway.user_budget_reservations r
			ON r.user_id = u.id
		WHERE u.id = ${userId} AND r.request_id = ${requestId}`);
	if (!Array.isArray(rows) || rows.length !== 1
		|| !rows[0] || typeof rows[0] !== 'object') {
		throw new TypeError('PostgreSQL windowed buyer audit rows missing');
	}
	const row = rows[0] as Record<string, unknown>;
	const epoch = exactInteger(row.budget_epoch, 'account epoch');
	const heldMicros = exactInteger(row.held_micros, 'held amount');
	const settledMicros = exactInteger(row.settled_micros, 'settled amount');
	const afterReservedMicros = exactInteger(row.budget_reserved_micros,
		'account reserved amount');
	const afterSpentMicros = exactMicros(row.budget_spent, 'account spent amount');
	const beforeSpentMicros = afterSpentMicros - BigInt(settledMicros);
	const beforeReservedMicros = BigInt(afterReservedMicros) + BigInt(heldMicros);
	if (row.id !== userId || row.reservation_user_id !== userId
		|| row.reservation_state !== 'settled'
		|| exactInteger(row.reservation_epoch, 'reservation epoch') !== epoch
		|| settledMicros !== params.expectedChargeMicros
		|| heldMicros < settledMicros
		|| beforeSpentMicros < 0n
		|| beforeReservedMicros > BigInt(MAX_MICROS)) {
		throw new TypeError('PostgreSQL windowed buyer audit account/hold differs');
	}
	const after: UserAuditSnapshot = {
		id: userId,
		email: requiredString(row.email, 'email'),
		budget_max: row.budget_max === null ? null
			: snapshotMoney(exactMicros(row.budget_max, 'budget maximum'), 'budget maximum'),
		budget_base: snapshotMoney(exactMicros(row.budget_base, 'budget base'), 'budget base'),
		budget_spent: snapshotMoney(afterSpentMicros, 'after spent'),
		budget_period: requiredString(row.budget_period, 'budget period'),
		budget_reset_at: nullableString(row.budget_reset_at, 'budget reset time'),
		budget_epoch: epoch,
		budget_reserved_micros: afterReservedMicros,
		status: requiredString(row.status, 'status'),
		metadata: nullableString(row.metadata, 'metadata'),
		charged_cost_factors: nullableString(row.charged_cost_factors, 'cost factors'),
		external_system: nullableString(row.external_system, 'external system'),
		external_user_id: nullableString(row.external_user_id, 'external user ID'),
	};
	const before: UserAuditSnapshot = {
		...after,
		budget_spent: snapshotMoney(beforeSpentMicros, 'before spent'),
		budget_reserved_micros: Number(beforeReservedMicros),
	};
	return Object.freeze({
		beforeSpent: before.budget_spent,
		afterSpent: after.budget_spent,
		beforeUserSnapshot: snapshotToJson(before),
		afterUserSnapshot: snapshotToJson(after),
		changedFields: changedFieldsToJson(computeChangedFields(before, after)),
	});
}
