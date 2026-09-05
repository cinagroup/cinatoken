/**
 * D1：关键写路径（batch / 原始 SQL），供 `storage/critical-write-paths` 调度。
 */
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import type { InsertUserAuditLogParams } from '../user-audit-logs-types';
import { assertAndFinalizeUserAuditInsert } from '../user-audit-catalog';
import type { InsertUserBudgetAuditLogParams } from '../user-budget-audit-params';
import { buildInsertUserAuditLogStatement } from './user-audit-logs.impl';
import {
	userBudgetAuditToInsertRowForBudgetTx,
	userBudgetAuditToInsertRowForCreateKey,
	userBudgetAuditToInsertRowForUsageCharge,
} from '../user-budget-audit-mapper';
import { buildInsertApiKeyStatement } from './api-keys.impl';
import type { InsertKeyParams } from '../api-keys-types';
import { buildInsertRequestLogStatement } from './request-logs.impl';
import type { InsertRequestLogParams } from '../request-logs-types';
import { assertProviderAttemptAvailabilityFacts } from '../provider-attempt-availability';
import { guardrailBudgetUnits, type GuardrailBudgetSettlement } from '../guardrail-budget-types';
import {
	isSafeUserBudgetMicros,
	USER_BUDGET_MAX_SAFE_MICROS,
	userBudgetAmount,
	userBudgetUnits,
	type UserBudgetReservationRow,
	type UserBudgetSettlement,
} from '../user-budget-reservation-types';
import { toPublicModelDailyStatsDelta } from '../public-model-daily-stats';
import { roundGatewayMoney } from '../../lib/money-precision';
import type { D1DatabaseClient } from '../../storage/database-client';
import { nowIso, parseMoney } from '../../storage/critical-write-paths-utils';
import {
	systemConfigTable as d1SystemConfigTable,
	usersTable as d1UsersTable,
} from '../../storage/drizzle/schema.d1';

function ensureD1Batch(client: D1DatabaseClient, statements: D1PreparedStatement[]): Promise<void> {
	return client.raw.batch(statements).then(() => undefined);
}

function uniqueD1MutationTimestamp(): string {
	const now = nowIso();
	const suffix = crypto.randomUUID()
		.replaceAll('-', '')
		.slice(0, 12)
		.split('')
		.map((digit) => String(Number.parseInt(digit, 16) % 10))
		.join('');
	return now.replace(/Z$/, `${suffix}Z`);
}

function buildConditionalUserAuditLogStatement(
	client: D1DatabaseClient,
	params: InsertUserAuditLogParams,
	condition: { userId: string; updatedAt: string; budgetEpoch?: number },
): D1PreparedStatement {
	const p = assertAndFinalizeUserAuditInsert(params);
	const epochClause = condition.budgetEpoch === undefined ? '' : ' AND budget_epoch = ?';
	return client.raw.prepare(`INSERT INTO user_audit_logs (
		id, user_id, api_key_id, event_type, actor_type,
		request_log_id, change_payload,
		before_user_snapshot, after_user_snapshot, changed_fields,
		correlation_id, source, actor_id, reason_code, reason_text
	) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
	FROM users
	WHERE id = ? AND updated_at = ?${epochClause}`)
		.bind(
			p.id,
			p.userId,
			p.apiKeyId ?? null,
			p.eventType,
			p.actorType,
			p.requestLogId ?? null,
			p.changePayload ?? null,
			p.beforeUserSnapshot ?? null,
			p.afterUserSnapshot ?? null,
			p.changedFields ?? null,
			p.correlationId ?? null,
			p.source ?? null,
			p.actorId ?? null,
			p.reasonCode ?? null,
			p.reasonText ?? null,
			condition.userId,
			condition.updatedAt,
			...(condition.budgetEpoch === undefined ? [] : [condition.budgetEpoch]),
		);
}

/**
 * Usage snapshots are supplied before the critical batch is assembled. A
 * period reset can win before this batch starts; in that case keep the audit
 * event/request linkage but omit snapshots that describe the superseded
 * accounting generation. The epoch comparison executes inside the D1 batch.
 */
