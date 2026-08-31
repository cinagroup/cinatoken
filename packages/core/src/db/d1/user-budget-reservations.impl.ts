import type { D1PreparedStatement } from '@cloudflare/workers-types';
import type { UserBudgetReservationsRepository } from '../../storage/gateway-repository-interfaces';
import type { D1DatabaseClient } from '../../storage/database-client';
import type {
	ReserveUserBudgetParams,
	ReserveUserBudgetResult,
	UserBudgetAccountRow,
	UserBudgetReservationRow,
} from '../user-budget-reservation-types';
import {
	isSafeUserBudgetMicros,
	USER_BUDGET_MAX_SAFE_MICROS,
	userBudgetUnits,
} from '../user-budget-reservation-types';
import {
	existingUserBudgetReservationReplay,
	userBudgetAccountIsStale,
	userBudgetRecoveryLimit,
	userBudgetReservationSnapshot,
	validateReserveUserBudgetParams,
} from '../user-budget-reservation-utils';

type D1UserBudgetAccountRow = UserBudgetAccountRow & {
	budget_spent_micros: number | string;
};

async function getReservation(
	client: D1DatabaseClient,
	requestId: string,
): Promise<UserBudgetReservationRow | null> {
	return await client.raw.prepare(`SELECT * FROM user_budget_reservations WHERE request_id = ?`)
		.bind(requestId).first<UserBudgetReservationRow>();
}

async function getAccount(client: D1DatabaseClient, userId: string): Promise<D1UserBudgetAccountRow | null> {
	return await client.raw.prepare(`SELECT
		id, budget_max, budget_spent, budget_spent_micros, budget_period, budget_reset_at,
		budget_epoch, budget_reserved_micros
		FROM users WHERE id = ?`).bind(userId).first<D1UserBudgetAccountRow>();
}

function d1UserBudgetCapacity(account: D1UserBudgetAccountRow): {
	limitMicros: number | null;
	remainingMicros: number | null;
} {
	const limitMicros = account.budget_max == null ? null : userBudgetUnits(Number(account.budget_max));
	const rawSpentMicros = Number(account.budget_spent_micros);
	const spentMicros = isSafeUserBudgetMicros(rawSpentMicros)
		? rawSpentMicros
		: USER_BUDGET_MAX_SAFE_MICROS;
	const rawReservedMicros = Number(account.budget_reserved_micros);
	const reservedMicros = isSafeUserBudgetMicros(rawReservedMicros)
		? rawReservedMicros
		: USER_BUDGET_MAX_SAFE_MICROS;
	const remainingMicros = limitMicros == null
		? null
		: Math.max(
			0,
			limitMicros - Math.min(limitMicros, spentMicros) - Math.min(limitMicros, reservedMicros),
		);
	return { limitMicros, remainingMicros };
}

