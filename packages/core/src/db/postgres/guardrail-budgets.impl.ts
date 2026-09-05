import type { PostgresDatabaseClient } from '../../storage/database-client';
import type { GuardrailBudgetsRepository } from '../../storage/gateway-repository-interfaces';
import type {
	GuardrailBudgetIntent,
	GuardrailBudgetReservationRow,
	ReserveGuardrailBudgetsParams,
	ReserveGuardrailBudgetsResult,
} from '../guardrail-budget-types';
import {
	classifyDispatchedGuardrailBudgetExtension,
	existingGuardrailReservationReplay,
	sortedGuardrailBudgetIntents,
	validateGuardrailBudgetReservationParams,
} from '../guardrail-budget-repository-utils';
import { isGatewayKeyLimitIntent } from '../../gateway-key-limits';
import { isWorkspaceBudgetIntent } from '../../workspace-budgets';

class GuardrailBudgetBlockedError extends Error {
	constructor(readonly assignmentId: string) {
		super('guardrail_budget_exceeded');
	}
}

class GatewayKeyLimitStaleError extends Error {
	constructor() {
		super('gateway_key_limit_stale');
	}
}

class WorkspaceBudgetStaleError extends Error {
	constructor() {
		super('workspace_budget_stale');
	}
}

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, parameters?: readonly unknown[]): Promise<T>;
};

async function listByRequest(pg: PgQuery, requestId: string, forUpdate = false): Promise<GuardrailBudgetReservationRow[]> {
	return await pg.unsafe<GuardrailBudgetReservationRow[]>(`SELECT * FROM guardrail_budget_reservations WHERE request_id = $1 ORDER BY assignment_id${forUpdate ? ' FOR UPDATE' : ''}`, [requestId]);
}

async function seedWindow(pg: PgQuery, intent: GuardrailBudgetIntent, nowIso: string): Promise<{ unreserved: number; settled: number; reserved: number }> {
	const inserted = await pg.unsafe<Array<{ inserted: number }>>(`INSERT INTO guardrail_budget_windows (
		workspace_id, scope_type, scope_id, period, period_start, period_end,
		unreserved_micros, settled_micros, reserved_micros, seeded_at, updated_at
	) VALUES ($1, $2, $3, $4, $5, $6, 0, 0, 0, $7, $7)
	ON CONFLICT (workspace_id, scope_type, scope_id, period, period_start) DO NOTHING
	RETURNING 1 AS inserted`, [
		intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart, intent.periodEnd, nowIso,
	]);
	const rows = await pg.unsafe<Array<{ unreserved_micros: string | number; settled_micros: string | number; reserved_micros: string | number }>>(`SELECT unreserved_micros, settled_micros, reserved_micros
		FROM guardrail_budget_windows
		WHERE workspace_id = $1 AND scope_type = $2 AND scope_id = $3 AND period = $4 AND period_start = $5
		FOR UPDATE`, [intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart]);
	const window = rows[0];
	if (!window) throw new Error('guardrail budget window allocation failed');
	if (inserted.length === 0) {
		return {
			unreserved: Number(window.unreserved_micros),
			settled: Number(window.settled_micros),
			reserved: Number(window.reserved_micros),
		};
	}
	const subjectPredicate = intent.scopeType === 'workspace'
		? 'TRUE'
		: `log.${intent.scopeType === 'user' ? 'user_id' : 'api_key_id'} = $1`;
	const unreserved = await pg.unsafe<Array<{ spent: string | number }>>(`SELECT COALESCE(SUM(COALESCE(
		log.budget_charged_micros,
		ROUND(GREATEST(log.charged_cost, 0) * 1000000)::bigint
	)), 0)::bigint AS spent
	FROM api_key_request_logs AS log
	WHERE ${subjectPredicate}
		AND COALESCE(log.budget_accounted_at, log.created_at) >= $2
		AND COALESCE(log.budget_accounted_at, log.created_at) < $3
		AND log.workspace_id = $4
		AND NOT EXISTS (
			SELECT 1 FROM guardrail_budget_reservations AS reservation
			WHERE reservation.request_id = log.id
				AND reservation.workspace_id = $4
				AND reservation.scope_type = $5
				AND reservation.scope_id = $1
				AND reservation.period = $6
				AND reservation.period_start = $2
				AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
		)`, [intent.scopeId, intent.periodStart, intent.periodEnd, intent.workspaceId, intent.scopeType, intent.period]);
	return {
		unreserved: Number(unreserved[0]?.spent ?? 0),
		settled: Number(window.settled_micros),
		reserved: Number(window.reserved_micros),
	};
}

