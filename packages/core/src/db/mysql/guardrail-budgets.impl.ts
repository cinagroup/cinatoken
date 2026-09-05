import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MySqlDatabaseClient } from '../../storage/database-client';
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
import { toMySqlDateTime } from './mysql2-compat';
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

function errorNumber(error: unknown): number | null {
	return typeof error === 'object' && error !== null && 'errno' in error && typeof error.errno === 'number'
		? error.errno
		: null;
}

async function listByRequest(connection: Pool | PoolConnection, requestId: string, forUpdate = false): Promise<GuardrailBudgetReservationRow[]> {
	const [rows] = await connection.query<Array<GuardrailBudgetReservationRow & RowDataPacket>>(`SELECT * FROM guardrail_budget_reservations WHERE request_id = ? ORDER BY assignment_id${forUpdate ? ' FOR UPDATE' : ''}`, [requestId]);
	return rows;
}

async function seedWindow(connection: PoolConnection, intent: GuardrailBudgetIntent, nowIso: string): Promise<{ unreserved: number; settled: number; reserved: number }> {
	const now = toMySqlDateTime(nowIso);
	const periodStart = toMySqlDateTime(intent.periodStart);
	const periodEnd = toMySqlDateTime(intent.periodEnd);
	const [insertResult] = await connection.execute<ResultSetHeader>(`INSERT IGNORE INTO guardrail_budget_windows (
		workspace_id, workspace_key, scope_type, scope_id, period, period_start, period_end,
		unreserved_micros, settled_micros, reserved_micros, seeded_at, updated_at
	) VALUES (?, SHA2(?, 256), ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`, [
		intent.workspaceId, intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, periodStart, periodEnd, now, now,
	]);
	const [windows] = await connection.query<Array<RowDataPacket & { unreserved_micros: number | string; settled_micros: number | string; reserved_micros: number | string }>>(`SELECT unreserved_micros, settled_micros, reserved_micros
		FROM guardrail_budget_windows
		WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?
		FOR UPDATE`, [intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, periodStart]);
	const window = windows[0];
	if (!window) throw new Error('guardrail budget window allocation failed');
	if (insertResult.affectedRows === 0) {
		return {
			unreserved: Number(window.unreserved_micros),
			settled: Number(window.settled_micros),
			reserved: Number(window.reserved_micros),
		};
	}
	const subjectPredicate = intent.scopeType === 'workspace'
		? 'TRUE'
		: `log.${intent.scopeType === 'user' ? 'user_id' : 'api_key_id'} = ?`;
	const [unreservedRows] = await connection.query<Array<RowDataPacket & { spent: number | string }>>(`SELECT COALESCE(SUM(COALESCE(
		log.budget_charged_micros,
		CAST(ROUND(GREATEST(log.charged_cost, 0) * 1000000) AS SIGNED)
	)), 0) AS spent
	FROM api_key_request_logs AS log
	WHERE ${subjectPredicate}
		AND log.budget_accounted_effective_at >= ?
		AND log.budget_accounted_effective_at < ?
		AND log.workspace_id = ?
		AND NOT EXISTS (
			SELECT 1 FROM guardrail_budget_reservations AS reservation
			WHERE reservation.request_id = log.id
				AND reservation.workspace_id = ?
				AND reservation.scope_type = ?
				AND reservation.scope_id = ?
				AND reservation.period = ?
				AND reservation.period_start = ?
				AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
		)`, [
		...(intent.scopeType === 'workspace' ? [] : [intent.scopeId]), periodStart, periodEnd,
		intent.workspaceId, intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, periodStart,
	]);
	return {
		unreserved: Number(unreservedRows[0]?.spent ?? 0),
		settled: Number(window.settled_micros),
		reserved: Number(window.reserved_micros),
	};
}

