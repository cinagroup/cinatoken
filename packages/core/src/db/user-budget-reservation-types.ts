export const USER_BUDGET_MICROS_PER_UNIT = 1_000_000;
export const USER_BUDGET_MAX_SAFE_MICROS = Number.MAX_SAFE_INTEGER;

export type UserBudgetReservationState =
	| 'reserved'
	| 'dispatched'
	| 'settled'
	| 'released'
	| 'expired';

/** Immutable ordinary-user budget admission captured before upstream dispatch. */
export type UserBudgetReservationRow = {
	request_id: string;
	user_id: string;
	api_key_id: string;
	budget_epoch: number | string;
	limit_micros: number | string;
	reserved_micros: number | string;
	settled_micros: number | string;
	state: UserBudgetReservationState;
	expires_at: string;
	dispatched_at: string | null;
	terminal_at: string | null;
	terminal_reason: string | null;
	created_at: string;
	updated_at: string;
};

export type UserBudgetAccountRow = {
	id: string;
	budget_max: number | string | null;
	budget_spent: number | string;
	budget_period: string;
	budget_reset_at: string | null;
	budget_epoch: number | string;
	budget_reserved_micros: number | string;
};

export type ReserveUserBudgetParams = {
	requestId: string;
	userId: string;
	apiKeyId: string;
	/** Budget epoch captured by authentication; admission must compare it atomically. */
	expectedBudgetEpoch: number;
	reservedMicros: number;
	nowIso: string;
	expiresAtIso: string;
};

export type UserBudgetReservationSnapshot = {
	requestId: string;
	userId: string;
	apiKeyId: string;
	budgetEpoch: number;
	limitMicros: number;
	reservedMicros: number;
};

export type ReserveUserBudgetResult =
	| { status: 'reserved' | 'idempotent'; reservation: UserBudgetReservationSnapshot }
	| { status: 'unlimited' }
	| { status: 'blocked'; remainingMicros: number }
	| { status: 'stale'; budgetResetAt: string | null }
	| { status: 'conflict'; message: string };

/** Settlement is consumed by the request-log critical write, never as a detached write. */
export type UserBudgetSettlement = {
	requestId: string;
	/** actual reconciles metered usage; reserved charges the ceiling when usage is unknowable. */
	mode: 'actual' | 'reserved';
	reason: string;
};

export function userBudgetUnits(value: number, mode: 'nearest' | 'ceiling' = 'nearest'): number {
	if (value === Number.POSITIVE_INFINITY) return USER_BUDGET_MAX_SAFE_MICROS;
	if (!Number.isFinite(value) || value <= 0) return 0;
	const scaled = value * USER_BUDGET_MICROS_PER_UNIT;
	if (!Number.isFinite(scaled) || scaled >= USER_BUDGET_MAX_SAFE_MICROS) {
		return USER_BUDGET_MAX_SAFE_MICROS;
	}
	const rounded = mode === 'ceiling' ? Math.ceil(scaled) : Math.round(scaled);
	return Number.isSafeInteger(rounded) ? rounded : USER_BUDGET_MAX_SAFE_MICROS;
}

export function userBudgetAmount(micros: number): number {
	if (!Number.isSafeInteger(micros) || micros <= 0) return 0;
	return micros / USER_BUDGET_MICROS_PER_UNIT;
}

export function isSafeUserBudgetMicros(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}