function buildEpochAwareUsageAuditLogStatement(
	client: D1DatabaseClient,
	params: InsertUserAuditLogParams,
	requestId: string,
): D1PreparedStatement {
	const p = assertAndFinalizeUserAuditInsert(params);
	return client.raw.prepare(`INSERT INTO user_audit_logs (
		id, user_id, api_key_id, event_type, actor_type,
		request_log_id, change_payload,
		before_user_snapshot, after_user_snapshot, changed_fields,
		correlation_id, source, actor_id, reason_code, reason_text
	) SELECT ?, ?, ?, ?, ?, ?, ?,
		CASE WHEN account.budget_epoch = reservation.budget_epoch THEN ? ELSE NULL END,
		CASE WHEN account.budget_epoch = reservation.budget_epoch THEN ? ELSE NULL END,
		CASE WHEN account.budget_epoch = reservation.budget_epoch THEN ? ELSE NULL END,
		?, ?, ?, ?, ?
	FROM user_budget_reservations AS reservation
	JOIN users AS account ON account.id = reservation.user_id
	WHERE reservation.request_id = ?`)
		.bind(
			p.id,
			p.userId,
			p.apiKeyId ?? null,
			p.eventType,
			p.actorType,
			p.requestLogId ?? null,
			p.changePayload ?? null,
			p.beforeUserSnapshot ?? null,
			p.afterUserSnapshot ?? null,
			p.changedFields ?? null,
			p.correlationId ?? null,
			p.source ?? null,
			p.actorId ?? null,
			p.reasonCode ?? null,
			p.reasonText ?? null,
			requestId,
		);
}

async function getAuthoritativeUserSpentMicrosD1(
	client: D1DatabaseClient,
	userId: string,
): Promise<number | null> {
	const row = await client.raw.prepare(`SELECT budget_spent_micros
		FROM users WHERE id = ? LIMIT 1`)
		.bind(userId)
		.first<{ budget_spent_micros: number }>();
	if (!row) return null;
	const micros = Number(row.budget_spent_micros);
	if (!isSafeUserBudgetMicros(micros)) {
		throw new Error('D1 ordinary-user budget contains unsafe spent micro-units');
	}
	return micros;
}

export async function getUserBudgetSnapshotD1(
	client: D1DatabaseClient,
	userId: string
): Promise<{ budgetSpent: number; budgetMax: number | null; budgetPeriod: string | null; budgetResetAt: string | null } | null> {
	const row = await client.drizzle
		.select({
			budgetSpentMicros: d1UsersTable.budgetSpentMicros,
			budgetMax: d1UsersTable.budgetMax,
			budgetPeriod: d1UsersTable.budgetPeriod,
			budgetResetAt: d1UsersTable.budgetResetAt,
		})
		.from(d1UsersTable)
		.where(eq(d1UsersTable.id, userId))
		.limit(1);
	if (!row[0]) return null;
	const budgetSpentMicros = Number(row[0].budgetSpentMicros);
	if (!isSafeUserBudgetMicros(budgetSpentMicros)) {
		throw new Error('D1 ordinary-user budget contains unsafe spent micro-units');
	}
	return {
		budgetSpent: userBudgetAmount(budgetSpentMicros),
		budgetMax: row[0].budgetMax == null ? null : parseMoney(row[0].budgetMax),
		budgetPeriod: row[0].budgetPeriod,
		budgetResetAt: row[0].budgetResetAt,
	};
}

export async function getSystemConfigValueD1(client: D1DatabaseClient, key: string): Promise<string | null> {
	const row = await client.drizzle
		.select({ value: d1SystemConfigTable.value })
		.from(d1SystemConfigTable)
		.where(eq(d1SystemConfigTable.key, key))
		.limit(1);
	return row[0]?.value ?? null;
}

export async function createApiKeyWithAuditD1(
	client: D1DatabaseClient,
	params: {
		insert: InsertKeyParams;
		audit: InsertUserBudgetAuditLogParams;
	}
): Promise<void> {
	const auditRow = userBudgetAuditToInsertRowForCreateKey(params.insert.userId, params.audit);
	// 审计 M2-3：key 插入语句现需异步计算 key_hash，先构建再批量执行。
	const [keyStatement, auditStatement] = await Promise.all([
		buildInsertApiKeyStatement(client.raw, params.insert),
		buildInsertUserAuditLogStatement(client.raw, auditRow),
	]);
	await ensureD1Batch(client, [keyStatement, auditStatement]);
}

