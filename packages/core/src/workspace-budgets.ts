import type { GuardrailBudgetIntent } from './db/guardrail-budget-types';
import { GUARDRAIL_BUDGET_MICROS_PER_UNIT } from './db/guardrail-budget-types';
import { gatewayKeyLimitPeriodBounds } from './gateway-key-limits';

export const WORKSPACE_BUDGET_INTERVALS = ['daily', 'weekly', 'monthly', 'lifetime'] as const;
export type WorkspaceBudgetInterval = (typeof WORKSPACE_BUDGET_INTERVALS)[number];

export const WORKSPACE_BUDGET_INTENT_PREFIX = 'workspace-budget:';
export const WORKSPACE_BUDGET_MAX_EPOCH = 2_147_483_646;

export type WorkspaceBudgetRow = {
	id: string;
	workspace_id: string;
	reset_interval: WorkspaceBudgetInterval;
	limit_micros: number;
	config_epoch: number;
	workspace_created_at: string;
	created_at: string;
	updated_at: string;
};

/** Current accounting snapshot for a configured Workspace budget interval. */
export type WorkspaceBudgetUsageRow = WorkspaceBudgetRow & {
	period_start: string;
	period_end: string;
	/** Committed usage: direct charges plus settled reservations. */
	spent_micros: number;
	/** Capacity held by requests that have not reached a terminal settlement. */
	reserved_micros: number;
	/** Capacity available for a new admission at the time of this snapshot. */
	remaining_micros: number;
};

const INTERVAL_RANK: Record<WorkspaceBudgetInterval, number> = {
	daily: 0,
	weekly: 1,
	monthly: 2,
	lifetime: 3,
};

export function normalizeWorkspaceBudgetInterval(value: unknown): WorkspaceBudgetInterval {
	if (value === 'daily' || value === 'weekly' || value === 'monthly' || value === 'lifetime') return value;
	throw new TypeError('interval must be daily, weekly, monthly, or lifetime');
}

export function normalizeWorkspaceBudgetLimitMicros(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new TypeError('limit_usd must be a positive finite number');
	}
	const scaled = Math.round(value * GUARDRAIL_BUDGET_MICROS_PER_UNIT);
	if (!Number.isSafeInteger(scaled) || scaled <= 0) throw new TypeError('limit_usd is outside the supported range');
	return scaled;
}

export function workspaceBudgetAmount(micros: number): number {
	if (!Number.isSafeInteger(micros) || micros <= 0) throw new TypeError('Workspace budget limit is invalid');
	return micros / GUARDRAIL_BUDGET_MICROS_PER_UNIT;
}

export function workspaceBudgetUsageAmount(micros: number): number {
	if (!Number.isSafeInteger(micros) || micros < 0) throw new TypeError('Workspace budget usage amount is invalid');
	return micros / GUARDRAIL_BUDGET_MICROS_PER_UNIT;
}

export function validateWorkspaceBudgetOrdering(
	budgets: ReadonlyArray<Pick<WorkspaceBudgetRow, 'reset_interval' | 'limit_micros'>>,
): string | null {
	const byInterval = new Map<WorkspaceBudgetInterval, number>();
	for (const budget of budgets) {
		if (!Number.isSafeInteger(budget.limit_micros) || budget.limit_micros <= 0) {
			return 'Workspace budget limits must be positive safe integers';
		}
		if (byInterval.has(budget.reset_interval)) return 'Only one budget per interval is allowed';
		byInterval.set(budget.reset_interval, budget.limit_micros);
	}
	const configured = [...byInterval.entries()].sort(
		([left], [right]) => INTERVAL_RANK[left] - INTERVAL_RANK[right],
	);
	for (let index = 1; index < configured.length; index += 1) {
		const narrower = configured[index - 1]!;
		const broader = configured[index]!;
		if (broader[1] <= narrower[1]) {
			return `Workspace budget limits must satisfy lifetime > monthly > weekly > daily; ${broader[0]} must exceed ${narrower[0]}`;
		}
	}
	return null;
}

export function buildWorkspaceBudgetIntent(
	row: WorkspaceBudgetRow,
	now = new Date(),
): GuardrailBudgetIntent {
	const interval = normalizeWorkspaceBudgetInterval(row.reset_interval);
	if (!Number.isSafeInteger(row.limit_micros) || row.limit_micros <= 0) {
		throw new TypeError('Workspace budget limit is invalid');
	}
	if (!Number.isSafeInteger(row.config_epoch) || row.config_epoch < 0 || row.config_epoch > WORKSPACE_BUDGET_MAX_EPOCH) {
		throw new TypeError('Workspace budget epoch is invalid');
	}
	const bounds = gatewayKeyLimitPeriodBounds(
		interval === 'lifetime' ? null : interval,
		now,
		row.workspace_created_at,
	);
	const systemId = `${WORKSPACE_BUDGET_INTENT_PREFIX}${row.id}`;
	return {
		workspaceId: row.workspace_id,
		assignmentId: systemId,
		guardrailId: systemId,
		guardrailVersion: row.config_epoch + 1,
		scopeType: 'workspace',
		scopeId: row.workspace_id,
		period: bounds.period,
		periodStart: bounds.start,
		periodEnd: bounds.end,
		limitMicros: row.limit_micros,
	};
}

export function isWorkspaceBudgetIntent(intent: GuardrailBudgetIntent): boolean {
	return intent.scopeType === 'workspace'
		&& intent.scopeId === intent.workspaceId
		&& intent.assignmentId.startsWith(WORKSPACE_BUDGET_INTENT_PREFIX)
		&& intent.guardrailId === intent.assignmentId;
}