async function validateWorkspaceBudgetIntent(connection: PoolConnection, intent: GuardrailBudgetIntent): Promise<void> {
	if (!isWorkspaceBudgetIntent(intent)) return;
	const [rows] = await connection.query<Array<RowDataPacket & {
		workspace_id: string;
		reset_interval: string;
		limit_micros: string | number;
		config_epoch: string | number;
		workspace_status: string;
	}>>(`SELECT budget.workspace_id, budget.reset_interval, budget.limit_micros,
		budget.config_epoch, workspace.status AS workspace_status
		FROM workspace_budgets budget
		JOIN workspaces workspace ON workspace.id = budget.workspace_id
		WHERE budget.id = ? FOR UPDATE`, [intent.assignmentId.slice('workspace-budget:'.length)]);
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
	connection: PoolConnection,
	intent: GuardrailBudgetIntent,
	nowIso: string,
	settlementBasis: ReserveGuardrailBudgetsParams['settlementBasis'] = 'charged',
): Promise<void> {
	if (!isGatewayKeyLimitIntent(intent)) return;
	const [rows] = await connection.query<Array<RowDataPacket & {
		workspace_id: string;
		status: string;
		expires_at: string | Date | null;
		limit_micros: string | number | null;
		limit_reset: string | null;
		include_byok_in_limit: string | number;
		limit_epoch: string | number;
	}>>(`SELECT workspace_id, status, expires_at, limit_micros, limit_reset,
		include_byok_in_limit, limit_epoch
		FROM api_keys WHERE id = ? FOR UPDATE`, [intent.scopeId]);
	const row = rows[0];
	const expiresAt = row?.expires_at instanceof Date
		? row.expires_at.getTime()
		: row?.expires_at === null || row?.expires_at === undefined
			? Number.POSITIVE_INFINITY
			: Date.parse(`${String(row.expires_at).replace(' ', 'T')}Z`);
	if (!row
		|| row.workspace_id !== intent.workspaceId
		|| row.status !== 'active'
		|| expiresAt <= Date.parse(nowIso)
		|| row.limit_micros === null
		|| Number(row.limit_micros) !== intent.limitMicros
		|| Number(row.limit_epoch) + 1 !== intent.guardrailVersion
		|| (row.limit_reset ?? 'lifetime') !== intent.period
		|| (settlementBasis === 'gateway_key_route' && Number(row.include_byok_in_limit) !== 1)) {
		throw new GatewayKeyLimitStaleError();
	}
}

async function classifyReplay(pool: Pool, params: ReserveGuardrailBudgetsParams): Promise<ReserveGuardrailBudgetsResult | null> {
	const replay = existingGuardrailReservationReplay(await listByRequest(pool, params.requestId), params);
	if (replay === 'idempotent') return { status: 'idempotent', reservationCount: params.intents.length };
	if (replay === 'conflict') return { status: 'conflict', message: 'request id already has a different Guardrail budget reservation' };
	return null;
}

async function withDeadlockRetry<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if ((errorNumber(error) !== 1205 && errorNumber(error) !== 1213) || attempt >= 2) throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
		}
	}
}

