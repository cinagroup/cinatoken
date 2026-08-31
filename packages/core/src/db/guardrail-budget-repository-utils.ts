import type {
	GuardrailBudgetIntent,
	GuardrailBudgetReservationRow,
	ReserveGuardrailBudgetsParams,
} from './guardrail-budget-types';
import { isSafeGuardrailBudgetMicros } from './guardrail-budget-types';
import { isGatewayKeyLimitIntent } from '../gateway-key-limits';
import { isWorkspaceBudgetIntent } from '../workspace-budgets';

export function guardrailBudgetIntentKey(intent: GuardrailBudgetIntent): string {
	return [intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart, intent.assignmentId].join('\u0000');
}

export function sortedGuardrailBudgetIntents(intents: GuardrailBudgetIntent[]): GuardrailBudgetIntent[] {
	return [...intents].sort((left, right) => guardrailBudgetIntentKey(left).localeCompare(guardrailBudgetIntentKey(right)));
}

export function validateGuardrailBudgetReservationParams(params: ReserveGuardrailBudgetsParams): string | null {
	if (!params.requestId || params.requestId.length > 128) return 'requestId must contain 1-128 characters';
	if (!isSafeGuardrailBudgetMicros(params.reservedMicros) || params.reservedMicros <= 0) {
		return 'reservedMicros must be a positive safe integer';
	}
	if (params.intents.length === 0 || params.intents.length > 7) return 'one to seven budget intents are required';
	const assignments = new Set<string>();
	const windows = new Set<string>();
	for (const intent of params.intents) {
		if (!intent.workspaceId || !intent.assignmentId || !intent.guardrailId || !intent.scopeId) return 'budget intent identifiers are required';
		if (!Number.isInteger(intent.guardrailVersion) || intent.guardrailVersion < 1) return 'guardrailVersion must be positive';
		if (!isSafeGuardrailBudgetMicros(intent.limitMicros) || (intent.limitMicros === 0 && !isGatewayKeyLimitIntent(intent))) {
			return 'limitMicros must be positive except for a Gateway key limit';
		}
		if (intent.scopeType === 'workspace' && !isWorkspaceBudgetIntent(intent)) return 'workspace budget intent is invalid';
		if (!(intent.periodEnd > intent.periodStart)) return 'budget period end must be after its start';
		if (assignments.has(intent.assignmentId)) return 'duplicate Guardrail assignment intent';
		assignments.add(intent.assignmentId);
		const window = [intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart].join('\u0000');
		if (windows.has(window)) return 'duplicate Guardrail budget window intent';
		windows.add(window);
	}
	return null;
}

function rowMatchesIntent(
	row: GuardrailBudgetReservationRow,
	intent: GuardrailBudgetIntent,
	reservedMicros: number,
): boolean {
	return row.workspace_id === intent.workspaceId
		&& row.assignment_id === intent.assignmentId
		&& row.guardrail_id === intent.guardrailId
		&& Number(row.guardrail_version) === intent.guardrailVersion
		&& row.scope_type === intent.scopeType
		&& row.scope_id === intent.scopeId
		&& row.period === intent.period
		&& new Date(row.period_start).toISOString() === new Date(intent.periodStart).toISOString()
		&& new Date(row.period_end).toISOString() === new Date(intent.periodEnd).toISOString()
		&& Number(row.limit_micros) === intent.limitMicros
		&& Number(row.reserved_micros) === reservedMicros;
}

export function existingGuardrailReservationReplay(
	rows: GuardrailBudgetReservationRow[],
	params: ReserveGuardrailBudgetsParams,
): 'none' | 'idempotent' | 'conflict' {
	if (rows.length === 0) return 'none';
	if (rows.length !== params.intents.length) return 'conflict';
	if (rows.some((row) => row.state !== 'reserved' && row.state !== 'dispatched')) return 'conflict';
	const byAssignment = new Map(rows.map((row) => [row.assignment_id, row]));
	return params.intents.every((intent) => {
		const row = byAssignment.get(intent.assignmentId);
		return row ? rowMatchesIntent(row, intent, params.reservedMicros) : false;
	}) ? 'idempotent' : 'conflict';
}
