/**
 * Postgres：关键写路径（Drizzle 事务），供 `storage/critical-write-paths` 调度。
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { InsertUserAuditLogParams } from '../user-audit-logs-types';
import type { InsertUserBudgetAuditLogParams } from '../user-budget-audit-params';
import type { InsertKeyParams } from '../api-keys-types';
import { prepareGatewayApiKeyForStorage } from '../../lib/key-hash';
import { assertGenerationSnapshotIsValid, type InsertRequestLogParams } from '../request-logs-types';
import { guardrailBudgetUnits, type GuardrailBudgetSettlement } from '../guardrail-budget-types';
import {
	isSafeUserBudgetMicros,
	USER_BUDGET_MAX_SAFE_MICROS,
	userBudgetAmount,
	userBudgetUnits,
	type UserBudgetSettlement,
} from '../user-budget-reservation-types';
import { toPublicModelDailyStatsDelta } from '../public-model-daily-stats';
import {
	userBudgetAuditToInsertRowForBudgetTx,
	userBudgetAuditToInsertRowForCreateKey,
	userBudgetAuditToInsertRowForUsageCharge,
} from '../user-budget-audit-mapper';
import { toUserAuditLogDrizzleInsert } from '../user-audit-drizzle-insert';
import { roundGatewayMoney } from '../../lib/money-precision';
import type { PostgresDatabaseClient } from '../../storage/database-client';
import { nowIso, parseMoney } from '../../storage/critical-write-paths-utils';
import {
	apiKeysTable as pgApiKeysTable,
	apiKeyRequestLogsTable as pgRequestLogsTable,
	guardrailBudgetReservationsTable as pgGuardrailBudgetReservationsTable,
	guardrailBudgetWindowsTable as pgGuardrailBudgetWindowsTable,
	publicModelDailyStatsTable as pgPublicModelDailyStatsTable,
	systemConfigTable as pgSystemConfigTable,
	userAuditLogsTable as pgUserAuditLogsTable,
	userBudgetReservationsTable as pgUserBudgetReservationsTable,
	usersTable as pgUsersTable,
} from '../../storage/drizzle/schema.pg';

export async function getUserBudgetSnapshotPg(
	client: PostgresDatabaseClient,
	userId: string
): Promise<{ budgetSpent: number; budgetMax: number | null; budgetPeriod: string | null; budgetResetAt: string | null } | null> {
	const row = await client.drizzle
		.select({
			budgetSpent: pgUsersTable.budgetSpent,
			budgetMax: pgUsersTable.budgetMax,
			budgetPeriod: pgUsersTable.budgetPeriod,
			budgetResetAt: pgUsersTable.budgetResetAt,
		})
		.from(pgUsersTable)
		.where(eq(pgUsersTable.id, userId))
		.limit(1);
	if (!row[0]) return null;
	return {
		budgetSpent: parseMoney(row[0].budgetSpent),
		budgetMax: row[0].budgetMax == null ? null : parseMoney(row[0].budgetMax),
		budgetPeriod: row[0].budgetPeriod,
		budgetResetAt: row[0].budgetResetAt,
	};
}

export async function getSystemConfigValuePg(client: PostgresDatabaseClient, key: string): Promise<string | null> {
	const row = await client.drizzle
		.select({ value: pgSystemConfigTable.value })
		.from(pgSystemConfigTable)
		.where(eq(pgSystemConfigTable.key, key))
		.limit(1);
	return row[0]?.value ?? null;
}

export async function createApiKeyWithAuditPg(
	client: PostgresDatabaseClient,
	params: {
		insert: InsertKeyParams;
		audit: InsertUserBudgetAuditLogParams;
	}
): Promise<void> {
	const now = nowIso();
	const auditRow = userBudgetAuditToInsertRowForCreateKey(params.insert.userId, params.audit);
	const preparedKey = await prepareGatewayApiKeyForStorage(params.insert.key);
	await client.drizzle.transaction(async (tx) => {
		const status = params.insert.status ?? 'active';
		await tx.insert(pgApiKeysTable).values({
			id: params.insert.id,
			key: preparedKey.storageKey,
			keyHash: preparedKey.keyHash,
			keyPreview: preparedKey.keyPreview,
			userId: params.insert.userId,
			workspaceId: params.insert.workspaceId,
			name: params.insert.name ?? null,
			status,
			metadata: params.insert.metadata ?? null,
			expiresAt: params.insert.expiresAt ?? null,
			lastUsedAt: null,
			createdAt: now,
			updatedAt: now,
		});
		await tx.insert(pgUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
	});
}

export async function updateUserBudgetWithAuditTxPg(
	client: PostgresDatabaseClient,
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
	const nextSpent = roundGatewayMoney(params.budgetSpent);
	const now = nowIso();
	const auditRow = userBudgetAuditToInsertRowForBudgetTx(
		params.userId,
		params.apiKeyId,
		nextSpent,
		params.budgetResetAt,
		params.audit
	);
	return client.drizzle.transaction(async (tx) => {
		const updateSet: Record<string, unknown> = {
			budgetSpent: String(nextSpent),
			budgetResetAt: params.budgetResetAt,
			budgetEpoch: sql`${pgUsersTable.budgetEpoch} + 1`,
			budgetReservedMicros: 0,
			updatedAt: now,
		};
		if (params.budgetMax !== undefined) {
			updateSet.budgetMax = params.budgetMax == null ? null : String(roundGatewayMoney(params.budgetMax));
		}
		const updated = await tx
			.update(pgUsersTable)
			.set(updateSet)
			.where(
				and(
					eq(pgUsersTable.id, params.userId),
					sql`${pgUsersTable.budgetMax} IS NOT DISTINCT FROM ${params.expectedBudgetMax == null
						? null
						: String(roundGatewayMoney(params.expectedBudgetMax))}`,
					eq(pgUsersTable.budgetBase, String(roundGatewayMoney(params.expectedBudgetBase))),
					eq(pgUsersTable.budgetSpent, String(roundGatewayMoney(params.expectedBudgetSpent))),
					eq(pgUsersTable.budgetPeriod, params.expectedBudgetPeriod),
					sql`${pgUsersTable.budgetResetAt} IS NOT DISTINCT FROM ${params.expectedBudgetResetAt}`,
					eq(pgUsersTable.budgetEpoch, params.expectedBudgetEpoch),
					eq(pgUsersTable.budgetReservedMicros, params.expectedBudgetReservedMicros),
				)
			)
			.returning({ id: pgUsersTable.id });
		if (updated.length === 0) {
			return false;
		}

		await tx.insert(pgUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
		return true;
	});
}

export async function applyUserBudgetTransitionWithAuditPg(
	client: PostgresDatabaseClient,
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
	const now = nowIso();
	let updated = false;
	await client.drizzle.transaction(async (tx) => {
		const updateSet: Record<string, unknown> = {
			budgetMax: params.budgetMax == null ? null : String(roundGatewayMoney(params.budgetMax)),
			budgetBase: String(roundGatewayMoney(params.budgetBase)),
			budgetSpent: String(roundGatewayMoney(params.budgetSpent)),
			budgetPeriod: params.budgetPeriod,
			budgetResetAt: params.budgetResetAt,
			updatedAt: now,
		};
		if (params.resetEpoch) {
			updateSet.budgetEpoch = sql`${pgUsersTable.budgetEpoch} + 1`;
			updateSet.budgetReservedMicros = 0;
		}
		if (params.metadata !== undefined) {
			updateSet.metadata = params.metadata;
		}
		const rows = await tx
			.update(pgUsersTable)
			.set(updateSet)
			.where(and(
				eq(pgUsersTable.id, params.userId),
				sql`${pgUsersTable.budgetMax} IS NOT DISTINCT FROM ${params.expectedBudgetMax == null
					? null
					: String(roundGatewayMoney(params.expectedBudgetMax))}`,
				eq(pgUsersTable.budgetBase, String(roundGatewayMoney(params.expectedBudgetBase))),
				eq(pgUsersTable.budgetSpent, String(roundGatewayMoney(params.expectedBudgetSpent))),
				eq(pgUsersTable.budgetPeriod, params.expectedBudgetPeriod),
				sql`${pgUsersTable.budgetResetAt} IS NOT DISTINCT FROM ${params.expectedBudgetResetAt}`,
				eq(pgUsersTable.budgetEpoch, params.expectedBudgetEpoch),
				eq(pgUsersTable.budgetReservedMicros, params.expectedBudgetReservedMicros),
			))
			.returning({ id: pgUsersTable.id });
		if (rows.length === 0) {
			return;
		}
		updated = true;
		await tx.insert(pgUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(params.audit, now));
	});
	return updated;
}

export async function insertRequestUsageAndChargeTxPg(
	client: PostgresDatabaseClient,
	params: {
		requestLog: InsertRequestLogParams;
		shouldChargeBudget: boolean;
		userId: string;
		beforeSpent: number;
		chargedCost: number;
		guardrailBudgetSettlement?: GuardrailBudgetSettlement;
		userBudgetSettlement?: UserBudgetSettlement;
		audit: Omit<InsertUserBudgetAuditLogParams, 'id' | 'afterSpent' | 'deltaSpent'>;
	}
): Promise<void> {
	assertGenerationSnapshotIsValid(params.requestLog);
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
	const charged = roundGatewayMoney(params.chargedCost);
	if (!Number.isFinite(charged)
		|| charged > userBudgetAmount(USER_BUDGET_MAX_SAFE_MICROS)) {
		throw new Error('Charged cost exceeds the safe ordinary-user micro-unit range');
	}
	const budgetChargedMicros = params.shouldChargeBudget ? guardrailBudgetUnits(charged) : 0;
	const ordinaryActualMicros = params.shouldChargeBudget ? userBudgetUnits(charged) : 0;
	const now = nowIso();
	const delta = toPublicModelDailyStatsDelta(params.requestLog, now);
	await client.drizzle.transaction(async (tx) => {
		const requestWorkspaceId = (await tx
			.select({ workspaceId: pgApiKeysTable.workspaceId })
			.from(pgApiKeysTable)
			.where(eq(pgApiKeysTable.id, params.requestLog.apiKeyId))
			.for('update'))[0]?.workspaceId ?? null;
		if (requestWorkspaceId === null || requestWorkspaceId !== params.requestLog.workspaceId) {
			throw new Error('Request log Workspace snapshot does not match API key');
		}
		let ordinarySettlementMicros: number | null = null;
		let ordinaryReservationEpoch: number | null = null;
		if (params.userBudgetSettlement) {
			const settlement = params.userBudgetSettlement;
			const reservations = await tx.select({
				requestId: pgUserBudgetReservationsTable.requestId,
				userId: pgUserBudgetReservationsTable.userId,
				apiKeyId: pgUserBudgetReservationsTable.apiKeyId,
				budgetEpoch: pgUserBudgetReservationsTable.budgetEpoch,
				reservedMicros: pgUserBudgetReservationsTable.reservedMicros,
				settledMicros: pgUserBudgetReservationsTable.settledMicros,
				state: pgUserBudgetReservationsTable.state,
			}).from(pgUserBudgetReservationsTable)
				.where(eq(pgUserBudgetReservationsTable.requestId, settlement.requestId))
				.for('update');
			const reservation = reservations[0];
			if (!reservation) {
				throw new Error('Ordinary-user budget settlement has no matching reservation');
			}
			if (reservation.userId !== params.userId
				|| reservation.userId !== params.requestLog.userId
				|| reservation.apiKeyId !== params.requestLog.apiKeyId) {
				throw new Error('Ordinary-user budget settlement identity mismatch');
			}
			const reservedMicros = Number(reservation.reservedMicros);
			const previousSettledMicros = Number(reservation.settledMicros);
			const reservationEpoch = Number(reservation.budgetEpoch);
			ordinaryReservationEpoch = reservationEpoch;
			if (!isSafeUserBudgetMicros(reservedMicros) || reservedMicros === 0
				|| !isSafeUserBudgetMicros(previousSettledMicros)
				|| !Number.isSafeInteger(reservationEpoch) || reservationEpoch < 0) {
				throw new Error('Ordinary-user budget reservation contains unsafe accounting values');
			}
			ordinarySettlementMicros = settlement.mode === 'reserved'
				? reservedMicros
				: ordinaryActualMicros;

			const existingLogs = await tx.select({
				id: pgRequestLogsTable.id,
				userId: pgRequestLogsTable.userId,
				apiKeyId: pgRequestLogsTable.apiKeyId,
				workspaceId: pgRequestLogsTable.workspaceId,
				chargedCost: pgRequestLogsTable.chargedCost,
				budgetChargedMicros: pgRequestLogsTable.budgetChargedMicros,
			}).from(pgRequestLogsTable)
				.where(eq(pgRequestLogsTable.id, params.requestLog.id))
				.for('update');
			const existingLog = existingLogs[0];
			const terminalMatches =
				(settlement.mode === 'actual'
					&& (
						(reservation.state === 'settled' && previousSettledMicros === ordinarySettlementMicros)
						|| (reservation.state === 'expired' && previousSettledMicros === ordinarySettlementMicros)
					))
				|| (settlement.mode === 'reserved'
					&& reservation.state === 'expired'
					&& previousSettledMicros === reservedMicros);
			if (existingLog) {
				if (!terminalMatches
					|| existingLog.userId !== params.requestLog.userId
					|| existingLog.apiKeyId !== params.requestLog.apiKeyId
					|| existingLog.workspaceId !== params.requestLog.workspaceId
					|| Number(existingLog.budgetChargedMicros) !== budgetChargedMicros
					|| roundGatewayMoney(Number(existingLog.chargedCost)) !== charged) {
					throw new Error('Conflicting replay for ordinary-user budget settlement');
				}
				return;
			}

			if (reservation.state === 'released') {
				throw new Error('Released ordinary-user budget reservation cannot be settled');
			}
			if (reservation.state === 'settled') {
				if (!terminalMatches) {
					throw new Error('Ordinary-user budget reservation is already settled differently');
				}
			} else if (reservation.state === 'expired') {
				if (settlement.mode === 'reserved') {
					if (!terminalMatches) {
						throw new Error('Expired ordinary-user budget reservation has an invalid ceiling charge');
					}
				} else if (previousSettledMicros === ordinarySettlementMicros) {
				} else {
					const accounts = await tx.select({
						id: pgUsersTable.id,
						budgetEpoch: pgUsersTable.budgetEpoch,
					}).from(pgUsersTable).where(eq(pgUsersTable.id, reservation.userId)).for('update');
					const account = accounts[0];
					if (!account) throw new Error('Ordinary-user budget account is missing');
					const reconciliationMicros = ordinarySettlementMicros - previousSettledMicros;
					if (Number(account.budgetEpoch) === reservationEpoch && reconciliationMicros !== 0) {
						const updated = await tx.update(pgUsersTable).set({
							budgetSpent: sql`ROUND(GREATEST(${pgUsersTable.budgetSpent} + (${reconciliationMicros}::numeric / 1000000::numeric), 0::numeric), 6)`,
							updatedAt: now,
						}).where(and(
							eq(pgUsersTable.id, reservation.userId),
							eq(pgUsersTable.budgetEpoch, reservationEpoch),
						)).returning({ id: pgUsersTable.id });
						if (updated.length !== 1) throw new Error('Ordinary-user late settlement account changed concurrently');
					}
					const updated = await tx.update(pgUserBudgetReservationsTable).set({
						settledMicros: ordinarySettlementMicros,
						terminalReason: settlement.reason.slice(0, 128),
						updatedAt: now,
					}).where(and(
						eq(pgUserBudgetReservationsTable.requestId, settlement.requestId),
						eq(pgUserBudgetReservationsTable.state, 'expired'),
						eq(pgUserBudgetReservationsTable.settledMicros, previousSettledMicros),
					)).returning({ requestId: pgUserBudgetReservationsTable.requestId });
					if (updated.length !== 1) throw new Error('Ordinary-user late settlement reservation changed concurrently');
				}
			} else if (reservation.state === 'reserved' || reservation.state === 'dispatched') {
				const accounts = await tx.select({
					id: pgUsersTable.id,
					budgetEpoch: pgUsersTable.budgetEpoch,
					budgetReservedMicros: pgUsersTable.budgetReservedMicros,
				}).from(pgUsersTable).where(eq(pgUsersTable.id, reservation.userId)).for('update');
				const account = accounts[0];
				if (!account) throw new Error('Ordinary-user budget account is missing');
				if (Number(account.budgetEpoch) === reservationEpoch) {
					const currentReservedMicros = Number(account.budgetReservedMicros);
					if (!isSafeUserBudgetMicros(currentReservedMicros) || currentReservedMicros < reservedMicros) {
						throw new Error('Ordinary-user reserved budget counter invariant violated');
					}
					const updated = await tx.update(pgUsersTable).set({
						budgetReservedMicros: sql`${pgUsersTable.budgetReservedMicros} - ${reservedMicros}`,
						budgetSpent: sql`ROUND(GREATEST(${pgUsersTable.budgetSpent} + (${ordinarySettlementMicros}::numeric / 1000000::numeric), 0::numeric), 6)`,
						updatedAt: now,
					}).where(and(
						eq(pgUsersTable.id, reservation.userId),
						eq(pgUsersTable.budgetEpoch, reservationEpoch),
						sql`${pgUsersTable.budgetReservedMicros} >= ${reservedMicros}`,
					)).returning({ id: pgUsersTable.id });
					if (updated.length !== 1) throw new Error('Ordinary-user reserved budget counter invariant violated');
				}
				const updated = await tx.update(pgUserBudgetReservationsTable).set({
					state: settlement.mode === 'reserved' ? 'expired' : 'settled',
					settledMicros: ordinarySettlementMicros,
					terminalAt: now,
					terminalReason: settlement.reason.slice(0, 128),
					updatedAt: now,
				}).where(and(
					eq(pgUserBudgetReservationsTable.requestId, settlement.requestId),
					inArray(pgUserBudgetReservationsTable.state, ['reserved', 'dispatched']),
				)).returning({ requestId: pgUserBudgetReservationsTable.requestId });
				if (updated.length !== 1) throw new Error('Ordinary-user budget settlement reservation changed concurrently');
			} else {
				throw new Error('Ordinary-user budget reservation has an invalid state');
			}
		}
		await tx.insert(pgRequestLogsTable).values({
			id: params.requestLog.id,
			userId: params.requestLog.userId,
			apiKeyId: params.requestLog.apiKeyId,
			workspaceId: params.requestLog.workspaceId,
			userEmail: params.requestLog.userEmail ?? null,
			modelId: params.requestLog.modelId ?? null,
			providerId: params.requestLog.providerId ?? null,
			providerModelName: params.requestLog.providerModelName ?? null,
			modelName: params.requestLog.modelName ?? null,
			providerName: params.requestLog.providerName ?? null,
			requestBody: params.requestLog.requestBody ?? null,
			upstreamRequestBody: params.requestLog.upstreamRequestBody ?? null,
			requestProtocol: params.requestLog.requestProtocol ?? null,
			requestOperation: params.requestLog.requestOperation ?? null,
			upstreamProtocol: params.requestLog.upstreamProtocol,
			upstreamOperation: params.requestLog.upstreamOperation ?? null,
			modelSurfaceId: params.requestLog.modelSurfaceId ?? null,
			routePoolId: params.requestLog.routePoolId ?? null,
			routeTargetId: params.requestLog.routeTargetId ?? null,
			adapter: params.requestLog.adapter ?? null,
			routeTrace: params.requestLog.routeTrace ?? null,
			inputTokens: params.requestLog.inputTokens,
			outputTokens: params.requestLog.outputTokens,
			cacheReadTokens: params.requestLog.cacheReadTokens,
			cacheWriteTokens: params.requestLog.cacheWriteTokens,
			reasoningTokens: params.requestLog.reasoningTokens,
			totalTokens: params.requestLog.totalTokens,
			meteredCost: String(roundGatewayMoney(params.requestLog.meteredCost)),
			standardCost: String(roundGatewayMoney(params.requestLog.standardCost)),
			chargedCost: String(roundGatewayMoney(params.requestLog.chargedCost)),
			budgetChargedMicros,
			budgetAccountedAt: params.requestLog.budgetAccountedAt ?? null,
			routeGroup: params.requestLog.routeGroup,
			status: params.requestLog.status,
			latencyMs: params.requestLog.latencyMs ?? null,
			gatewayOverheadMs: params.requestLog.gatewayOverheadMs ?? null,
			upstreamResponseMs: params.requestLog.upstreamResponseMs ?? null,
			finalUpstreamHeadersMs: params.requestLog.finalUpstreamHeadersMs ?? null,
			firstReasoningTokenMs: params.requestLog.firstReasoningTokenMs ?? null,
			firstTokenMs: params.requestLog.firstTokenMs ?? null,
			streamDurationMs: params.requestLog.streamDurationMs ?? null,
			upstreamAttemptCount: params.requestLog.upstreamAttemptCount ?? null,
			upstreamFailoverCount: params.requestLog.upstreamFailoverCount ?? null,
			timingMetadata: params.requestLog.timingMetadata ?? null,
			errorMessage: params.requestLog.errorMessage ?? null,
			rawUsage: params.requestLog.rawUsage ?? null,
			pricingAudit: params.requestLog.pricingAudit ?? null,
			providerKeyId: params.requestLog.providerKeyId ?? null,
			providerKeyLabel: params.requestLog.providerKeyLabel ?? null,
			providerKeyFingerprint: params.requestLog.providerKeyFingerprint ?? null,
			upstreamRequestId: params.requestLog.upstreamRequestId ?? null,
			upstreamMessageId: params.requestLog.upstreamMessageId ?? null,
			billingKind: params.requestLog.billingKind ?? null,
			inputImageCount: params.requestLog.inputImageCount ?? 0,
			outputImageCount: params.requestLog.outputImageCount ?? 0,
			audioDurationSeconds: params.requestLog.audioDurationSeconds ?? null,
			audioCharacters: params.requestLog.audioCharacters ?? null,
			requestOrigin: params.requestLog.requestOrigin ?? null,
			responseStreamed: params.requestLog.responseStreamed ?? null,
			dataRegion: params.requestLog.dataRegion ?? null,
			isByok: params.requestLog.isByok ?? null,
			chargedCostUsd: params.requestLog.chargedCostUsd == null
				? null
				: String(roundGatewayMoney(params.requestLog.chargedCostUsd)),
			upstreamInferenceCostUsd: params.requestLog.upstreamInferenceCostUsd == null
				? null
				: String(roundGatewayMoney(params.requestLog.upstreamInferenceCostUsd)),
			createdAt: now,
		});
		await tx
			.insert(pgPublicModelDailyStatsTable)
			.values({
				statDate: delta.statDate,
				modelId: delta.modelId,
				shard: delta.shard,
				requestCount: delta.requestCount,
				successCount: delta.successCount,
				errorCount: delta.errorCount,
				outputTokens: delta.outputTokens,
				latencyTotalMs: delta.latencyTotalMs,
				latencySampleCount: delta.latencySampleCount,
				updatedAt: now,
			})
			.onConflictDoUpdate({
				target: [
					pgPublicModelDailyStatsTable.statDate,
					pgPublicModelDailyStatsTable.modelId,
					pgPublicModelDailyStatsTable.shard,
				],
				set: {
					requestCount: sql`${pgPublicModelDailyStatsTable.requestCount} + excluded.request_count`,
					successCount: sql`${pgPublicModelDailyStatsTable.successCount} + excluded.success_count`,
					errorCount: sql`${pgPublicModelDailyStatsTable.errorCount} + excluded.error_count`,
					outputTokens: sql`${pgPublicModelDailyStatsTable.outputTokens} + excluded.output_tokens`,
					latencyTotalMs: sql`${pgPublicModelDailyStatsTable.latencyTotalMs} + excluded.latency_total_ms`,
					latencySampleCount: sql`${pgPublicModelDailyStatsTable.latencySampleCount} + excluded.latency_sample_count`,
					updatedAt: now,
				},
			});
		if (!params.userBudgetSettlement && params.shouldChargeBudget) {
			await tx
				.update(pgUsersTable)
				.set({
					budgetSpent: sql`${pgUsersTable.budgetSpent} + ${String(charged)}`,
					updatedAt: now,
				})
				.where(eq(pgUsersTable.id, params.userId));
		}
		if (params.userBudgetSettlement || params.shouldChargeBudget) {
			const auditedCharge = params.userBudgetSettlement
				? userBudgetAmount(ordinarySettlementMicros ?? 0)
				: charged;
			const afterSpent = roundGatewayMoney(params.beforeSpent + auditedCharge);
			let auditParams = params.audit;
			if (params.userBudgetSettlement && ordinaryReservationEpoch !== null) {
				const accounts = await tx.select({
					budgetEpoch: pgUsersTable.budgetEpoch,
				}).from(pgUsersTable)
					.where(eq(pgUsersTable.id, params.userId))
					.for('update');
				const account = accounts[0];
				if (!account) throw new Error('Ordinary-user budget account is missing');
				if (Number(account.budgetEpoch) !== ordinaryReservationEpoch) {
					auditParams = {
						...params.audit,
						beforeUserSnapshot: null,
						afterUserSnapshot: null,
						changedFields: null,
					};
				}
			}
			const auditRow = userBudgetAuditToInsertRowForUsageCharge(
				params.userId,
				afterSpent,
				auditedCharge,
				auditParams,
			);
			await tx.insert(pgUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
		}
		if (params.guardrailBudgetSettlement) {
			const settlement = params.guardrailBudgetSettlement;
			const existingReservations = await tx.select({
				id: pgGuardrailBudgetReservationsTable.id,
				workspaceId: pgGuardrailBudgetReservationsTable.workspaceId,
				scopeType: pgGuardrailBudgetReservationsTable.scopeType,
				scopeId: pgGuardrailBudgetReservationsTable.scopeId,
				period: pgGuardrailBudgetReservationsTable.period,
				periodStart: pgGuardrailBudgetReservationsTable.periodStart,
				settledMicros: pgGuardrailBudgetReservationsTable.settledMicros,
				state: pgGuardrailBudgetReservationsTable.state,
			}).from(pgGuardrailBudgetReservationsTable).where(and(
				eq(pgGuardrailBudgetReservationsTable.requestId, settlement.requestId),
				inArray(pgGuardrailBudgetReservationsTable.state, ['reserved', 'dispatched', 'expired', 'released']),
			)).for('update');
			if (existingReservations.length === 0) {
				throw new Error('Guardrail budget settlement has no matching reservation');
			}
			if (requestWorkspaceId == null
				|| existingReservations.some((reservation) => reservation.workspaceId !== requestWorkspaceId)) {
				throw new Error('Guardrail budget settlement Workspace identity mismatch');
			}
			const terminalState = settlement.mode === 'reserved' ? 'expired' : 'settled';
			const claimed = await tx
				.update(pgGuardrailBudgetReservationsTable)
				.set({
					state: terminalState,
					settledMicros: settlement.mode === 'reserved'
						? sql`${pgGuardrailBudgetReservationsTable.reservedMicros}`
						: budgetChargedMicros,
					terminalAt: now,
					terminalReason: settlement.reason.slice(0, 128),
					updatedAt: now,
				})
				.where(and(
					eq(pgGuardrailBudgetReservationsTable.requestId, settlement.requestId),
					inArray(pgGuardrailBudgetReservationsTable.state, ['reserved', 'dispatched']),
				))
				.returning({
					workspaceId: pgGuardrailBudgetReservationsTable.workspaceId,
					scopeType: pgGuardrailBudgetReservationsTable.scopeType,
					scopeId: pgGuardrailBudgetReservationsTable.scopeId,
					period: pgGuardrailBudgetReservationsTable.period,
					periodStart: pgGuardrailBudgetReservationsTable.periodStart,
					reservedMicros: pgGuardrailBudgetReservationsTable.reservedMicros,
					settledMicros: pgGuardrailBudgetReservationsTable.settledMicros,
				});
			const orderedClaims = [...claimed].sort((left, right) =>
				[
					left.workspaceId,
					left.scopeType,
					left.scopeId,
					left.period,
					String(left.periodStart),
				].join('\u0000').localeCompare([
					right.workspaceId,
					right.scopeType,
					right.scopeId,
					right.period,
					String(right.periodStart),
				].join('\u0000')),
			);
			for (const reservation of orderedClaims) {
				const updatedWindows = await tx.update(pgGuardrailBudgetWindowsTable).set({
					reservedMicros: sql`${pgGuardrailBudgetWindowsTable.reservedMicros} - ${reservation.reservedMicros}`,
					settledMicros: sql`${pgGuardrailBudgetWindowsTable.settledMicros} + ${reservation.settledMicros}`,
					updatedAt: now,
				}).where(and(
					eq(pgGuardrailBudgetWindowsTable.workspaceId, reservation.workspaceId),
					eq(pgGuardrailBudgetWindowsTable.scopeType, reservation.scopeType),
					eq(pgGuardrailBudgetWindowsTable.scopeId, reservation.scopeId),
					eq(pgGuardrailBudgetWindowsTable.period, reservation.period),
					eq(pgGuardrailBudgetWindowsTable.periodStart, reservation.periodStart),
				)).returning({ scopeType: pgGuardrailBudgetWindowsTable.scopeType });
				if (updatedWindows.length !== 1) throw new Error('Guardrail budget settlement window is missing');
			}
			if (settlement.mode === 'actual') {
				const overruns = existingReservations
					.filter((reservation) => reservation.state === 'expired')
					.filter((reservation) => budgetChargedMicros > Number(reservation.settledMicros))
					.sort((left, right) => [
						left.workspaceId, left.scopeType, left.scopeId, left.period, String(left.periodStart),
					].join('\u0000').localeCompare([
						right.workspaceId, right.scopeType, right.scopeId, right.period, String(right.periodStart),
					].join('\u0000')));
				for (const reservation of overruns) {
					const delta = budgetChargedMicros - Number(reservation.settledMicros);
					const updatedReservations = await tx.update(pgGuardrailBudgetReservationsTable).set({
						settledMicros: budgetChargedMicros,
						terminalReason: 'late_actual_overrun',
						updatedAt: now,
					}).where(and(
						eq(pgGuardrailBudgetReservationsTable.id, reservation.id),
						eq(pgGuardrailBudgetReservationsTable.state, 'expired'),
					)).returning({ id: pgGuardrailBudgetReservationsTable.id });
					if (updatedReservations.length !== 1) throw new Error('Guardrail budget late settlement reservation changed concurrently');
					const updatedWindows = await tx.update(pgGuardrailBudgetWindowsTable).set({
						settledMicros: sql`${pgGuardrailBudgetWindowsTable.settledMicros} + ${delta}`,
						updatedAt: now,
					}).where(and(
						eq(pgGuardrailBudgetWindowsTable.workspaceId, reservation.workspaceId),
						eq(pgGuardrailBudgetWindowsTable.scopeType, reservation.scopeType),
						eq(pgGuardrailBudgetWindowsTable.scopeId, reservation.scopeId),
						eq(pgGuardrailBudgetWindowsTable.period, reservation.period),
						eq(pgGuardrailBudgetWindowsTable.periodStart, reservation.periodStart),
					)).returning({ scopeType: pgGuardrailBudgetWindowsTable.scopeType });
					if (updatedWindows.length !== 1) throw new Error('Guardrail budget late settlement window is missing');
					console.warn(`Guardrail budget estimate overrun reconciled request_id=${settlement.requestId} delta_micros=${delta}`);
				}
			}
		}
		if (budgetChargedMicros > 0 && requestWorkspaceId != null) {
			const budgetAccountedAt = params.requestLog.budgetAccountedAt ?? now;
			await tx.execute(sql`UPDATE guardrail_budget_windows AS w
				SET unreserved_micros = w.unreserved_micros + ${budgetChargedMicros},
					updated_at = ${now}
				WHERE ${budgetAccountedAt} >= w.period_start
					AND ${budgetAccountedAt} < w.period_end
					AND w.workspace_id = ${requestWorkspaceId}
					AND (
						(w.scope_type = 'user' AND w.scope_id = ${params.requestLog.userId}) OR
						(w.scope_type = 'api_key' AND w.scope_id = ${params.requestLog.apiKeyId})
					)
					AND NOT EXISTS (
						SELECT 1 FROM guardrail_budget_reservations AS reservation
						WHERE reservation.request_id = ${params.requestLog.id}
							AND reservation.workspace_id = w.workspace_id
							AND reservation.scope_type = w.scope_type
							AND reservation.scope_id = w.scope_id
							AND reservation.period = w.period
							AND reservation.period_start = w.period_start
							AND reservation.state IN ('reserved', 'dispatched', 'settled', 'expired')
					)`);
		}
	});
}
