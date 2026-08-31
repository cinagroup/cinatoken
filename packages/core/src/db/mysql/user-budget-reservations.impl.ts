import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { MySqlDatabaseClient } from '../../storage/database-client';
import type { UserBudgetReservationsRepository } from '../../storage/gateway-repository-interfaces';
import type {
	ReserveUserBudgetParams,
	ReserveUserBudgetResult,
	UserBudgetAccountRow,
	UserBudgetReservationRow,
} from '../user-budget-reservation-types';
import { USER_BUDGET_MAX_SAFE_MICROS } from '../user-budget-reservation-types';
import {
	existingUserBudgetReservationReplay,
	userBudgetAccountIsStale,
	userBudgetCapacity,
	userBudgetRecoveryLimit,
	userBudgetReservationSnapshot,
	validateReserveUserBudgetParams,
} from '../user-budget-reservation-utils';
import { toMySqlDateTime } from './mysql2-compat';

type FiniteAccount = {
	account: UserBudgetAccountRow;
	limitMicros: number;
	remainingMicros: number;
};

function timestampString(value: unknown): string | null {
	if (value == null) return null;
	if (value instanceof Date) return value.toISOString();
	const text = String(value);
	if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text)) {
		return new Date(`${text.slice(0, 23).replace(' ', 'T')}Z`).toISOString();
	}
	return text;
}

function normalizeReservation(row: UserBudgetReservationRow): UserBudgetReservationRow {
	return {
		...row,
		expires_at: timestampString(row.expires_at)!,
		dispatched_at: timestampString(row.dispatched_at),
		terminal_at: timestampString(row.terminal_at),
		created_at: timestampString(row.created_at)!,
		updated_at: timestampString(row.updated_at)!,
	};
}