async function activeApiKeyBelongsToUser(
	client: D1DatabaseClient,
	apiKeyId: string,
	userId: string,
): Promise<boolean> {
	const row = await client.raw.prepare(`SELECT id FROM api_keys
		WHERE id = ? AND user_id = ? AND status = 'active'`)
		.bind(apiKeyId, userId).first<{ id: string }>();
	return row != null;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function classifyAccount(
	client: D1DatabaseClient,
	params: ReserveUserBudgetParams,
): Promise<ReserveUserBudgetResult | { account: UserBudgetAccountRow; limitMicros: number; remainingMicros: number }> {
	const account = await getAccount(client, params.userId);
	if (!account) return { status: 'conflict', message: 'user budget account does not exist' };
	if (Number(account.budget_epoch) !== params.expectedBudgetEpoch) {
		return { status: 'stale', budgetResetAt: account.budget_reset_at };
	}
	if (userBudgetAccountIsStale(account, params.nowIso)) {
		return { status: 'stale', budgetResetAt: account.budget_reset_at };
	}
	const capacity = d1UserBudgetCapacity(account);
	if (capacity.limitMicros == null) return { status: 'unlimited' };
	return { account, limitMicros: capacity.limitMicros, remainingMicros: capacity.remainingMicros! };
}

async function classifyReplay(
	client: D1DatabaseClient,
	params: ReserveUserBudgetParams,
): Promise<ReserveUserBudgetResult | null> {
	const row = await getReservation(client, params.requestId);
	const replay = existingUserBudgetReservationReplay(row, params);
	if (replay === 'none') return null;
	if (replay === 'conflict') {
		return { status: 'conflict', message: 'request id already has a different user budget reservation' };
	}
	const classified = await classifyAccount(client, params);
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

export function createD1UserBudgetReservationsRepository(
	client: D1DatabaseClient,
): UserBudgetReservationsRepository {
	return {
		async reserve(params) {
			const invalid = validateReserveUserBudgetParams(params);
			if (invalid) return { status: 'conflict', message: invalid };
			if (!await activeApiKeyBelongsToUser(client, params.apiKeyId, params.userId)) {
				return { status: 'conflict', message: 'api key does not belong to the active user budget account' };
			}
			const replay = await classifyReplay(client, params);
			if (replay) return replay;

			const classified = await classifyAccount(client, params);
			if ('status' in classified) return classified;
			if (classified.remainingMicros < params.reservedMicros) {
				return { status: 'blocked', remainingMicros: classified.remainingMicros };
			}
			try {
				await client.raw.prepare(`INSERT INTO user_budget_reservations (
					request_id, user_id, api_key_id, budget_epoch, limit_micros,
					reserved_micros, settled_micros, state, expires_at, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 0, 'reserved', ?, ?, ?)`)
					.bind(
						params.requestId, params.userId, params.apiKeyId, params.expectedBudgetEpoch,
						classified.limitMicros, params.reservedMicros, params.expiresAtIso,
						params.nowIso, params.nowIso,
					).run();
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
			} catch (error) {
				const racedReplay = await classifyReplay(client, params);
				if (racedReplay) return racedReplay;
				const message = errorText(error);
				if (message.includes('user_budget_exceeded')) {
					const latest = await classifyAccount(client, params);
					return 'status' in latest
						? latest
						: { status: 'blocked', remainingMicros: latest.remainingMicros };
				}
				if (message.includes('user_budget_unlimited')) return { status: 'unlimited' };
				if (message.includes('user_budget_stale')) {
					const latest = await getAccount(client, params.userId);
					return { status: 'stale', budgetResetAt: latest?.budget_reset_at ?? null };
				}
				if (message.includes('user_budget_user_missing')) {
					return { status: 'conflict', message: 'user budget account does not exist' };
				}
				if (message.includes('user_budget_api_key_mismatch')) {
					return { status: 'conflict', message: 'api key does not belong to the active user budget account' };
				}
				throw error;
			}
		},

		async markDispatched(requestId, nowIso, expiresAtIso) {
			if (!validDispatchLease(nowIso, expiresAtIso)) return false;
			const result = await client.raw.prepare(`UPDATE user_budget_reservations
				SET state = 'dispatched', dispatched_at = ?, expires_at = ?, updated_at = ?
				WHERE request_id = ? AND state = 'reserved' AND expires_at > ?
					AND EXISTS (
						SELECT 1 FROM users
						WHERE id = user_budget_reservations.user_id
							AND budget_epoch = user_budget_reservations.budget_epoch
							AND budget_reserved_micros >= user_budget_reservations.reserved_micros
							AND budget_max IS NOT NULL
							AND MIN(
								CAST(ROUND(MAX(budget_max, 0) * 1000000) AS INTEGER),
								9007199254740991
							) = user_budget_reservations.limit_micros
							AND (budget_period = 'none' OR budget_reset_at IS NULL OR budget_reset_at > ?)
					)`)
				.bind(nowIso, expiresAtIso, nowIso, requestId, nowIso, nowIso).run();
			if ((result.meta.changes ?? 0) === 1) return true;
			const row = await getReservation(client, requestId);
			if (row?.state !== 'dispatched' || new Date(row.expires_at).getTime() <= new Date(nowIso).getTime()) {
				return false;
			}
			const account = await getAccount(client, row.user_id);
			const limitMicros = account ? d1UserBudgetCapacity(account).limitMicros : null;
			return account != null
				&& Number(account.budget_epoch) === Number(row.budget_epoch)
				&& Number(account.budget_reserved_micros) >= Number(row.reserved_micros)
				&& limitMicros === Number(row.limit_micros)
				&& !userBudgetAccountIsStale(account, nowIso);
		},

		async release(requestId, nowIso, reason) {
			const result = await client.raw.prepare(`UPDATE user_budget_reservations
				SET state = 'released', settled_micros = 0,
					terminal_at = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state = 'reserved'`)
				.bind(nowIso, reason.slice(0, 128), nowIso, requestId).run();
			if ((result.meta.changes ?? 0) === 1) return 1;
			return (await getReservation(client, requestId))?.state === 'released' ? 1 : 0;
		},

		async forfeitDispatched(requestId, nowIso, reason) {
			const result = await client.raw.prepare(`UPDATE user_budget_reservations
				SET state = 'expired', settled_micros = reserved_micros,
					terminal_at = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state = 'dispatched'`)
				.bind(nowIso, reason.slice(0, 128), nowIso, requestId).run();
			if ((result.meta.changes ?? 0) === 1) return 1;
			const state = (await getReservation(client, requestId))?.state;
			return state === 'expired' || state === 'settled' ? 1 : 0;
		},

		async expireBefore(nowIso, limit = 100) {
			const bounded = userBudgetRecoveryLimit(limit);
			const candidates = (await client.raw.prepare(`SELECT request_id, state
				FROM user_budget_reservations
				WHERE state IN ('reserved', 'dispatched') AND expires_at <= ?
				ORDER BY expires_at, request_id LIMIT ?`)
				.bind(nowIso, bounded).all<{ request_id: string; state: 'reserved' | 'dispatched' }>()).results ?? [];
			if (candidates.length === 0) return 0;
			const statements: D1PreparedStatement[] = candidates.map((row) => row.state === 'reserved'
				? client.raw.prepare(`UPDATE user_budget_reservations
					SET state = 'released', settled_micros = 0, terminal_at = ?,
						terminal_reason = 'lease_expired_before_dispatch', updated_at = ?
					WHERE request_id = ? AND state = 'reserved'`).bind(nowIso, nowIso, row.request_id)
				: client.raw.prepare(`UPDATE user_budget_reservations
					SET state = 'expired', settled_micros = reserved_micros, terminal_at = ?,
						terminal_reason = 'lease_expired_after_dispatch', updated_at = ?
					WHERE request_id = ? AND state = 'dispatched'`).bind(nowIso, nowIso, row.request_id));
			const results = await client.raw.batch(statements);
			return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0);
		},
	};
}