async function validateWorkspaceBudgetIntent(pg: PgQuery, intent: GuardrailBudgetIntent): Promise<void> {
	if (!isWorkspaceBudgetIntent(intent)) return;
	const rows = await pg.unsafe<Array<{
		workspace_id: string;
		reset_interval: string;
		limit_micros: string | number;
		config_epoch: number;
		workspace_status: string;
	}>>(`SELECT budget.workspace_id, budget.reset_interval, budget.limit_micros,
		budget.config_epoch, workspace.status AS workspace_status
		FROM workspace_budgets budget
		JOIN workspaces workspace ON workspace.id = budget.workspace_id
		WHERE budget.id = $1 FOR UPDATE OF budget`, [intent.assignmentId.slice('workspace-budget:'.length)]);
	const row = rows[0];
	if (!row
		|| row.workspace_id !== intent.workspaceId
		|| intent.scopeId !== intent.workspaceId
		|| row.workspace_status !== 'active'
		|| Number(row.limit_micros) !== intent.limitMicros
		|| Number(row.config_epoch) + 1 !== intent.guardrailVersion
		|| row.reset_interval !== intent.period) {
		throw new WorkspaceBudgetStaleError();
	}
}

async function validateGatewayKeyLimitIntent(
	pg: PgQuery,
	intent: GuardrailBudgetIntent,
	nowIso: string,
	settlementBasis: ReserveGuardrailBudgetsParams['settlementBasis'] = 'charged',
): Promise<void> {
	if (!isGatewayKeyLimitIntent(intent)) return;
	const rows = await pg.unsafe<Array<{
		workspace_id: string;
		status: string;
		expires_at: string | null;
		limit_micros: string | number | null;
		limit_reset: string | null;
		include_byok_in_limit: boolean;
		limit_epoch: number;
	}>>(`SELECT workspace_id, status, expires_at, limit_micros, limit_reset,
		include_byok_in_limit, limit_epoch
		FROM api_keys WHERE id = $1 FOR UPDATE`, [intent.scopeId]);
	const row = rows[0];
	const activeAtAdmission = row
		? row.expires_at === null || Date.parse(row.expires_at) > Date.parse(nowIso)
		: false;
	if (!row
		|| row.workspace_id !== intent.workspaceId
		|| row.status !== 'active'
		|| !activeAtAdmission
		|| row.limit_micros === null
		|| Number(row.limit_micros) !== intent.limitMicros
		|| Number(row.limit_epoch) + 1 !== intent.guardrailVersion
		|| (row.limit_reset ?? 'lifetime') !== intent.period
		|| (settlementBasis === 'gateway_key_route' && !row.include_byok_in_limit)) {
		throw new GatewayKeyLimitStaleError();
	}
}

async function classifyReplay(pg: PgQuery, params: ReserveGuardrailBudgetsParams): Promise<ReserveGuardrailBudgetsResult | null> {
	const replay = existingGuardrailReservationReplay(await listByRequest(pg, params.requestId), params);
	if (replay === 'idempotent') return { status: 'idempotent', reservationCount: params.intents.length };
	if (replay === 'conflict') return { status: 'conflict', message: 'request id already has a different Guardrail budget reservation' };
	return null;
}

