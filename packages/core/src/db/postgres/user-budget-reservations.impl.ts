import type { PostgresDatabaseClient } from '../../storage/database-client';
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

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(
		query: string,
		parameters?: readonly unknown[],
	): Promise<T>;
};

type FiniteAccount = {
	account: UserBudgetAccountRow;
	limitMicros: number;
	remainingMicros: number;
};

function timestampString(value: unknown): string | null {
	if (value == null) return null;
	if (value instanceof Date) return value.toISOString();
	return String(value);
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

async function getReservation(
	pg: PgQuery,
	requestId: string,
	forUpdate = false,
): Promise<UserBudgetReservationRow | null> {
	const rows = await pg.unsafe<UserBudgetReservationRow[]>(
		`SELECT * FROM user_budget_reservations WHERE request_id = $1${forUpdate ? ' FOR UPDATE' : ''}`,
		[requestId],
	);
	return rows[0] ? normalizeReservation(rows[0]) : null;
}

async function getAccount(
	pg: PgQuery,
	userId: string,
	forUpdate = false,
): Promise<UserBudgetAccountRow | null> {
	const rows = await pg.unsafe<UserBudgetAccountRow[]>(`SELECT
		id, budget_max, budget_spent, budget_period, budget_reset_at,
		budget_epoch, budget_reserved_micros
		FROM users WHERE id = $1${forUpdate ? ' FOR UPDATE' : ''}`, [userId]);
	return rows[0]
		? { ...rows[0], budget_reset_at: timestampString(rows[0].budget_reset_at) }
		: null;
}

async function lockActiveApiKeyOwnership(
	pg: PgQuery,
	apiKeyId: string,
	userId: string,
): Promise<boolean> {
	const rows = await pg.unsafe<Array<{ id: string }>>(`SELECT id FROM api_keys
		WHERE id = $1 AND user_id = $2 AND status = 'active'
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
	pg: PgQuery,
	params: ReserveUserBudgetParams,
	forUpdate = false,
): Promise<ReserveUserBudgetResult | null> {
	const row = await getReservation(pg, params.requestId, forUpdate);
	const replay = existingUserBudgetReservationReplay(row, params);
	if (replay === 'none') return null;
	if (replay === 'conflict') {
		return { status: 'conflict', message: 'request id already has a different user budget reservation' };
	}
	const classified = classifyAccount(await getAccount(pg, params.userId, forUpdate), params);
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
	pg: PgQuery,
	row: UserBudgetReservationRow,
	nowIso: string,
	settledMicros: number,
): Promise<void> {
	const account = await getAccount(pg, row.user_id, true);
	if (!account || Number(account.budget_epoch) !== Number(row.budget_epoch)) return;
	const reservedMicros = Number(row.reserved_micros);
	if (Number(account.budget_reserved_micros) < reservedMicros) {
		throw new Error('user_budget_reserved_counter_invariant');
	}
	const updated = await pg.unsafe<Array<{ id: string }>>(`UPDATE users
		SET budget_reserved_micros = budget_reserved_micros - $1::bigint,
			budget_spent = ROUND(GREATEST(
				budget_spent + ($2::numeric / 1000000::numeric),
				0::numeric
			), 6),
			updated_at = $3::timestamptz
		WHERE id = $4 AND budget_epoch = $5::bigint
			AND budget_reserved_micros >= $1::bigint
		RETURNING id`, [
		reservedMicros,
		settledMicros,
		nowIso,
		row.user_id,
		Number(row.budget_epoch),
	]);
	if (updated.length !== 1) throw new Error('user_budget_reserved_counter_invariant');
}

async function terminalize(
	pg: PgQuery,
	row: UserBudgetReservationRow,
	state: 'released' | 'expired',
	settledMicros: number,
	nowIso: string,
	reason: string,
): Promise<void> {
	await updateCurrentEpochAccount(pg, row, nowIso, settledMicros);
	const updated = await pg.unsafe<Array<{ request_id: string }>>(`UPDATE user_budget_reservations
		SET state = $1, settled_micros = $2::bigint, terminal_at = $3::timestamptz,
			terminal_reason = $4, updated_at = $3::timestamptz
		WHERE request_id = $5 AND state = $6
		RETURNING request_id`, [
		state,
		settledMicros,
		nowIso,
		reason.slice(0, 128),
		row.request_id,
		row.state,
	]);
	if (updated.length !== 1) throw new Error('user_budget_reservation_transition_raced');
}

export function createPostgresUserBudgetReservationsRepository(
	client: PostgresDatabaseClient,
): UserBudgetReservationsRepository {
	const pg = client.raw as unknown as PgQuery & {
		begin<T>(callback: (tx: PgQuery) => Promise<T>): Promise<T>;
	};

	return {
		async reserve(params) {
			const invalid = validateReserveUserBudgetParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			try {
				return await pg.begin<ReserveUserBudgetResult>(async (tx) => {
					if (!await lockActiveApiKeyOwnership(tx, params.apiKeyId, params.userId)) {
						return { status: 'conflict', message: 'api key does not belong to the active user budget account' };
					}
					const replay = await classifyReplay(tx, params, true);
					if (replay) return replay;
					const classified = classifyAccount(await getAccount(tx, params.userId, true), params);
					if ('status' in classified) return classified;
					if (classified.remainingMicros < params.reservedMicros) {
						return { status: 'blocked', remainingMicros: classified.remainingMicros };
					}

					const updated = await tx.unsafe<Array<{ id: string }>>(`UPDATE users
						SET budget_reserved_micros = budget_reserved_micros + $1::bigint,
							updated_at = $2::timestamptz
						WHERE id = $3 AND budget_epoch = $4::bigint AND budget_max IS NOT NULL
							AND LEAST(
								ROUND(GREATEST(budget_spent, 0::numeric) * 1000000::numeric),
								$5::numeric
							) + budget_reserved_micros + $1::bigint <= $6::bigint
						RETURNING id`, [
						params.reservedMicros,
						params.nowIso,
						params.userId,
						params.expectedBudgetEpoch,
						USER_BUDGET_MAX_SAFE_MICROS,
						classified.limitMicros,
					]);
					if (updated.length !== 1) {
						const latest = classifyAccount(await getAccount(tx, params.userId, true), params);
						return 'status' in latest
							? latest
							: { status: 'blocked', remainingMicros: latest.remainingMicros };
					}

					await tx.unsafe(`INSERT INTO user_budget_reservations (
						request_id, user_id, api_key_id, budget_epoch, limit_micros,
						reserved_micros, settled_micros, state, expires_at, created_at, updated_at
					) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::bigint, 0, 'reserved',
						$7::timestamptz, $8::timestamptz, $8::timestamptz)`, [
						params.requestId,
						params.userId,
						params.apiKeyId,
						params.expectedBudgetEpoch,
						classified.limitMicros,
						params.reservedMicros,
						params.expiresAtIso,
						params.nowIso,
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
				const replay = await classifyReplay(pg, params);
				if (replay) return replay;
				throw error;
			}
		},

		async markDispatched(requestId, nowIso, expiresAtIso) {
			if (!validDispatchLease(nowIso, expiresAtIso)) return false;
			return await pg.begin(async (tx) => {
				const row = await getReservation(tx, requestId, true);
				if (!row || (row.state !== 'reserved' && row.state !== 'dispatched')) return false;
				const account = await getAccount(tx, row.user_id, true);
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
				const updated = await tx.unsafe<Array<{ request_id: string }>>(`UPDATE user_budget_reservations
					SET state = 'dispatched', dispatched_at = $1::timestamptz,
						expires_at = $2::timestamptz, updated_at = $1::timestamptz
					WHERE request_id = $3 AND state = 'reserved'
					RETURNING request_id`, [nowIso, expiresAtIso, requestId]);
				return updated.length === 1;
			});
		},

		async release(requestId, nowIso, reason) {
			return await pg.begin(async (tx) => {
				const row = await getReservation(tx, requestId, true);
				if (!row) return 0;
				if (row.state === 'released') return 1;
				if (row.state !== 'reserved') return 0;
				await terminalize(tx, row, 'released', 0, nowIso, reason);
				return 1;
			});
		},

		async forfeitDispatched(requestId, nowIso, reason) {
			return await pg.begin(async (tx) => {
				const row = await getReservation(tx, requestId, true);
				if (!row) return 0;
				if (row.state === 'expired' || row.state === 'settled') return 1;
				if (row.state !== 'dispatched') return 0;
				await terminalize(tx, row, 'expired', Number(row.reserved_micros), nowIso, reason);
				return 1;
			});
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = userBudgetRecoveryLimit(limit);
			return await pg.begin(async (tx) => {
				const rows = await tx.unsafe<UserBudgetReservationRow[]>(`SELECT *
					FROM user_budget_reservations
					WHERE state IN ('reserved', 'dispatched') AND expires_at <= $1::timestamptz
					ORDER BY user_id, budget_epoch, request_id
					LIMIT $2 FOR UPDATE SKIP LOCKED`, [nowIso, bounded]);
				for (const row of rows) {
					const dispatched = row.state === 'dispatched';
					await terminalize(
						tx,
						row,
						dispatched ? 'expired' : 'released',
						dispatched ? Number(row.reserved_micros) : 0,
						nowIso,
						dispatched ? 'lease_expired_after_dispatch' : 'lease_expired_before_dispatch',
					);
				}
				return rows.length;
			});
		},
	};
}
