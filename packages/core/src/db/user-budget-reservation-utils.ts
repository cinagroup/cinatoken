import type {
	ReserveUserBudgetParams,
	UserBudgetAccountRow,
	UserBudgetReservationRow,
	UserBudgetReservationSnapshot,
} from './user-budget-reservation-types';
import {
	isSafeUserBudgetMicros,
	userBudgetUnits,
} from './user-budget-reservation-types';

export function validateReserveUserBudgetParams(params: ReserveUserBudgetParams): string | null {
	if (!params.requestId || params.requestId.length > 128) return 'requestId must contain 1-128 characters';
	if (!params.userId || params.userId.length > 512) return 'userId must contain 1-512 characters';
	if (!params.apiKeyId || params.apiKeyId.length > 512) return 'apiKeyId must contain 1-512 characters';
	if (!isSafeUserBudgetMicros(params.expectedBudgetEpoch)) {
		return 'expectedBudgetEpoch must be a non-negative safe integer';
	}
	if (!isSafeUserBudgetMicros(params.reservedMicros) || params.reservedMicros <= 0) {
		return 'reservedMicros must be a positive safe integer';
	}
	const now = new Date(params.nowIso).getTime();
	const expiresAt = new Date(params.expiresAtIso).getTime();
	if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
		return 'expiresAtIso must be after nowIso';
	}
	return null;
}

export function userBudgetAccountIsStale(account: UserBudgetAccountRow, nowIso: string): boolean {
	if (account.budget_period === 'none' || account.budget_reset_at == null) return false;
	const reset = new Date(account.budget_reset_at).getTime();
	const now = new Date(nowIso).getTime();
	return Number.isFinite(reset) && Number.isFinite(now) && reset <= now;
}

export function userBudgetReservationSnapshot(row: UserBudgetReservationRow): UserBudgetReservationSnapshot {
	return {
		requestId: row.request_id,
		userId: row.user_id,
		apiKeyId: row.api_key_id,
		budgetEpoch: Number(row.budget_epoch),
		limitMicros: Number(row.limit_micros),
		reservedMicros: Number(row.reserved_micros),
	};
}

export function existingUserBudgetReservationReplay(
	row: UserBudgetReservationRow | null,
	params: ReserveUserBudgetParams,
): 'none' | 'idempotent' | 'conflict' {
	if (!row) return 'none';
	if (row.state !== 'reserved' && row.state !== 'dispatched') return 'conflict';
	return row.user_id === params.userId
		&& row.api_key_id === params.apiKeyId
		&& Number(row.budget_epoch) === params.expectedBudgetEpoch
		&& Number(row.reserved_micros) === params.reservedMicros
		? 'idempotent'
		: 'conflict';
}

export function userBudgetCapacity(account: UserBudgetAccountRow): {
	limitMicros: number | null;
	spentMicros: number;
	reservedMicros: number;
	remainingMicros: number | null;
} {
	const limitMicros = account.budget_max == null ? null : userBudgetUnits(Number(account.budget_max));
	const spentMicros = userBudgetUnits(Number(account.budget_spent));
	const reservedMicros = Math.min(
		Number.isSafeInteger(Number(account.budget_reserved_micros))
			? Math.max(0, Number(account.budget_reserved_micros))
			: Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER,
	);
	const remainingMicros = limitMicros == null
		? null
		: Math.max(0, limitMicros - Math.min(limitMicros, spentMicros) - Math.min(limitMicros, reservedMicros));
	return { limitMicros, spentMicros, reservedMicros, remainingMicros };
}

export function userBudgetRecoveryLimit(limit: number = 100): number {
	if (!Number.isFinite(limit)) return 100;
	return Math.max(1, Math.min(Math.trunc(limit), 1000));
}