function errorNumber(error: unknown): number | null {
	return typeof error === 'object' && error !== null && 'errno' in error && typeof error.errno === 'number'
		? error.errno
		: null;
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

async function getReservation(
	connection: Pool | PoolConnection,
	requestId: string,
	forUpdate = false,
): Promise<UserBudgetReservationRow | null> {
	const [rows] = await connection.query<Array<UserBudgetReservationRow & RowDataPacket>>(
		`SELECT request_id, user_id, api_key_id, budget_epoch, limit_micros,
			reserved_micros, settled_micros, state,
			DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
			DATE_FORMAT(dispatched_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS dispatched_at,
			DATE_FORMAT(terminal_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS terminal_at,
			terminal_reason,
			DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
			DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at
			FROM user_budget_reservations
			WHERE request_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
		[requestId],
	);
	return rows[0] ? normalizeReservation(rows[0]) : null;
}

async function getAccount(
	connection: Pool | PoolConnection,
	userId: string,
	forUpdate = false,
): Promise<UserBudgetAccountRow | null> {
	const [rows] = await connection.query<Array<UserBudgetAccountRow & RowDataPacket>>(`SELECT
		id, budget_max, budget_spent, budget_period,
		DATE_FORMAT(budget_reset_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS budget_reset_at,
		budget_epoch, budget_reserved_micros
		FROM users WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
	return rows[0]
		? { ...rows[0], budget_reset_at: timestampString(rows[0].budget_reset_at) }
		: null;
}

async function lockActiveApiKeyOwnership(
	connection: PoolConnection,
	apiKeyId: string,
	userId: string,
): Promise<boolean> {
	const [rows] = await connection.query<Array<{ id: string } & RowDataPacket>>(`SELECT id FROM api_keys
		WHERE id = ? AND user_id = ? AND status = 'active'
		FOR SHARE`, [apiKeyId, userId]);
	return rows.length === 1;
}

function classifyAccount(
	account: UserBudgetAccountRow | null,
	params: ReserveUserBudgetParams,
): ReserveUserBudgetResult | FiniteAccount {
	if (!account) return { status: 'conflict', message: 'user budget account does not exist' };
	if (Number(account.budget_epoch) !== params.expectedBudgetEpoch) {
		return { status: 'stale', budgetResetAt: account.budget_reset_at };
	}
	if (userBudgetAccountIsStale(account, params.nowIso)) {
		return { status: 'stale', budgetResetAt: account.budget_reset_at };
	}
	const capacity = userBudgetCapacity(account);
	if (capacity.limitMicros == null) return { status: 'unlimited' };
	return {
		account,
		limitMicros: capacity.limitMicros,
		remainingMicros: capacity.remainingMicros!,
	};
}

async function classifyReplay(
	connection: Pool | PoolConnection,
	params: ReserveUserBudgetParams,
	forUpdate = false,
): Promise<ReserveUserBudgetResult | null> {
	const row = await getReservation(connection, params.requestId, forUpdate);
	const replay = existingUserBudgetReservationReplay(row, params);
	if (replay === 'none') return null;
	if (replay === 'conflict') {
		return { status: 'conflict', message: 'request id already has a different user budget reservation' };
	}
	const classified = classifyAccount(await getAccount(connection, params.userId, forUpdate), params);
	if ('status' in classified) {
		return classified.status === 'unlimited'
			? { status: 'stale', budgetResetAt: null }
			: classified;
	}
	if (!row || Number(row.limit_micros) !== classified.limitMicros) {
		return { status: 'stale', budgetResetAt: classified.account.budget_reset_at };
	}
	return { status: 'idempotent', reservation: userBudgetReservationSnapshot(row) };
}

function validDispatchLease(nowIso: string, expiresAtIso: string): boolean {
	const now = new Date(nowIso).getTime();
	const expiresAt = new Date(expiresAtIso).getTime();
	return Number.isFinite(now) && Number.isFinite(expiresAt) && expiresAt > now;
}

function activeLeaseAt(row: UserBudgetReservationRow, nowIso: string): boolean {
	return new Date(row.expires_at).getTime() > new Date(nowIso).getTime();
}

async function updateCurrentEpochAccount(
	connection: PoolConnection,
	row: UserBudgetReservationRow,
	now: string,
	settledMicros: number,
): Promise<void> {
	const account = await getAccount(connection, row.user_id, true);
	if (!account || Number(account.budget_epoch) !== Number(row.budget_epoch)) return;
	const reservedMicros = Number(row.reserved_micros);
	if (Number(account.budget_reserved_micros) < reservedMicros) {
		throw new Error('user_budget_reserved_counter_invariant');
	}
	const [updated] = await connection.execute<ResultSetHeader>(`UPDATE users
		SET budget_reserved_micros = budget_reserved_micros - ?,
			budget_spent = ROUND(GREATEST(budget_spent + (? / 1000000), 0), 6),
			updated_at = ?
		WHERE id = ? AND budget_epoch = ? AND budget_reserved_micros >= ?`, [
		reservedMicros,
		settledMicros,
		now,
		row.user_id,
		Number(row.budget_epoch),
		reservedMicros,
	]);
	if (updated.affectedRows !== 1) throw new Error('user_budget_reserved_counter_invariant');
}

async function terminalize(
	connection: PoolConnection,
	row: UserBudgetReservationRow,
	state: 'released' | 'expired',
	settledMicros: number,
	now: string,
	reason: string,
): Promise<void> {
	await updateCurrentEpochAccount(connection, row, now, settledMicros);
	const [updated] = await connection.execute<ResultSetHeader>(`UPDATE user_budget_reservations
		SET state = ?, settled_micros = ?, terminal_at = ?, terminal_reason = ?, updated_at = ?
		WHERE request_id = ? AND state = ?`, [
		state,
		settledMicros,
		now,
		reason.slice(0, 128),
		now,
		row.request_id,
		row.state,
	]);
	if (updated.affectedRows !== 1) throw new Error('user_budget_reservation_transition_raced');
}

async function inTransaction<T>(pool: Pool, operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
	return await withDeadlockRetry(async () => {
		const connection = await pool.getConnection();
		try {
			await connection.query(`SET time_zone = '+00:00'`);
			await connection.beginTransaction();
			const result = await operation(connection);
			await connection.commit();
			return result;
		} catch (error) {
			await connection.rollback().catch(() => undefined);
			throw error;
		} finally {
			connection.release();
		}
	});
}

export function createMySqlUserBudgetReservationsRepository(
	client: MySqlDatabaseClient,
): UserBudgetReservationsRepository {
	const pool = client.raw;

	return {
		async reserve(params) {
			const invalid = validateReserveUserBudgetParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			const now = toMySqlDateTime(params.nowIso);
			const expiresAt = toMySqlDateTime(params.expiresAtIso);
			try {
				return await inTransaction(pool, async (connection): Promise<ReserveUserBudgetResult> => {
					if (!await lockActiveApiKeyOwnership(connection, params.apiKeyId, params.userId)) {
						return { status: 'conflict', message: 'api key does not belong to the active user budget account' };
					}
					const replay = await classifyReplay(connection, params, true);
					if (replay) return replay;
					const classified = classifyAccount(await getAccount(connection, params.userId, true), params);
					if ('status' in classified) return classified;
					if (classified.remainingMicros < params.reservedMicros) {
						return { status: 'blocked', remainingMicros: classified.remainingMicros };
					}

					const [updated] = await connection.execute<ResultSetHeader>(`UPDATE users
						SET budget_reserved_micros = budget_reserved_micros + ?, updated_at = ?
						WHERE id = ? AND budget_epoch = ? AND budget_max IS NOT NULL
							AND LEAST(
								ROUND(GREATEST(budget_spent, 0) * 1000000),
								?
							) + budget_reserved_micros + ? <= ?`, [
						params.reservedMicros,
						now,
						params.userId,
						params.expectedBudgetEpoch,
						USER_BUDGET_MAX_SAFE_MICROS,
						params.reservedMicros,
						classified.limitMicros,
					]);
					if (updated.affectedRows !== 1) {
						const latest = classifyAccount(await getAccount(connection, params.userId, true), params);
						return 'status' in latest
							? latest
							: { status: 'blocked', remainingMicros: latest.remainingMicros };
					}

					await connection.execute(`INSERT INTO user_budget_reservations (
						request_id, user_id, api_key_id, budget_epoch, limit_micros,
						reserved_micros, settled_micros, state, expires_at, created_at, updated_at
					) VALUES (?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?, ?)`, [
						params.requestId,
						params.userId,
						params.apiKeyId,
						params.expectedBudgetEpoch,
						classified.limitMicros,
						params.reservedMicros,
						expiresAt,
						now,
						now,
					]);
					return {
						status: 'reserved',
						reservation: {
							requestId: params.requestId,
							userId: params.userId,
							apiKeyId: params.apiKeyId,
							budgetEpoch: params.expectedBudgetEpoch,
							limitMicros: classified.limitMicros,
							reservedMicros: params.reservedMicros,
						},
					};
				});
			} catch (error) {
				const replay = await inTransaction(pool, (connection) => classifyReplay(connection, params, true));
				if (replay) return replay;
				throw error;
			}
		},

		async markDispatched(requestId, nowIso, expiresAtIso) {
			if (!validDispatchLease(nowIso, expiresAtIso)) return false;
			const now = toMySqlDateTime(nowIso);
			const expiresAt = toMySqlDateTime(expiresAtIso);
			return await inTransaction(pool, async (connection) => {
				const row = await getReservation(connection, requestId, true);
				if (!row || (row.state !== 'reserved' && row.state !== 'dispatched')) return false;
				const account = await getAccount(connection, row.user_id, true);
				const limitMicros = account ? userBudgetCapacity(account).limitMicros : null;
				if (!account
					|| Number(account.budget_epoch) !== Number(row.budget_epoch)
					|| Number(account.budget_reserved_micros) < Number(row.reserved_micros)
					|| limitMicros !== Number(row.limit_micros)
					|| userBudgetAccountIsStale(account, nowIso)
					|| !activeLeaseAt(row, nowIso)) {
					return false;
				}
				if (row.state === 'dispatched') return true;
				const [updated] = await connection.execute<ResultSetHeader>(`UPDATE user_budget_reservations
					SET state = 'dispatched', dispatched_at = ?, expires_at = ?, updated_at = ?
					WHERE request_id = ? AND state = 'reserved'`, [now, expiresAt, now, requestId]);
				return updated.affectedRows === 1;
			});
		},

		async release(requestId, nowIso, reason) {
			const now = toMySqlDateTime(nowIso);
			return await inTransaction(pool, async (connection) => {
				const row = await getReservation(connection, requestId, true);
				if (!row) return 0;
				if (row.state === 'released') return 1;
				if (row.state !== 'reserved') return 0;
				await terminalize(connection, row, 'released', 0, now, reason);
				return 1;
			});
		},

		async forfeitDispatched(requestId, nowIso, reason) {
			const now = toMySqlDateTime(nowIso);
			return await inTransaction(pool, async (connection) => {
				const row = await getReservation(connection, requestId, true);
				if (!row) return 0;
				if (row.state === 'expired' || row.state === 'settled') return 1;
				if (row.state !== 'dispatched') return 0;
				await terminalize(connection, row, 'expired', Number(row.reserved_micros), now, reason);
				return 1;
			});
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = userBudgetRecoveryLimit(limit);
			const now = toMySqlDateTime(nowIso);
			return await inTransaction(pool, async (connection) => {
				const [rows] = await connection.query<Array<UserBudgetReservationRow & RowDataPacket>>(`SELECT *
					FROM user_budget_reservations
					WHERE state IN ('reserved', 'dispatched') AND expires_at <= ?
					ORDER BY user_id, budget_epoch, request_id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, bounded]);
				for (const row of rows) {
					const dispatched = row.state === 'dispatched';
					await terminalize(
						connection,
						row,
						dispatched ? 'expired' : 'released',
						dispatched ? Number(row.reserved_micros) : 0,
						now,
						dispatched ? 'lease_expired_after_dispatch' : 'lease_expired_before_dispatch',
					);
				}
				return rows.length;
			});
		},
	};
}