export function createMySqlGuardrailBudgetsRepository(client: MySqlDatabaseClient): GuardrailBudgetsRepository {
	const pool = client.raw;
	return {
		async reserveMany(params) {
			const invalid = validateGuardrailBudgetReservationParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			const replay = await classifyReplay(pool, params);
			if (replay) return replay;
			try {
				const now = toMySqlDateTime(params.nowIso);
				const expiresAt = toMySqlDateTime(params.expiresAtIso);
				return await withDeadlockRetry(async () => {
					const connection = await pool.getConnection();
					try {
						await connection.beginTransaction();
						const lockedReplay = existingGuardrailReservationReplay(await listByRequest(connection, params.requestId, true), params);
						if (lockedReplay === 'idempotent') {
							await connection.commit();
							return { status: 'idempotent', reservationCount: params.intents.length } as ReserveGuardrailBudgetsResult;
						}
						if (lockedReplay === 'conflict') {
							await connection.rollback();
							return { status: 'conflict', message: 'request id reservation payload mismatch' } as ReserveGuardrailBudgetsResult;
						}
						for (const intent of sortedGuardrailBudgetIntents(params.intents)) {
							await validateGatewayKeyLimitIntent(connection, intent, params.nowIso, params.settlementBasis);
							await validateWorkspaceBudgetIntent(connection, intent);
							const window = await seedWindow(connection, intent, params.nowIso);
							if (window.unreserved + window.settled + window.reserved + params.reservedMicros > intent.limitMicros) {
								throw new GuardrailBudgetBlockedError(intent.assignmentId);
							}
							await connection.execute(`UPDATE guardrail_budget_windows
								SET unreserved_micros = ?, reserved_micros = reserved_micros + ?, period_end = ?, updated_at = ?
								WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?`, [
								window.unreserved, params.reservedMicros, toMySqlDateTime(intent.periodEnd), now,
								intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, toMySqlDateTime(intent.periodStart),
							]);
						}
						for (const intent of sortedGuardrailBudgetIntents(params.intents)) {
							await connection.execute(`INSERT INTO guardrail_budget_reservations (
								id, workspace_id, workspace_key, request_id, assignment_id, guardrail_id, guardrail_version,
								scope_type, scope_id, period, period_start, period_end,
								limit_micros, reserved_micros, settled_micros, settlement_basis, state,
								expires_at, created_at, updated_at
							) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'reserved', ?, ?, ?)`, [
								crypto.randomUUID(), intent.workspaceId, intent.workspaceId, params.requestId, intent.assignmentId, intent.guardrailId,
								intent.guardrailVersion, intent.scopeType, intent.scopeId, intent.period,
								toMySqlDateTime(intent.periodStart), toMySqlDateTime(intent.periodEnd), intent.limitMicros, params.reservedMicros,
								params.settlementBasis ?? 'charged',
								expiresAt, now, now,
							]);
						}
						await connection.commit();
						return { status: 'reserved', reservationCount: params.intents.length } as ReserveGuardrailBudgetsResult;
					} catch (error) {
						await connection.rollback().catch(() => undefined);
						throw error;
					} finally {
						connection.release();
					}
				});
			} catch (error) {
				const racedReplay = await classifyReplay(pool, params);
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
				const now = toMySqlDateTime(params.nowIso);
				const expiresAt = toMySqlDateTime(params.expiresAtIso);
				return await withDeadlockRetry(async () => {
					const connection = await pool.getConnection();
					try {
						await connection.beginTransaction();
						const rows = await listByRequest(connection, params.requestId, true);
						const classification = classifyDispatchedGuardrailBudgetExtension(rows, params);
						if (classification.status === 'conflict') {
							await connection.rollback();
							return { status: 'conflict', message: classification.message } as ReserveGuardrailBudgetsResult;
						}
						if (classification.status === 'idempotent') {
							await connection.commit();
							return { status: 'idempotent', reservationCount: params.intents.length } as ReserveGuardrailBudgetsResult;
						}
						for (const intent of classification.missingIntents) {
							await validateGatewayKeyLimitIntent(connection, intent, params.nowIso, 'charged');
							await validateWorkspaceBudgetIntent(connection, intent);
							const window = await seedWindow(connection, intent, params.nowIso);
							if (window.unreserved + window.settled + window.reserved + params.reservedMicros > intent.limitMicros) {
								throw new GuardrailBudgetBlockedError(intent.assignmentId);
							}
							await connection.execute(`UPDATE guardrail_budget_windows
								SET unreserved_micros = ?, reserved_micros = reserved_micros + ?, period_end = ?, updated_at = ?
								WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?`, [
								window.unreserved, params.reservedMicros, toMySqlDateTime(intent.periodEnd), now,
								intent.workspaceId, intent.scopeType, intent.scopeId, intent.period, toMySqlDateTime(intent.periodStart),
							]);
							await connection.execute(`INSERT INTO guardrail_budget_reservations (
								id, workspace_id, workspace_key, request_id, assignment_id, guardrail_id, guardrail_version,
								scope_type, scope_id, period, period_start, period_end,
								limit_micros, reserved_micros, settled_micros, settlement_basis, state,
								expires_at, dispatched_at, created_at, updated_at
							) VALUES (?, ?, SHA2(?, 256), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'charged', 'dispatched', ?, ?, ?, ?)`, [
								crypto.randomUUID(), intent.workspaceId, intent.workspaceId, params.requestId, intent.assignmentId,
								intent.guardrailId, intent.guardrailVersion, intent.scopeType, intent.scopeId, intent.period,
								toMySqlDateTime(intent.periodStart), toMySqlDateTime(intent.periodEnd), intent.limitMicros,
								params.reservedMicros, expiresAt, now, now, now,
							]);
						}
						await connection.commit();
						return { status: 'reserved', reservationCount: params.intents.length } as ReserveGuardrailBudgetsResult;
					} catch (error) {
						await connection.rollback().catch(() => undefined);
						throw error;
					} finally {
						connection.release();
					}
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
			const now = toMySqlDateTime(nowIso);
			const expiresAt = toMySqlDateTime(expiresAtIso);
			return await withDeadlockRetry(async () => {
				const connection = await pool.getConnection();
				try {
					await connection.beginTransaction();
					const rows = await listByRequest(connection, requestId, true);
					if (rows.length === 0) { await connection.rollback(); return false; }
					if (rows.every((row) => row.state === 'dispatched')) { await connection.commit(); return true; }
					if (!rows.every((row) => row.state === 'reserved')) { await connection.rollback(); return false; }
					await connection.execute(`UPDATE guardrail_budget_reservations SET state = 'dispatched', dispatched_at = ?, expires_at = ?, updated_at = ? WHERE request_id = ? AND state = 'reserved'`, [now, expiresAt, now, requestId]);
					await connection.commit();
					return true;
				} catch (error) {
					await connection.rollback().catch(() => undefined);
					throw error;
				} finally { connection.release(); }
			});
		},

		async releaseMany(requestId, nowIso, reason) {
			const now = toMySqlDateTime(nowIso);
			return await withDeadlockRetry(async () => {
				const connection = await pool.getConnection();
				try {
					await connection.beginTransaction();
					const rows = (await listByRequest(connection, requestId, true)).filter((row) => row.state === 'reserved');
					for (const row of rows.sort((a, b) => [a.workspace_id, a.scope_type, a.scope_id, a.period, a.period_start].join('\u0000').localeCompare([b.workspace_id, b.scope_type, b.scope_id, b.period, b.period_start].join('\u0000')))) {
						await connection.execute(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - ?, updated_at = ? WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?`, [Number(row.reserved_micros), now, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
					}
					if (rows.length > 0) await connection.execute(`UPDATE guardrail_budget_reservations SET state = 'released', settled_micros = 0, terminal_at = ?, terminal_reason = ?, updated_at = ? WHERE request_id = ? AND state = 'reserved'`, [now, reason.slice(0, 128), now, requestId]);
					await connection.commit();
					return rows.length;
				} catch (error) {
					await connection.rollback().catch(() => undefined);
					throw error;
				} finally { connection.release(); }
			});
		},

		async forfeitMany(requestId, nowIso, reason) {
			const now = toMySqlDateTime(nowIso);
			return await withDeadlockRetry(async () => {
				const connection = await pool.getConnection();
				try {
					await connection.beginTransaction();
					const rows = (await listByRequest(connection, requestId, true)).filter((row) => row.state === 'reserved' || row.state === 'dispatched');
					for (const row of rows.sort((a, b) => [a.workspace_id, a.scope_type, a.scope_id, a.period, a.period_start].join('\u0000').localeCompare([b.workspace_id, b.scope_type, b.scope_id, b.period, b.period_start].join('\u0000')))) {
						await connection.execute(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - ?, settled_micros = settled_micros + ?, updated_at = ? WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?`, [Number(row.reserved_micros), Number(row.reserved_micros), now, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
					}
					if (rows.length > 0) await connection.execute(`UPDATE guardrail_budget_reservations SET state = 'expired', settled_micros = reserved_micros, terminal_at = ?, terminal_reason = ?, updated_at = ? WHERE request_id = ? AND state IN ('reserved', 'dispatched')`, [now, reason.slice(0, 128), now, requestId]);
					await connection.commit();
					return rows.length;
				} catch (error) {
					await connection.rollback().catch(() => undefined);
					throw error;
				} finally { connection.release(); }
			});
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = Math.max(1, Math.min(Math.trunc(limit), 1000));
			const now = toMySqlDateTime(nowIso);
			return await withDeadlockRetry(async () => {
				const connection = await pool.getConnection();
				try {
					await connection.beginTransaction();
					const [rows] = await connection.query<Array<GuardrailBudgetReservationRow & RowDataPacket>>(`SELECT * FROM guardrail_budget_reservations WHERE state IN ('reserved', 'dispatched') AND expires_at <= ? ORDER BY workspace_id, scope_type, scope_id, period, period_start, id LIMIT ? FOR UPDATE`, [now, bounded]);
					for (const row of rows) {
						const settled = row.state === 'dispatched' ? Number(row.reserved_micros) : 0;
						await connection.execute(`UPDATE guardrail_budget_windows SET reserved_micros = reserved_micros - ?, settled_micros = settled_micros + ?, updated_at = ? WHERE workspace_id = ? AND scope_type = ? AND scope_id = ? AND period = ? AND period_start = ?`, [Number(row.reserved_micros), settled, now, row.workspace_id, row.scope_type, row.scope_id, row.period, row.period_start]);
						await connection.execute(`UPDATE guardrail_budget_reservations SET state = ?, settled_micros = ?, terminal_at = ?, terminal_reason = ?, updated_at = ? WHERE id = ? AND state = ?`, [row.state === 'dispatched' ? 'expired' : 'released', settled, now, row.state === 'dispatched' ? 'lease_expired_after_dispatch' : 'lease_expired_before_dispatch', now, row.id, row.state]);
					}
					await connection.commit();
					return rows.length;
				} catch (error) {
					await connection.rollback().catch(() => undefined);
					throw error;
				} finally { connection.release(); }
			});
		},
	};
}