export function createPostgresGuardrailBudgetsRepository(client: PostgresDatabaseClient): GuardrailBudgetsRepository {
	const pg = client.raw as unknown as PgQuery & { begin<T>(callback: (tx: PgQuery) => Promise<T>): Promise<T> };
	return {
		async reserveMany(params) {
			const invalid = validateGuardrailBudgetReservationParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			const replay = await classifyReplay(pg, params);
			if (replay) return replay;
			try {
				return await pg.begin<ReserveGuardrailBudgetsResult>(async (tx) => {
					const lockedReplay = existingGuardrailReservationReplay(await listByRequest(tx, params.requestId, true), params);
					if (lockedReplay === 'idempotent') return { status: 'idempotent', reservationCount: params.intents.length };
					if (lockedReplay === 'conflict') return { status: 'conflict', message: 'request id reservation payload mismatch' };
					for (const intent of sortedGuardrailBudgetIntents(params.intents)) {
						await validateGatewayKeyLimitIntent(tx, intent, params.nowIso, params.settlementBasis);
						await validateWorkspaceBudgetIntent(tx, intent);
						const window = await seedWindow(tx, intent, params.nowIso);
						if (window.unreserved + window.settled + window.reserved + params.reservedMicros > intent.limitMicros) {
							throw new GuardrailBudgetBlockedError(intent.assignmentId);
						}
						await tx.unsafe(`UPDATE guardrail_budget_windows
							SET unreserved_micros = $1, reserved_micros = reserved_micros + $2,
								period_end = $3, updated_at = $4
							WHERE workspace_id = $5 AND scope_type = $6 AND scope_id = $7 AND period = $8 AND period_start = $9`, [
							window.unreserved, params.reservedMicros, intent.periodEnd, params.nowIso,
							intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart,
						]);
					}
					for (const intent of sortedGuardrailBudgetIntents(params.intents)) {
						await tx.unsafe(`INSERT INTO guardrail_budget_reservations (
							id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
							scope_type, scope_id, period, period_start, period_end,
							limit_micros, reserved_micros, settled_micros, settlement_basis, state,
							expires_at, created_at, updated_at
						) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, $14, 'reserved', $15, $16, $16)`, [
							crypto.randomUUID(), intent.workspaceId, params.requestId, intent.assignmentId, intent.guardrailId,
							intent.guardrailVersion, intent.scopeType, intent.scopeId, intent.period,
							intent.periodStart, intent.periodEnd, intent.limitMicros, params.reservedMicros,
							params.settlementBasis ?? 'charged', params.expiresAtIso, params.nowIso,
						]);
					}
					return { status: 'reserved', reservationCount: params.intents.length };
				});
			} catch (error) {
				const racedReplay = await classifyReplay(pg, params);
				if (racedReplay) return racedReplay;
				if (error instanceof GuardrailBudgetBlockedError) return { status: 'blocked', assignmentId: error.assignmentId };
				if (error instanceof GatewayKeyLimitStaleError) {
					return { status: 'conflict', message: 'Gateway key limit configuration changed; retry the request' };
				}
				if (error instanceof WorkspaceBudgetStaleError) {
					return { status: 'conflict', message: 'Workspace budget configuration changed; retry the request' };
				}
				throw error;
			}
		},

		async extendDispatched(params) {
			try {
				return await pg.begin<ReserveGuardrailBudgetsResult>(async (tx) => {
					const rows = await listByRequest(tx, params.requestId, true);
					const classification = classifyDispatchedGuardrailBudgetExtension(rows, params);
					if (classification.status === 'conflict') {
						return { status: 'conflict', message: classification.message };
					}
					if (classification.status === 'idempotent') {
						return { status: 'idempotent', reservationCount: params.intents.length };
					}
					for (const intent of classification.missingIntents) {
						await validateGatewayKeyLimitIntent(tx, intent, params.nowIso, 'charged');
						await validateWorkspaceBudgetIntent(tx, intent);
						const window = await seedWindow(tx, intent, params.nowIso);
						if (window.unreserved + window.settled + window.reserved + params.reservedMicros > intent.limitMicros) {
							throw new GuardrailBudgetBlockedError(intent.assignmentId);
						}
						await tx.unsafe(`UPDATE guardrail_budget_windows
							SET unreserved_micros = $1, reserved_micros = reserved_micros + $2,
								period_end = $3, updated_at = $4
							WHERE workspace_id = $5 AND scope_type = $6 AND scope_id = $7 AND period = $8 AND period_start = $9`, [
							window.unreserved, params.reservedMicros, intent.periodEnd, params.nowIso,
							intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, intent.periodStart,
						]);
						await tx.unsafe(`INSERT INTO guardrail_budget_reservations (
							id, workspace_id, request_id, assignment_id, guardrail_id, guardrail_version,
							scope_type, scope_id, period, period_start, period_end,
							limit_micros, reserved_micros, settled_micros, settlement_basis, state,
							expires_at, dispatched_at, created_at, updated_at
						) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 0, 'charged', 'dispatched', $14, $15, $15, $15)`, [
							crypto.randomUUID(), intent.workspaceId, params.requestId, intent.assignmentId, intent.guardrailId,
							intent.guardrailVersion, intent.scopeType, intent.scopeId, intent.period,
							intent.periodStart, intent.periodEnd, intent.limitMicros, params.reservedMicros,
							params.expiresAtIso, params.nowIso,
						]);
					}
					return { status: 'reserved', reservationCount: params.intents.length };
				});
			} catch (error) {
				if (error instanceof GuardrailBudgetBlockedError) {
					return { status: 'blocked', assignmentId: error.assignmentId };
				}
				if (error instanceof GatewayKeyLimitStaleError) {
					return { status: 'conflict', message: 'Gateway key limit configuration changed; retry the request' };
				}
				if (error instanceof WorkspaceBudgetStaleError) {
					return { status: 'conflict', message: 'Workspace budget configuration changed; retry the request' };
				}
				throw error;
			}
		},

		async markDispatched(requestId, nowIso, expiresAtIso) {
			return await pg.begin(async (tx) => {
				const rows = await listByRequest(tx, requestId, true);
				if (rows.length === 0) return false;
				if (rows.every((row) => row.state === 'dispatched')) return true;
				if (!rows.every((row) => row.state === 'reserved')) return false;
				await tx.unsafe(`UPDATE guardrail_budget_reservations SET state = 'dispatched', dispatched_at = $1, expires_at = $2, updated_at = $1 WHERE request_id = $3 AND state = 'reserved'`, [nowIso, expiresAtIso, requestId]);
				return true;
			});
		},

		async releaseMany(requestId, nowIso, reason) {
			return await pg.begin(async (tx) => {
				const rows = (await listByRequest(tx, requestId, true)).filter((row) => row.state === 'reserved');
				for (const row of rows.sort((a, b) => [a.workspace_id, a.scope_type, a.scope_id, a.period, a.period_start].join('\u0000').localeCompare([b.workspace_id, b.scope_type, b.scope_id, b.period, b.period_start].join('\u0000')))) {
					await tx.unsafe(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - $1, updated_at = $2 WHERE workspace_id = $3 AND scope_type = $4 AND scope_id = $5 AND period = $6 AND period_start = $7`, [Number(row.reserved_micros), nowIso, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
				}
				if (rows.length > 0) await tx.unsafe(`UPDATE guardrail_budget_reservations SET state = 'released', settled_micros = 0, terminal_at = $1, terminal_reason = $2, updated_at = $1 WHERE request_id = $3 AND state = 'reserved'`, [nowIso, reason.slice(0, 128), requestId]);
				return rows.length;
			});
		},

		async forfeitMany(requestId, nowIso, reason) {
			return await pg.begin(async (tx) => {
				const rows = (await listByRequest(tx, requestId, true)).filter((row) => row.state === 'reserved' || row.state === 'dispatched');
				for (const row of rows.sort((a, b) => [a.workspace_id, a.scope_type, a.scope_id, a.period, a.period_start].join('\u0000').localeCompare([b.workspace_id, b.scope_type, b.scope_id, b.period, b.period_start].join('\u0000')))) {
					await tx.unsafe(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - $1, settled_micros = settled_micros + $1, updated_at = $2 WHERE workspace_id = $3 AND scope_type = $4 AND scope_id = $5 AND period = $6 AND period_start = $7`, [Number(row.reserved_micros), nowIso, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
				}
				if (rows.length > 0) await tx.unsafe(`UPDATE guardrail_budget_reservations SET state = 'expired', settled_micros = reserved_micros, terminal_at = $1, terminal_reason = $2, updated_at = $1 WHERE request_id = $3 AND state IN ('reserved', 'dispatched')`, [nowIso, reason.slice(0, 128), requestId]);
				return rows.length;
			});
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = Math.max(1, Math.min(Math.trunc(limit), 1000));
			return await pg.begin(async (tx) => {
				const rows = await tx.unsafe<GuardrailBudgetReservationRow[]>(`SELECT * FROM guardrail_budget_reservations WHERE state IN ('reserved', 'dispatched') AND expires_at <= $1 ORDER BY workspace_id, scope_type, scope_id, period, period_start, id FOR UPDATE SKIP LOCKED LIMIT $2`, [nowIso, bounded]);
				for (const row of rows) {
					const settled = row.state === 'dispatched' ? Number(row.reserved_micros) : 0;
					await tx.unsafe(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - $1, settled_micros = settled_micros + $2, updated_at = $3 WHERE workspace_id = $4 AND scope_type = $5 AND scope_id = $6 AND period = $7 AND period_start = $8`, [Number(row.reserved_micros), settled, nowIso, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
					await tx.unsafe(`UPDATE guardrail_budget_reservations SET state = $1, settled_micros = $2, terminal_at = $3, terminal_reason = $4, updated_at = $3 WHERE id = $5 AND state = $6`, [row.state === 'dispatched' ? 'expired' : 'released', settled, nowIso, row.state === 'dispatched' ? 'lease_expired_after_dispatch' : 'lease_expired_before_dispatch', row.id, row.state]);
				}
				return rows.length;
			});
		},
	};
}
