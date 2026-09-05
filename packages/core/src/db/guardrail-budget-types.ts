import type { GuardrailScopeType } from './guardrails-types';

export const GUARDRAIL_BUDGET_MICROS_PER_UNIT = 1_000_000;

export type GuardrailBudgetPeriod = 'daily' | 'weekly' | 'monthly' | 'lifetime';
export type GuardrailBudgetScopeType = GuardrailScopeType | 'workspace';
export type GuardrailBudgetReservationState =
	| 'reserved'
	| 'dispatched'
	| 'settled'
	| 'released'
	| 'expired';

/**
 * Selects the request-log amount used when an admitted reservation settles.
 * `gateway_key_route` is valid only for the authenticated Gateway Key limit:
 * shared capacity uses the gateway charge, while private BYOK uses the
 * catalog/list-price equivalent recorded on the same request log.
 */
export type GuardrailBudgetSettlementBasis = 'charged' | 'gateway_key_route';

/** Immutable policy/window snapshot carried from Guardrail evaluation to admission. */
export type GuardrailBudgetIntent = {
	workspaceId: string;
	assignmentId: string;
	guardrailId: string;
	guardrailVersion: number;
	scopeType: GuardrailBudgetScopeType;
	scopeId: string;
	period: GuardrailBudgetPeriod;
	periodStart: string;
	periodEnd: string;
	limitMicros: number;
};

export type GuardrailBudgetReservationRow = {
	id: string;
	workspace_id: string;
	request_id: string;
	assignment_id: string;
	guardrail_id: string;
	guardrail_version: number;
	scope_type: GuardrailBudgetScopeType;
	scope_id: string;
	period: GuardrailBudgetPeriod;
	period_start: string;
	period_end: string;
	limit_micros: number | string;
	reserved_micros: number | string;
	settled_micros: number | string;
	settlement_basis: GuardrailBudgetSettlementBasis;
	state: GuardrailBudgetReservationState;
	expires_at: string;
	dispatched_at: string | null;
	terminal_at: string | null;
	terminal_reason: string | null;
	created_at: string;
	updated_at: string;
};

export type ReserveGuardrailBudgetsParams = {
	requestId: string;
	intents: GuardrailBudgetIntent[];
	reservedMicros: number;
	settlementBasis?: GuardrailBudgetSettlementBasis;
	nowIso: string;
	expiresAtIso: string;
};

/**
 * Atomically adds the non-key charged-budget reservations immediately before
 * a request falls back from an already-dispatched private BYOK attempt to
 * shared/platform capacity. The existing Gateway Key reservation remains the
 * request's route-selective reservation.
 */
export type ExtendDispatchedGuardrailBudgetsParams = {
	requestId: string;
	intents: GuardrailBudgetIntent[];
	reservedMicros: number;
	nowIso: string;
	expiresAtIso: string;
};

export type ReserveGuardrailBudgetsResult =
	| { status: 'reserved' | 'idempotent'; reservationCount: number }
	| { status: 'blocked'; assignmentId: string | null }
	| { status: 'conflict'; message: string };

export type GuardrailBudgetSettlement = {
	requestId: string;
	/** actual uses the committed user-budget debit; reserved charges the full ceiling when usage is unknowable. */
	mode: 'actual' | 'reserved';
	reason: string;
};

export function guardrailBudgetUnits(value: number, mode: 'nearest' | 'ceiling' = 'nearest'): number {
	if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER;
	if (!Number.isFinite(value) || value <= 0) return 0;
	const scaled = value * GUARDRAIL_BUDGET_MICROS_PER_UNIT;
	if (!Number.isFinite(scaled) || scaled >= Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
	const rounded = mode === 'ceiling' ? Math.ceil(scaled) : Math.round(scaled);
	return Number.isSafeInteger(rounded) ? rounded : Number.MAX_SAFE_INTEGER;
}

export function guardrailBudgetAmount(micros: number): number {
	if (!Number.isSafeInteger(micros) || micros <= 0) return 0;
	return micros / GUARDRAIL_BUDGET_MICROS_PER_UNIT;
}

export function isSafeGuardrailBudgetMicros(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}