export async function updateUserBudgetWithAuditTxD1(
	client: D1DatabaseClient,
	params: {
		userId: string;
		expectedBudgetMax: number | null;
		expectedBudgetBase: number;
		expectedBudgetSpent: number;
		expectedBudgetPeriod: string;
		expectedBudgetResetAt: string | null;
		expectedBudgetEpoch: number;
		expectedBudgetReservedMicros: number;
		budgetSpent: number;
		budgetResetAt: string | null;
		budgetMax?: number | null;
		apiKeyId: string | null;
		audit: Omit<InsertUserBudgetAuditLogParams, 'id' | 'apiKeyId' | 'afterSpent' | 'afterBudgetResetAt'>;
	}
): Promise<boolean> {
	if (!Number.isSafeInteger(params.expectedBudgetEpoch) || params.expectedBudgetEpoch < 0
		|| !Number.isSafeInteger(params.expectedBudgetReservedMicros) || params.expectedBudgetReservedMicros < 0
		|| !Number.isFinite(params.expectedBudgetBase) || params.expectedBudgetBase < 0
		|| !Number.isFinite(params.expectedBudgetSpent) || params.expectedBudgetSpent < 0
		|| (params.expectedBudgetMax !== null
			&& (!Number.isFinite(params.expectedBudgetMax) || params.expectedBudgetMax < 0))) {
		throw new Error('Invalid expected ordinary-user budget reset accounting values');
	}
	if (!Number.isFinite(params.budgetSpent) || params.budgetSpent < 0
		|| (params.budgetMax !== undefined && params.budgetMax !== null
			&& (!Number.isFinite(params.budgetMax) || params.budgetMax < 0))) {
		throw new Error('Invalid next ordinary-user budget reset accounting values');
	}
	const currentSpentMicros = await getAuthoritativeUserSpentMicrosD1(client, params.userId);
	if (currentSpentMicros == null
		|| roundGatewayMoney(userBudgetAmount(currentSpentMicros))
			!== roundGatewayMoney(params.expectedBudgetSpent)) {
		return false;
	}
	const preservesSpent = roundGatewayMoney(params.budgetSpent)
		=== roundGatewayMoney(params.expectedBudgetSpent);
	const nextSpentMicros = preservesSpent
		? currentSpentMicros
		: userBudgetUnits(params.budgetSpent);
	const expectedSpentMicros = currentSpentMicros;
	const nextSpent = userBudgetAmount(nextSpentMicros);
	const updatedAt = uniqueD1MutationTimestamp();
	const nextBudgetEpoch = params.expectedBudgetEpoch + 1;
	if (!Number.isSafeInteger(nextBudgetEpoch)) {
		throw new Error('Ordinary-user budget epoch exhausted');
	}
	const auditRow = userBudgetAuditToInsertRowForBudgetTx(
		params.userId,
		params.apiKeyId,
		nextSpent,
		params.budgetResetAt,
		params.audit
	);
	const updateStmt =
		params.budgetMax !== undefined
			? client.raw
					.prepare(
						`UPDATE users SET budget_spent = ?, budget_spent_micros = ?, budget_reset_at = ?, budget_max = COALESCE(?, budget_max),
							budget_epoch = budget_epoch + 1, budget_reserved_micros = 0, updated_at = ?
						WHERE id = ?
							AND budget_max IS NOT DISTINCT FROM ?
							AND ROUND(budget_base, 6) = ?
							AND budget_spent_micros = ?
							AND budget_period = ?
							AND budget_reset_at IS NOT DISTINCT FROM ?
							AND budget_epoch = ?
							AND budget_reserved_micros = ?`
					)
					.bind(
						nextSpent,
						nextSpentMicros,
						params.budgetResetAt,
						params.budgetMax == null ? null : roundGatewayMoney(params.budgetMax),
						updatedAt,
						params.userId,
						params.expectedBudgetMax == null ? null : roundGatewayMoney(params.expectedBudgetMax),
						roundGatewayMoney(params.expectedBudgetBase),
						expectedSpentMicros,
						params.expectedBudgetPeriod,
						params.expectedBudgetResetAt,
						params.expectedBudgetEpoch,
						params.expectedBudgetReservedMicros,
					)
			: client.raw
					.prepare(
						`UPDATE users SET budget_spent = ?, budget_spent_micros = ?, budget_reset_at = ?,
							budget_epoch = budget_epoch + 1, budget_reserved_micros = 0, updated_at = ?
						WHERE id = ?
							AND budget_max IS NOT DISTINCT FROM ?
							AND ROUND(budget_base, 6) = ?
							AND budget_spent_micros = ?
							AND budget_period = ?
							AND budget_reset_at IS NOT DISTINCT FROM ?
							AND budget_epoch = ?
							AND budget_reserved_micros = ?`
					)
					.bind(
						nextSpent,
						nextSpentMicros,
						params.budgetResetAt,
						updatedAt,
						params.userId,
						params.expectedBudgetMax == null ? null : roundGatewayMoney(params.expectedBudgetMax),
						roundGatewayMoney(params.expectedBudgetBase),
						expectedSpentMicros,
						params.expectedBudgetPeriod,
						params.expectedBudgetResetAt,
						params.expectedBudgetEpoch,
						params.expectedBudgetReservedMicros,
					);
	const auditStmt = buildConditionalUserAuditLogStatement(client, auditRow, {
		userId: params.userId,
		updatedAt,
		budgetEpoch: nextBudgetEpoch,
	});
	const results = await client.raw.batch([updateStmt, auditStmt]);
	return (results[0]?.meta?.changes ?? 0) === 1;
}

