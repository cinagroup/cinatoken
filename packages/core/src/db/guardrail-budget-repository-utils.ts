import type {
	GuardrailBudgetIntent,
	GuardrailBudgetReservationRow,
	GuardrailBudgetSettlementBasis,
	ExtendDispatchedGuardrailBudgetsParams,
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
	const settlementBasis: GuardrailBudgetSettlementBasis = params.settlementBasis ?? 'charged';
	if (settlementBasis !== 'charged' && settlementBasis !== 'gateway_key_route') {
		return 'settlementBasis is invalid';
	}
	if (
		settlementBasis === 'gateway_key_route'
		&& (params.intents.length !== 1 || !isGatewayKeyLimitIntent(params.intents[0]!))
	) {
		return 'gateway_key_route settlement requires exactly one Gateway key limit intent';
	}
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

export function guardrailBudgetReservationMatchesIntent(
	row: GuardrailBudgetReservationRow,
	intent: GuardrailBudgetIntent,
	reservedMicros?: number,
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
		&& (reservedMicros === undefined || Number(row.reserved_micros) === reservedMicros);
}

export function existingGuardrailReservationReplay(
	rows: GuardrailBudgetReservationRow[],
	params: ReserveGuardrailBudgetsParams,
): 'none' | 'idempotent' | 'conflict' {
	if (rows.length === 0) return 'none';
	if (rows.length !== params.intents.length) return 'conflict';
	if (rows.some((row) => row.state !== 'reserved' && row.state !== 'dispatched')) return 'conflict';
	const byAssignment = new Map(rows.map((row) => [row.assignment_id, row]));
	const settlementBasis = params.settlementBasis ?? 'charged';
	return params.intents.every((intent) => {
		const row = byAssignment.get(intent.assignmentId);
		return row
			? row.settlement_basis === settlementBasis
				&& guardrailBudgetReservationMatchesIntent(row, intent, params.reservedMicros)
			: false;
	}) ? 'idempotent' : 'conflict';
}

export type GuardrailBudgetExtensionClassification =
	| { status: 'extend'; missingIntents: GuardrailBudgetIntent[] }
	| { status: 'idempotent' }
	| { status: 'conflict'; message: string };

/**
 * Validate the only supported reservation expansion: a dispatched,
 * route-selective Gateway Key reservation may gain charged-budget intents
 * immediately before shared/platform fallback.
 */
export function classifyDispatchedGuardrailBudgetExtension(
	rows: GuardrailBudgetReservationRow[],
	params: ExtendDispatchedGuardrailBudgetsParams,
): GuardrailBudgetExtensionClassification {
	const invalid = validateGuardrailBudgetReservationParams({
		...params,
		settlementBasis: 'charged',
	});
	if (invalid) return { status: 'conflict', message: invalid };
	if (rows.length === 0) {
		return { status: 'conflict', message: 'request has no dispatched BYOK Gateway key reservation' };
	}
	if (rows.some((row) => row.state !== 'dispatched')) {
		return { status: 'conflict', message: 'request reservation is not fully dispatched' };
	}

	const routeRows = rows.filter((row) => row.settlement_basis === 'gateway_key_route');
	if (routeRows.length !== 1) {
		return { status: 'conflict', message: 'request has no unique route-selective Gateway key reservation' };
	}
	const routeRow = routeRows[0]!;
	if (
		routeRow.scope_type !== 'api_key'
		|| routeRow.assignment_id !== `gateway-key-limit:${routeRow.scope_id}`
		|| routeRow.guardrail_id !== routeRow.assignment_id
	) {
		return { status: 'conflict', message: 'route-selective reservation is not a Gateway key limit' };
	}

	const byAssignment = new Map(params.intents.map((intent) => [intent.assignmentId, intent]));
	for (const row of rows) {
		const intent = byAssignment.get(row.assignment_id);
		if (!intent || !guardrailBudgetReservationMatchesIntent(
			row,
			intent,
			row.settlement_basis === 'charged' ? params.reservedMicros : undefined,
		)) {
			return { status: 'conflict', message: 'request id reservation payload mismatch' };
		}
		if (row !== routeRow && row.settlement_basis !== 'charged') {
			return { status: 'conflict', message: 'request has an invalid fallback reservation basis' };
		}
	}

	const routeIntent = byAssignment.get(routeRow.assignment_id);
	if (!routeIntent || !isGatewayKeyLimitIntent(routeIntent)) {
		return { status: 'conflict', message: 'Gateway key limit intent changed during fallback' };
	}
	const missingIntents = sortedGuardrailBudgetIntents(params.intents).filter(
		(intent) => !rows.some((row) => row.assignment_id === intent.assignmentId),
	);
	if (missingIntents.some(isGatewayKeyLimitIntent)) {
		return { status: 'conflict', message: 'fallback cannot replace the admitted Gateway key limit' };
	}
	return missingIntents.length === 0
		? { status: 'idempotent' }
		: { status: 'extend', missingIntents };
}
