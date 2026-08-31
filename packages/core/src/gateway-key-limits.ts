import type { GatewayKeyLimitReset } from './db/api-keys-types';
import {
	GUARDRAIL_BUDGET_MICROS_PER_UNIT,
	type GuardrailBudgetIntent,
} from './db/guardrail-budget-types';
import type { ApiKeyRow } from './types';

export const GATEWAY_KEY_LIMIT_INTENT_PREFIX = 'gateway-key-limit:';
export const GATEWAY_KEY_LIMIT_FOREVER = '9999-12-31T23:59:59.999Z';
export const GATEWAY_KEY_LIMIT_MAX_EPOCH = 2_147_483_646;

function utcDate(value: string): Date {
	const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/u.test(value);
	const normalized = explicitZone ? value : `${value.replace(' ', 'T')}Z`;
	const date = new Date(normalized);
	if (!Number.isFinite(date.getTime())) throw new TypeError('Gateway key timestamp is invalid');
	return date;
}

export function normalizeGatewayKeyLimitMicros(value: unknown): number | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new TypeError('limit must be a non-negative finite number or null');
	}
	const scaled = Math.round(value * GUARDRAIL_BUDGET_MICROS_PER_UNIT);
	if (!Number.isSafeInteger(scaled)) throw new TypeError('limit is too large');
	return scaled;
}

export function normalizeGatewayKeyLimitReset(value: unknown): GatewayKeyLimitReset {
	if (value === null || value === undefined) return null;
	if (value === 'daily' || value === 'weekly' || value === 'monthly') return value;
	throw new TypeError('limit_reset must be daily, weekly, monthly, or null');
}

export function gatewayKeyLimitAmount(micros: number | null): number | null {
	if (micros === null) return null;
	if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError('Gateway key limit is invalid');
	return micros / GUARDRAIL_BUDGET_MICROS_PER_UNIT;
}

export function gatewayKeyLimitPeriodBounds(
	reset: GatewayKeyLimitReset,
	now: Date,
	createdAt: string,
): { period: GuardrailBudgetIntent['period']; start: string; end: string } {
	if (reset === null) {
		return { period: 'lifetime', start: utcDate(createdAt).toISOString(), end: GATEWAY_KEY_LIMIT_FOREVER };
	}
	const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
	if (reset === 'weekly') {
		const day = start.getUTCDay();
		start.setUTCDate(start.getUTCDate() - (day === 0 ? 6 : day - 1));
	} else if (reset === 'monthly') {
		start.setUTCDate(1);
	}
	const end = new Date(start);
	if (reset === 'daily') end.setUTCDate(end.getUTCDate() + 1);
	else if (reset === 'weekly') end.setUTCDate(end.getUTCDate() + 7);
	else end.setUTCMonth(end.getUTCMonth() + 1);
	return { period: reset, start: start.toISOString(), end: end.toISOString() };
}

export function buildGatewayKeyLimitIntent(row: ApiKeyRow, now = new Date()): GuardrailBudgetIntent | null {
	if (row.limit_micros === null) return null;
	if (!Number.isSafeInteger(row.limit_micros) || row.limit_micros < 0) {
		throw new TypeError('Gateway key limit is invalid');
	}
	if (!Number.isSafeInteger(row.limit_epoch) || row.limit_epoch < 0 || row.limit_epoch > GATEWAY_KEY_LIMIT_MAX_EPOCH) {
		throw new TypeError('Gateway key limit epoch is invalid');
	}
	const bounds = gatewayKeyLimitPeriodBounds(row.limit_reset, now, row.created_at);
	const systemId = `${GATEWAY_KEY_LIMIT_INTENT_PREFIX}${row.id}`;
	return {
		workspaceId: row.workspace_id,
		assignmentId: systemId,
		guardrailId: systemId,
		guardrailVersion: row.limit_epoch + 1,
		scopeType: 'api_key',
		scopeId: row.id,
		period: bounds.period,
		periodStart: bounds.start,
		periodEnd: bounds.end,
		limitMicros: row.limit_micros,
	};
}

export function isGatewayKeyLimitIntent(intent: GuardrailBudgetIntent): boolean {
	const expected = `${GATEWAY_KEY_LIMIT_INTENT_PREFIX}${intent.scopeId}`;
	return intent.scopeType === 'api_key'
		&& intent.assignmentId === expected
		&& intent.guardrailId === expected;
}