export async function applyUserBudgetTransitionWithAuditD1(
	client: D1DatabaseClient,
	params: {
		userId: string;
		expectedBudgetMax: number | null;
		expectedBudgetBase: number;
		expectedBudgetEpoch: number;
		expectedBudgetReservedMicros: number;
		expectedBudgetSpent: number;
		expectedBudgetPeriod: string;
		expectedBudgetResetAt: string | null;
		budgetMax: number | null;
		budgetBase: number;
		budgetSpent: number;
		budgetPeriod: string;
		budgetResetAt: string | null;
		resetEpoch: boolean;
		metadata?: string | null;
		audit: InsertUserAuditLogParams;
	}
): Promise<boolean> {
	if (!Number.isFinite(params.budgetSpent) || params.budgetSpent < 0
		|| !Number.isFinite(params.expectedBudgetSpent) || params.expectedBudgetSpent < 0) {
		throw new Error('Invalid ordinary-user budget transition spend values');
	}
	const currentSpentMicros = await getAuthoritativeUserSpentMicrosD1(client, params.userId);
	if (currentSpentMicros == null
		|| roundGatewayMoney(userBudgetAmount(currentSpentMicros))
			!== roundGatewayMoney(params.expectedBudgetSpent)) {
		return false;
	}
	const preservesSpent = roundGatewayMoney(params.budgetSpent)
		=== roundGatewayMoney(params.expectedBudgetSpent);
	const nextSpentMicros = preservesSpent
		? currentSpentMicros
		: userBudgetUnits(params.budgetSpent);
	const expectedSpentMicros = currentSpentMicros;
	const nextSpent = userBudgetAmount(nextSpentMicros);
	const nextBase = roundGatewayMoney(params.budgetBase);
	const nextMax = params.budgetMax == null ? null : roundGatewayMoney(params.budgetMax);
	const updatedAt = uniqueD1MutationTimestamp();
	const metadataClause = params.metadata !== undefined ? ', metadata = ?' : '';
	const epochClause = params.resetEpoch
		? ', budget_epoch = budget_epoch + 1, budget_reserved_micros = 0'
		: '';
	const updateSql =
		'UPDATE users SET budget_max = ?, budget_base = ?, budget_spent = ?, budget_spent_micros = ?, budget_period = ?, budget_reset_at = ?, updated_at = ?' +
		epochClause +
		metadataClause +
		' WHERE id = ?';
	const binds: unknown[] = [
		nextMax, nextBase, nextSpent, nextSpentMicros,
		params.budgetPeriod, params.budgetResetAt, updatedAt,
	];
	if (params.metadata !== undefined) {
		binds.push(params.metadata);
	}
	binds.push(
		params.userId,
		params.expectedBudgetMax == null ? null : roundGatewayMoney(params.expectedBudgetMax),
		roundGatewayMoney(params.expectedBudgetBase),
		expectedSpentMicros,
		params.expectedBudgetPeriod,
		params.expectedBudgetResetAt,
		params.expectedBudgetEpoch,
		params.expectedBudgetReservedMicros,
	);
	const guardedUpdateSql = `${updateSql}
		AND budget_max IS NOT DISTINCT FROM ?
		AND ROUND(budget_base, 6) = ?
		AND budget_spent_micros = ?
		AND budget_period = ?
		AND budget_reset_at IS NOT DISTINCT FROM ?
		AND budget_epoch = ?
		AND budget_reserved_micros = ?`;
	const updateStmt = client.raw.prepare(guardedUpdateSql).bind(...binds);
	const auditStmt = buildConditionalUserAuditLogStatement(client, params.audit, {
		userId: params.userId,
		updatedAt,
	});
	const results = await client.raw.batch([updateStmt, auditStmt]);
	return (results[0]?.meta?.changes ?? 0) === 1;
}

type InsertRequestUsageAndChargeD1Params = {
	requestLog: InsertRequestLogParams;
	shouldChargeBudget: boolean;
	userId: string;
	beforeSpent: number;
	chargedCost: number;
	guardrailBudgetSettlement?: GuardrailBudgetSettlement;
	userBudgetSettlement?: UserBudgetSettlement;
	audit: Omit<InsertUserBudgetAuditLogParams, 'id' | 'afterSpent' | 'deltaSpent'>;
};

export async function insertRequestUsageAndChargeTxD1(
	client: D1DatabaseClient,
	params: InsertRequestUsageAndChargeD1Params,
): Promise<void> {
	await insertRequestUsageAndChargeTxD1Attempt(client, params, true);
}

async function insertRequestUsageAndChargeTxD1Attempt(
	client: D1DatabaseClient,
	params: InsertRequestUsageAndChargeD1Params,
	allowLateActualExpiryRetry: boolean,
): Promise<void> {
	assertProviderAttemptAvailabilityFacts(params.requestLog.providerAttempts);
	if (params.guardrailBudgetSettlement?.requestId !== undefined
		&& params.guardrailBudgetSettlement.requestId !== params.requestLog.id) {
		throw new Error('Guardrail budget settlement requestId must match request log id');
	}
	if (params.userBudgetSettlement?.requestId !== undefined
		&& params.userBudgetSettlement.requestId !== params.requestLog.id) {
		throw new Error('Ordinary-user budget settlement requestId must match request log id');
	}
	if (params.requestLog.userId !== params.userId) {
		throw new Error('Request log userId must match ordinary-user budget account');
	}
	if (!Number.isFinite(params.chargedCost) || params.chargedCost < 0) {
		throw new Error('Charged cost must be a finite non-negative number');
	}
	if (!Number.isFinite(params.requestLog.chargedCost)
		|| roundGatewayMoney(params.requestLog.chargedCost) !== roundGatewayMoney(params.chargedCost)) {
		throw new Error('Request log charged cost must match the budget settlement charge');
	}
	if (params.userBudgetSettlement
		&& (
			!['actual', 'reserved'].includes(params.userBudgetSettlement.mode)
			|| typeof params.userBudgetSettlement.reason !== 'string'
			|| params.userBudgetSettlement.reason.trim() === ''
		)) {
		throw new Error('Ordinary-user budget settlement mode and reason are required');
	}
	if (params.guardrailBudgetSettlement) {
		const reservations = (await client.raw.prepare(`SELECT reservation.assignment_id,
			reservation.scope_type, reservation.scope_id, reservation.settlement_basis
			FROM guardrail_budget_reservations AS reservation
			JOIN guardrail_budget_windows AS window
				ON window.workspace_id = reservation.workspace_id
				AND window.scope_type = reservation.scope_type
				AND window.scope_id = reservation.scope_id
				AND window.period = reservation.period
				AND window.period_start = reservation.period_start
			WHERE reservation.request_id = ?
				AND EXISTS (
					SELECT 1 FROM api_keys api_key
					WHERE api_key.id = ? AND api_key.workspace_id = reservation.workspace_id
				)
				AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired', 'released')
			ORDER BY reservation.assignment_id`)
			.bind(params.guardrailBudgetSettlement.requestId, params.requestLog.apiKeyId)
			.all<{
				assignment_id: string;
				scope_type: string;
				scope_id: string;
				settlement_basis: string;
			}>()).results ?? [];
		if (reservations.length === 0) {
			throw new Error('Guardrail budget settlement has no matching reservation window');
		}
		if (reservations.some((reservation) =>
			reservation.settlement_basis === 'gateway_key_route'
			&& (
				reservation.scope_type !== 'api_key'
				|| reservation.scope_id !== params.requestLog.apiKeyId
				|| reservation.assignment_id !== `gateway-key-limit:${params.requestLog.apiKeyId}`
			))) {
			throw new Error('Route-selective settlement is not the authenticated Gateway key limit');
		}
		if (params.requestLog.isByok === true
			&& reservations.some((reservation) => reservation.settlement_basis !== 'gateway_key_route')) {
			throw new Error('Private BYOK cannot settle non-key budget reservations');
		}
	}
	const charged = roundGatewayMoney(params.chargedCost);
	if (!Number.isFinite(charged)
		|| charged > userBudgetAmount(USER_BUDGET_MAX_SAFE_MICROS)) {
		throw new Error('Charged cost exceeds the safe ordinary-user micro-unit range');
	}
	const budgetChargedMicros = params.shouldChargeBudget ? guardrailBudgetUnits(charged) : 0;
	const standard = roundGatewayMoney(params.requestLog.standardCost);
	if (!Number.isFinite(standard) || standard < 0
		|| standard > userBudgetAmount(USER_BUDGET_MAX_SAFE_MICROS)) {
		throw new Error('Standard cost exceeds the safe Guardrail budget micro-unit range');
	}
	const byokStandardMicros = guardrailBudgetUnits(standard);
	const isByokRequest = params.requestLog.isByok === true ? 1 : 0;
	const ordinaryActualMicros = params.shouldChargeBudget ? userBudgetUnits(charged) : 0;
	let ordinarySettlementMicros: number | null = null;
	let ordinaryReservation: UserBudgetReservationRow | null = null;
	if (params.userBudgetSettlement) {
		ordinaryReservation = await client.raw.prepare(`SELECT * FROM user_budget_reservations
			WHERE request_id = ? LIMIT 1`)
			.bind(params.userBudgetSettlement.requestId)
			.first<UserBudgetReservationRow>();
		if (!ordinaryReservation) {
			throw new Error('Ordinary-user budget settlement has no matching reservation');
		}
		if (ordinaryReservation.user_id !== params.userId
			|| ordinaryReservation.user_id !== params.requestLog.userId
			|| ordinaryReservation.api_key_id !== params.requestLog.apiKeyId) {
			throw new Error('Ordinary-user budget settlement identity mismatch');
		}
		const reservedMicros = Number(ordinaryReservation.reserved_micros);
		const previousSettledMicros = Number(ordinaryReservation.settled_micros);
		const reservationEpoch = Number(ordinaryReservation.budget_epoch);
		if (!isSafeUserBudgetMicros(reservedMicros) || reservedMicros === 0
			|| !isSafeUserBudgetMicros(previousSettledMicros)
			|| !Number.isSafeInteger(reservationEpoch) || reservationEpoch < 0) {
			throw new Error('Ordinary-user budget reservation contains unsafe accounting values');
		}
		ordinarySettlementMicros = params.userBudgetSettlement.mode === 'reserved'
			? reservedMicros
			: ordinaryActualMicros;
		const terminalMatches =
			(params.userBudgetSettlement.mode === 'actual'
				&& (
					(ordinaryReservation.state === 'settled' && previousSettledMicros === ordinarySettlementMicros)
					|| (ordinaryReservation.state === 'expired' && previousSettledMicros === ordinarySettlementMicros)
				))
			|| (params.userBudgetSettlement.mode === 'reserved'
				&& ordinaryReservation.state === 'expired'
				&& previousSettledMicros === reservedMicros);
		const existingLog = await client.raw.prepare(`SELECT id, user_id, api_key_id,
			charged_cost, budget_charged_micros
			FROM api_key_request_logs WHERE id = ? LIMIT 1`)
			.bind(params.requestLog.id)
			.first<{
				id: string;
				user_id: string | null;
				api_key_id: string | null;
				charged_cost: number;
				budget_charged_micros: number;
			}>();
		if (existingLog) {
			if (!terminalMatches
				|| existingLog.user_id !== params.requestLog.userId
				|| existingLog.api_key_id !== params.requestLog.apiKeyId
				|| Number(existingLog.budget_charged_micros) !== budgetChargedMicros
				|| roundGatewayMoney(Number(existingLog.charged_cost)) !== charged) {
				throw new Error('Conflicting replay for ordinary-user budget settlement');
			}
			return;
		}
		if (ordinaryReservation.state === 'released') {
			throw new Error('Released ordinary-user budget reservation cannot be settled');
		}
		if (ordinaryReservation.state === 'settled' && !terminalMatches) {
			throw new Error('Ordinary-user budget reservation is already settled differently');
		}
		if (ordinaryReservation.state === 'expired'
			&& params.userBudgetSettlement.mode === 'reserved'
			&& !terminalMatches) {
			throw new Error('Expired ordinary-user budget reservation has an invalid ceiling charge');
		}
	}
	const now = nowIso();
	const delta = toPublicModelDailyStatsDelta(params.requestLog, now);
	const statements: D1PreparedStatement[] = [
		buildInsertRequestLogStatement(client.raw, { ...params.requestLog, budgetChargedMicros }, now),
		client.raw
			.prepare(
				`INSERT INTO public_model_daily_stats (
					stat_date, model_id, shard, request_count, success_count, error_count,
					output_tokens, total_tokens, latency_total_ms, latency_sample_count, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(stat_date, model_id, shard) DO UPDATE SET
					request_count = request_count + excluded.request_count,
					success_count = success_count + excluded.success_count,
					error_count = error_count + excluded.error_count,
					output_tokens = output_tokens + excluded.output_tokens,
					total_tokens = total_tokens + excluded.total_tokens,
					latency_total_ms = latency_total_ms + excluded.latency_total_ms,
					latency_sample_count = latency_sample_count + excluded.latency_sample_count,
					updated_at = excluded.updated_at`
			)
			.bind(
				delta.statDate, delta.modelId, delta.shard, delta.requestCount,
				delta.successCount, delta.errorCount, delta.outputTokens,
				delta.totalTokens,
				delta.latencyTotalMs, delta.latencySampleCount, now
			),
	];
	for (const attempt of params.requestLog.providerAttempts ?? []) {
		statements.push(client.raw.prepare(`INSERT INTO provider_attempt_availability (
			request_log_id, attempt_index, route_target_id, provider_id,
			outcome, reason, http_status, observed_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
			.bind(
				params.requestLog.id,
				attempt.attemptIndex,
				attempt.routeTargetId,
				attempt.providerId,
				attempt.outcome,
				attempt.reason,
				attempt.httpStatus,
				attempt.observedAtIso,
			));
	}
	if (params.userBudgetSettlement && ordinaryReservation && ordinarySettlementMicros !== null) {
		const settlement = params.userBudgetSettlement;
		if (ordinaryReservation.state === 'reserved' || ordinaryReservation.state === 'dispatched') {
			statements.push(client.raw.prepare(`UPDATE user_budget_reservations
				SET state = ?, settled_micros = ?, terminal_at = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state IN ('reserved', 'dispatched')`)
				.bind(
					settlement.mode === 'reserved' ? 'expired' : 'settled',
					ordinarySettlementMicros,
					now,
					settlement.reason.slice(0, 128),
					now,
					settlement.requestId,
				));
		} else if (ordinaryReservation.state === 'expired' && settlement.mode === 'actual'
			&& Number(ordinaryReservation.settled_micros) !== ordinarySettlementMicros) {
			statements.push(client.raw.prepare(`UPDATE user_budget_reservations
				SET settled_micros = ?, terminal_reason = ?, updated_at = ?
				WHERE request_id = ? AND state = 'expired' AND settled_micros = ?`)
				.bind(
					ordinarySettlementMicros,
					settlement.reason.slice(0, 128),
					now,
					settlement.requestId,
					Number(ordinaryReservation.settled_micros),
				));
		}
		const expectedTerminalState = settlement.mode === 'reserved'
			? 'expired'
			: ordinaryReservation.state === 'expired' ? 'expired' : 'settled';
		// CHECK(state) converts a stale/non-matching transition into a batch rollback.
		statements.push(client.raw.prepare(`UPDATE user_budget_reservations
			SET state = '__invalid_settlement_state__'
			WHERE request_id = ? AND NOT (state = ? AND settled_micros = ?)`)
			.bind(settlement.requestId, expectedTerminalState, ordinarySettlementMicros));
	}
	if (!params.userBudgetSettlement && params.shouldChargeBudget) {
		statements.push(
			client.raw
				.prepare(`UPDATE users SET
					budget_spent_micros = MIN(budget_spent_micros + ?, 9007199254740991),
					budget_spent = CAST(MIN(budget_spent_micros + ?, 9007199254740991) AS REAL) / 1000000.0,
					updated_at = ?
					WHERE id = ?`)
				.bind(ordinaryActualMicros, ordinaryActualMicros, now, params.userId)
		);
	}
	if (params.userBudgetSettlement || params.shouldChargeBudget) {
		const auditedCharge = params.userBudgetSettlement
			? userBudgetAmount(ordinarySettlementMicros ?? 0)
			: charged;
		const afterSpent = roundGatewayMoney(params.beforeSpent + auditedCharge);
		const auditRow = userBudgetAuditToInsertRowForUsageCharge(
			params.userId,
			afterSpent,
			auditedCharge,
			params.audit,
		);
		statements.push(params.userBudgetSettlement
			? buildEpochAwareUsageAuditLogStatement(
				client,
				auditRow,
				params.userBudgetSettlement.requestId,
			)
			: buildInsertUserAuditLogStatement(client.raw, auditRow));
	}
	if (params.guardrailBudgetSettlement) {
		const settlement = params.guardrailBudgetSettlement;
		if (settlement.mode === 'reserved') {
			statements.push(client.raw.prepare(`UPDATE guardrail_budget_reservations
					SET state = 'expired', settled_micros = reserved_micros,
						terminal_at = ?, terminal_reason = ?, updated_at = ?
					WHERE request_id = ? AND state IN ('reserved', 'dispatched')`)
				.bind(now, settlement.reason.slice(0, 128), now, settlement.requestId));
		} else {
			const actualSql = `CASE
				WHEN reservation.settlement_basis = 'gateway_key_route' AND ? = 1 THEN ?
				ELSE ?
			END`;
			// An expiry may conservatively settle the ceiling before late usage
			// arrives. If actual usage exceeds that ceiling, atomically add only
			// the overrun delta while preserving the expired terminal state.
			statements.push(
				client.raw.prepare(`UPDATE guardrail_budget_windows AS window
					SET settled_micros = settled_micros + COALESCE((
						SELECT SUM(CASE
							WHEN ${actualSql} > reservation.settled_micros
							THEN ${actualSql} - reservation.settled_micros
							ELSE 0
						END)
						FROM guardrail_budget_reservations AS reservation
						WHERE reservation.request_id = ?
							AND reservation.state = 'expired'
							AND reservation.workspace_id = window.workspace_id
							AND reservation.scope_type = window.scope_type
							AND reservation.scope_id = window.scope_id
							AND reservation.period = window.period
							AND reservation.period_start = window.period_start
					), 0), updated_at = ?
					WHERE EXISTS (
						SELECT 1 FROM guardrail_budget_reservations AS reservation
						WHERE reservation.request_id = ?
							AND reservation.state = 'expired'
							AND ${actualSql} > reservation.settled_micros
							AND reservation.workspace_id = window.workspace_id
							AND reservation.scope_type = window.scope_type
							AND reservation.scope_id = window.scope_id
							AND reservation.period = window.period
							AND reservation.period_start = window.period_start
					)`)
					.bind(
						isByokRequest, byokStandardMicros, budgetChargedMicros,
						isByokRequest, byokStandardMicros, budgetChargedMicros,
						settlement.requestId, now, settlement.requestId,
						isByokRequest, byokStandardMicros, budgetChargedMicros,
					),
				client.raw.prepare(`UPDATE guardrail_budget_reservations
					SET settled_micros = CASE
						WHEN settlement_basis = 'gateway_key_route' AND ? = 1 THEN ?
						ELSE ?
					END, terminal_reason = 'late_actual_overrun', updated_at = ?
					WHERE request_id = ? AND state = 'expired' AND settled_micros < CASE
						WHEN settlement_basis = 'gateway_key_route' AND ? = 1 THEN ?
						ELSE ?
					END`)
					.bind(
						isByokRequest, byokStandardMicros, budgetChargedMicros, now, settlement.requestId,
						isByokRequest, byokStandardMicros, budgetChargedMicros,
					),
				client.raw.prepare(`UPDATE guardrail_budget_reservations
					SET state = 'settled', settled_micros = CASE
						WHEN settlement_basis = 'gateway_key_route' AND ? = 1 THEN ?
						ELSE ?
					END,
						terminal_at = ?, terminal_reason = ?, updated_at = ?
					WHERE request_id = ? AND state IN ('reserved', 'dispatched')`)
					.bind(
						isByokRequest, byokStandardMicros, budgetChargedMicros,
						now, settlement.reason.slice(0, 128), now, settlement.requestId,
					),
			);
		}
	}
	if (budgetChargedMicros > 0) {
		const budgetAccountedAt = params.requestLog.budgetAccountedAt ?? now;
		statements.push(client.raw.prepare(`UPDATE guardrail_budget_windows AS window
			SET unreserved_micros = unreserved_micros + ?, updated_at = ?
			WHERE ? >= window.period_start AND ? < window.period_end
				AND EXISTS (
					SELECT 1 FROM api_keys api_key
					WHERE api_key.id = ? AND api_key.workspace_id = window.workspace_id
				)
				AND (
					(window.scope_type = 'user' AND window.scope_id = ?) OR
					(window.scope_type = 'api_key' AND window.scope_id = ?)
				)
				AND NOT EXISTS (
					SELECT 1 FROM guardrail_budget_reservations AS reservation
					WHERE reservation.request_id = ?
						AND reservation.workspace_id = window.workspace_id
						AND reservation.scope_type = window.scope_type
						AND reservation.scope_id = window.scope_id
						AND reservation.period = window.period
						AND reservation.period_start = window.period_start
						AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
				)`)
			.bind(
				budgetChargedMicros, now, budgetAccountedAt, budgetAccountedAt,
				params.requestLog.apiKeyId, params.requestLog.userId,
				params.requestLog.apiKeyId, params.requestLog.id,
			));
	}
	try {
		await ensureD1Batch(client, statements);
	} catch (error) {
		if (params.userBudgetSettlement && ordinarySettlementMicros !== null) {
			const [reservation, log] = await Promise.all([
				client.raw.prepare(`SELECT state, settled_micros FROM user_budget_reservations
					WHERE request_id = ? LIMIT 1`)
					.bind(params.userBudgetSettlement.requestId)
					.first<{ state: string; settled_micros: number }>(),
				client.raw.prepare(`SELECT user_id, api_key_id, charged_cost, budget_charged_micros
					FROM api_key_request_logs WHERE id = ? LIMIT 1`)
					.bind(params.requestLog.id)
					.first<{
						user_id: string | null;
						api_key_id: string | null;
						charged_cost: number;
						budget_charged_micros: number;
					}>(),
			]);
			const terminalMatches = reservation != null
				&& Number(reservation.settled_micros) === ordinarySettlementMicros
				&& (
					(params.userBudgetSettlement.mode === 'reserved' && reservation.state === 'expired')
					|| (params.userBudgetSettlement.mode === 'actual'
						&& (reservation.state === 'settled' || reservation.state === 'expired'))
				);
			if (terminalMatches && log
				&& log.user_id === params.requestLog.userId
				&& log.api_key_id === params.requestLog.apiKeyId
				&& Number(log.budget_charged_micros) === budgetChargedMicros
				&& roundGatewayMoney(Number(log.charged_cost)) === charged) {
				return;
			}
			const initiallyActive = ordinaryReservation?.state === 'reserved'
				|| ordinaryReservation?.state === 'dispatched';
			if (allowLateActualExpiryRetry
				&& params.userBudgetSettlement.mode === 'actual'
				&& initiallyActive
				&& reservation?.state === 'expired'
				&& log == null) {
				// D1 has no row locks: expiry can win after the pre-read but before
				// this atomic batch. Retry exactly once from the newly observed
				// expired state so the late-actual delta path is rebuilt. No other
				// failure or state transition is retried.
				await insertRequestUsageAndChargeTxD1Attempt(client, params, false);
				return;
			}
		}
		throw error;
	}
}
