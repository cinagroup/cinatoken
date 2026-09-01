/**
 * MySQL：关键写路径（Drizzle 事务），供 `storage/critical-write-paths` 调度。
 */
import type { ResultSetHeader } from 'mysql2/promise';
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
import type { MySqlDatabaseClient } from '../../storage/database-client';
import { nowIso, parseMoney } from '../../storage/critical-write-paths-utils';
import { toMySqlDateTime } from './mysql2-compat';
import {
	apiKeysTable as myApiKeysTable,
	apiKeyRequestLogsTable as myRequestLogsTable,
	guardrailBudgetReservationsTable as myGuardrailBudgetReservationsTable,
	guardrailBudgetWindowsTable as myGuardrailBudgetWindowsTable,
	publicModelDailyStatsTable as myPublicModelDailyStatsTable,
	systemConfigTable as mySystemConfigTable,
	userAuditLogsTable as myUserAuditLogsTable,
	userBudgetReservationsTable as myUserBudgetReservationsTable,
	usersTable as myUsersTable,
} from '../../storage/drizzle/schema.mysql';

export async function getUserBudgetSnapshotMy(
	client: MySqlDatabaseClient,
	userId: string
): Promise<{ budgetSpent: number; budgetMax: number | null; budgetPeriod: string | null; budgetResetAt: string | null } | null> {
	const row = await client.drizzle
		.select({
			budgetSpent: myUsersTable.budgetSpent,
			budgetMax: myUsersTable.budgetMax,
			budgetPeriod: myUsersTable.budgetPeriod,
			budgetResetAt: myUsersTable.budgetResetAt,
		})
		.from(myUsersTable)
		.where(eq(myUsersTable.id, userId))
		.limit(1);
	if (!row[0]) return null;
	return {
		budgetSpent: parseMoney(row[0].budgetSpent),
		budgetMax: row[0].budgetMax == null ? null : parseMoney(row[0].budgetMax),
		budgetPeriod: row[0].budgetPeriod,
		budgetResetAt: row[0].budgetResetAt,
	};
}

export async function getSystemConfigValueMy(client: MySqlDatabaseClient, key: string): Promise<string | null> {
	const row = await client.drizzle
		.select({ value: mySystemConfigTable.value })
		.from(mySystemConfigTable)
		.where(eq(mySystemConfigTable.key, key))
		.limit(1);
	return row[0]?.value ?? null;
}

export async function createApiKeyWithAuditMy(
	client: MySqlDatabaseClient,
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
		await tx.insert(myApiKeysTable).values({
			id: params.insert.id,
			key: preparedKey.storageKey,
			keyHash: preparedKey.keyHash,
			keyPreview: preparedKey.keyPreview,
			userId: params.insert.userId,
			workspaceId: params.insert.workspaceId,
			name: params.insert.name ?? null,
			status,
			metadata: params.insert.metadata ?? null,
			expiresAt: params.insert.expiresAt
				? toMySqlDateTime(params.insert.expiresAt)
				: null,
			lastUsedAt: null,
			createdAt: now,
			updatedAt: now,
		});
		await tx.insert(myUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
	});
}

export async function updateUserBudgetWithAuditTxMy(
	client: MySqlDatabaseClient,
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
			budgetEpoch: sql`${myUsersTable.budgetEpoch} + 1`,
			budgetReservedMicros: 0,
			updatedAt: now,
		};
		if (params.budgetMax !== undefined) {
			updateSet.budgetMax = params.budgetMax == null ? null : String(roundGatewayMoney(params.budgetMax));
		}
		const [header] = (await tx
			.update(myUsersTable)
			.set(updateSet)
			.where(
				and(
					eq(myUsersTable.id, params.userId),
					sql`${myUsersTable.budgetMax} <=> ${params.expectedBudgetMax == null
						? null
						: String(roundGatewayMoney(params.expectedBudgetMax))}`,
					eq(myUsersTable.budgetBase, String(roundGatewayMoney(params.expectedBudgetBase))),
					eq(myUsersTable.budgetSpent, String(roundGatewayMoney(params.expectedBudgetSpent))),
					eq(myUsersTable.budgetPeriod, params.expectedBudgetPeriod),
					sql`${myUsersTable.budgetResetAt} <=> ${params.expectedBudgetResetAt}`,
					eq(myUsersTable.budgetEpoch, params.expectedBudgetEpoch),
					eq(myUsersTable.budgetReservedMicros, params.expectedBudgetReservedMicros),
				)
			)) as unknown as [ResultSetHeader, unknown];
		if (!header?.affectedRows) {
			return false;
		}

		await tx.insert(myUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
		return true;
	});
}

export async function applyUserBudgetTransitionWithAuditMy(
	client: MySqlDatabaseClient,
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
			updateSet.budgetEpoch = sql`${myUsersTable.budgetEpoch} + 1`;
			updateSet.budgetReservedMicros = 0;
		}
		if (params.metadata !== undefined) {
			updateSet.metadata = params.metadata;
		}
		const [header] = (await tx
			.update(myUsersTable)
			.set(updateSet)
			.where(and(
				eq(myUsersTable.id, params.userId),
				sql`${myUsersTable.budgetMax} <=> ${params.expectedBudgetMax == null
					? null
					: String(roundGatewayMoney(params.expectedBudgetMax))}`,
				eq(myUsersTable.budgetBase, String(roundGatewayMoney(params.expectedBudgetBase))),
				eq(myUsersTable.budgetSpent, String(roundGatewayMoney(params.expectedBudgetSpent))),
				eq(myUsersTable.budgetPeriod, params.expectedBudgetPeriod),
				sql`${myUsersTable.budgetResetAt} <=> ${params.expectedBudgetResetAt}`,
				eq(myUsersTable.budgetEpoch, params.expectedBudgetEpoch),
				eq(myUsersTable.budgetReservedMicros, params.expectedBudgetReservedMicros),
			))) as unknown as [ResultSetHeader, unknown];
		if (!header?.affectedRows) {
			return;
		}
		updated = true;
		await tx.insert(myUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(params.audit, now));
	});
	return updated;
}

export async function insertRequestUsageAndChargeTxMy(
	client: MySqlDatabaseClient,
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
	const guardrailNow = toMySqlDateTime(now);
	const delta = toPublicModelDailyStatsDelta(params.requestLog, now);
	await client.drizzle.transaction(async (tx) => {
		const requestWorkspaceId = (await tx
			.select({ workspaceId: myApiKeysTable.workspaceId })
			.from(myApiKeysTable)
			.where(eq(myApiKeysTable.id, params.requestLog.apiKeyId))
			.for('update'))[0]?.workspaceId ?? null;
		if (requestWorkspaceId === null || requestWorkspaceId !== params.requestLog.workspaceId) {
			throw new Error('Request log Workspace snapshot does not match API key');
		}
		let ordinarySettlementMicros: number | null = null;
		let ordinaryReservationEpoch: number | null = null;
		if (params.userBudgetSettlement) {
			const settlement = params.userBudgetSettlement;
			const reservations = await tx.select({
				requestId: myUserBudgetReservationsTable.requestId,
				userId: myUserBudgetReservationsTable.userId,
				apiKeyId: myUserBudgetReservationsTable.apiKeyId,
				budgetEpoch: myUserBudgetReservationsTable.budgetEpoch,
				reservedMicros: myUserBudgetReservationsTable.reservedMicros,
				settledMicros: myUserBudgetReservationsTable.settledMicros,
				state: myUserBudgetReservationsTable.state,
			}).from(myUserBudgetReservationsTable)
				.where(eq(myUserBudgetReservationsTable.requestId, settlement.requestId))
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
				id: myRequestLogsTable.id,
				userId: myRequestLogsTable.userId,
				apiKeyId: myRequestLogsTable.apiKeyId,
				workspaceId: myRequestLogsTable.workspaceId,
				chargedCost: myRequestLogsTable.chargedCost,
				budgetChargedMicros: myRequestLogsTable.budgetChargedMicros,
			}).from(myRequestLogsTable)
				.where(eq(myRequestLogsTable.id, params.requestLog.id))
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
				} else if (previousSettledMicros !== ordinarySettlementMicros) {
					const accounts = await tx.select({
						id: myUsersTable.id,
						budgetEpoch: myUsersTable.budgetEpoch,
					}).from(myUsersTable).where(eq(myUsersTable.id, reservation.userId)).for('update');
					const account = accounts[0];
					if (!account) throw new Error('Ordinary-user budget account is missing');
					const reconciliationMicros = ordinarySettlementMicros - previousSettledMicros;
					if (Number(account.budgetEpoch) === reservationEpoch && reconciliationMicros !== 0) {
						const [updated] = (await tx.update(myUsersTable).set({
							budgetSpent: sql`ROUND(GREATEST(${myUsersTable.budgetSpent} + (${reconciliationMicros} / 1000000), 0), 6)`,
							updatedAt: guardrailNow,
						}).where(and(
							eq(myUsersTable.id, reservation.userId),
							eq(myUsersTable.budgetEpoch, reservationEpoch),
						))) as unknown as [ResultSetHeader, unknown];
						if (updated.affectedRows !== 1) throw new Error('Ordinary-user late settlement account changed concurrently');
					}
					const [updated] = (await tx.update(myUserBudgetReservationsTable).set({
						settledMicros: ordinarySettlementMicros,
						terminalReason: settlement.reason.slice(0, 128),
						updatedAt: guardrailNow,
					}).where(and(
						eq(myUserBudgetReservationsTable.requestId, settlement.requestId),
						eq(myUserBudgetReservationsTable.state, 'expired'),
						eq(myUserBudgetReservationsTable.settledMicros, previousSettledMicros),
					))) as unknown as [ResultSetHeader, unknown];
					if (updated.affectedRows !== 1) throw new Error('Ordinary-user late settlement reservation changed concurrently');
				}
			} else if (reservation.state === 'reserved' || reservation.state === 'dispatched') {
				const accounts = await tx.select({
					id: myUsersTable.id,
					budgetEpoch: myUsersTable.budgetEpoch,
					budgetReservedMicros: myUsersTable.budgetReservedMicros,
				}).from(myUsersTable).where(eq(myUsersTable.id, reservation.userId)).for('update');
				const account = accounts[0];
				if (!account) throw new Error('Ordinary-user budget account is missing');
				if (Number(account.budgetEpoch) === reservationEpoch) {
					const currentReservedMicros = Number(account.budgetReservedMicros);
					if (!isSafeUserBudgetMicros(currentReservedMicros) || currentReservedMicros < reservedMicros) {
						throw new Error('Ordinary-user reserved budget counter invariant violated');
					}
					const [updated] = (await tx.update(myUsersTable).set({
						budgetReservedMicros: sql`${myUsersTable.budgetReservedMicros} - ${reservedMicros}`,
						budgetSpent: sql`ROUND(GREATEST(${myUsersTable.budgetSpent} + (${ordinarySettlementMicros} / 1000000), 0), 6)`,
						updatedAt: guardrailNow,
					}).where(and(
						eq(myUsersTable.id, reservation.userId),
						eq(myUsersTable.budgetEpoch, reservationEpoch),
						sql`${myUsersTable.budgetReservedMicros} >= ${reservedMicros}`,
					))) as unknown as [ResultSetHeader, unknown];
					if (updated.affectedRows !== 1) throw new Error('Ordinary-user reserved budget counter invariant violated');
				}
				const [updated] = (await tx.update(myUserBudgetReservationsTable).set({
					state: settlement.mode === 'reserved' ? 'expired' : 'settled',
					settledMicros: ordinarySettlementMicros,
					terminalAt: guardrailNow,
					terminalReason: settlement.reason.slice(0, 128),
					updatedAt: guardrailNow,
				}).where(and(
					eq(myUserBudgetReservationsTable.requestId, settlement.requestId),
					inArray(myUserBudgetReservationsTable.state, ['reserved', 'dispatched']),
				))) as unknown as [ResultSetHeader, unknown];
				if (updated.affectedRows !== 1) throw new Error('Ordinary-user budget settlement reservation changed concurrently');
			} else {
				throw new Error('Ordinary-user budget reservation has an invalid state');
			}
		}
		await tx.insert(myRequestLogsTable).values({
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
			budgetAccountedAt: params.requestLog.budgetAccountedAt
				? toMySqlDateTime(params.requestLog.budgetAccountedAt)
				: null,
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
			responseStreamed: params.requestLog.responseStreamed == null
				? null
				: Number(params.requestLog.responseStreamed),
			dataRegion: params.requestLog.dataRegion ?? null,
			isByok: params.requestLog.isByok == null ? null : Number(params.requestLog.isByok),
			chargedCostUsd: params.requestLog.chargedCostUsd == null
				? null
				: String(roundGatewayMoney(params.requestLog.chargedCostUsd)),
			upstreamInferenceCostUsd: params.requestLog.upstreamInferenceCostUsd == null
				? null
				: String(roundGatewayMoney(params.requestLog.upstreamInferenceCostUsd)),
			createdAt: now,
		});
		await tx
			.insert(myPublicModelDailyStatsTable)
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
			.onDuplicateKeyUpdate({
				set: {
					requestCount: sql`${myPublicModelDailyStatsTable.requestCount} + VALUES(request_count)`,
					successCount: sql`${myPublicModelDailyStatsTable.successCount} + VALUES(success_count)`,
					errorCount: sql`${myPublicModelDailyStatsTable.errorCount} + VALUES(error_count)`,
					outputTokens: sql`${myPublicModelDailyStatsTable.outputTokens} + VALUES(output_tokens)`,
					latencyTotalMs: sql`${myPublicModelDailyStatsTable.latencyTotalMs} + VALUES(latency_total_ms)`,
					latencySampleCount: sql`${myPublicModelDailyStatsTable.latencySampleCount} + VALUES(latency_sample_count)`,
					updatedAt: now,
				},
			});
		if (!params.userBudgetSettlement && params.shouldChargeBudget) {
			await tx
				.update(myUsersTable)
				.set({
					budgetSpent: sql`${myUsersTable.budgetSpent} + ${String(charged)}`,
					updatedAt: now,
				})
				.where(eq(myUsersTable.id, params.userId));
		}
		if (params.userBudgetSettlement || params.shouldChargeBudget) {
			const auditedCharge = params.userBudgetSettlement
				? userBudgetAmount(ordinarySettlementMicros ?? 0)
				: charged;
			const afterSpent = roundGatewayMoney(params.beforeSpent + auditedCharge);
			let auditParams = params.audit;
			if (params.userBudgetSettlement && ordinaryReservationEpoch !== null) {
				const accounts = await tx.select({
					budgetEpoch: myUsersTable.budgetEpoch,
				}).from(myUsersTable)
					.where(eq(myUsersTable.id, params.userId))
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
			await tx.insert(myUserAuditLogsTable).values(toUserAuditLogDrizzleInsert(auditRow, now));
		}
		if (params.guardrailBudgetSettlement) {
			const settlement = params.guardrailBudgetSettlement;
			const reservations = await tx.select({
				id: myGuardrailBudgetReservationsTable.id,
				workspaceId: myGuardrailBudgetReservationsTable.workspaceId,
				scopeType: myGuardrailBudgetReservationsTable.scopeType,
				scopeId: myGuardrailBudgetReservationsTable.scopeId,
				period: myGuardrailBudgetReservationsTable.period,
				periodStart: myGuardrailBudgetReservationsTable.periodStart,
				reservedMicros: myGuardrailBudgetReservationsTable.reservedMicros,
				settledMicros: myGuardrailBudgetReservationsTable.settledMicros,
				state: myGuardrailBudgetReservationsTable.state,
			}).from(myGuardrailBudgetReservationsTable).where(and(
				eq(myGuardrailBudgetReservationsTable.requestId, settlement.requestId),
				inArray(myGuardrailBudgetReservationsTable.state, ['reserved', 'dispatched', 'expired', 'released']),
			)).for('update');
			if (reservations.length === 0) {
				throw new Error('Guardrail budget settlement has no matching reservation');
			}
			if (requestWorkspaceId == null
				|| reservations.some((reservation) => reservation.workspaceId !== requestWorkspaceId)) {
				throw new Error('Guardrail budget settlement Workspace identity mismatch');
			}
			const orderedReservations = [...reservations].sort((left, right) =>
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
			for (const reservation of orderedReservations) {
				if (reservation.state === 'released') continue;
				if (reservation.state === 'expired') {
					if (settlement.mode !== 'actual') continue;
					const previousSettledMicros = Number(reservation.settledMicros);
					if (budgetChargedMicros <= previousSettledMicros) continue;
					const lateActualDeltaMicros = budgetChargedMicros - previousSettledMicros;
					const [reservationUpdate] = (await tx.update(myGuardrailBudgetReservationsTable).set({
						settledMicros: budgetChargedMicros,
						terminalReason: 'late_actual_overrun',
						updatedAt: guardrailNow,
					}).where(and(
						eq(myGuardrailBudgetReservationsTable.id, reservation.id),
						eq(myGuardrailBudgetReservationsTable.state, 'expired'),
					))) as unknown as [ResultSetHeader, unknown];
					if (reservationUpdate.affectedRows !== 1) throw new Error('Guardrail budget late settlement reservation changed concurrently');
					const [windowUpdate] = (await tx.update(myGuardrailBudgetWindowsTable).set({
						settledMicros: sql`${myGuardrailBudgetWindowsTable.settledMicros} + ${lateActualDeltaMicros}`,
						updatedAt: guardrailNow,
					}).where(and(
						eq(myGuardrailBudgetWindowsTable.workspaceId, reservation.workspaceId),
						eq(myGuardrailBudgetWindowsTable.scopeType, reservation.scopeType),
						eq(myGuardrailBudgetWindowsTable.scopeId, reservation.scopeId),
						eq(myGuardrailBudgetWindowsTable.period, reservation.period),
						eq(myGuardrailBudgetWindowsTable.periodStart, reservation.periodStart),
					))) as unknown as [ResultSetHeader, unknown];
					if (windowUpdate.affectedRows !== 1) throw new Error('Guardrail budget late settlement window is missing');
					console.warn('[guardrail-budget] reconciled late actual usage above an expired reservation', {
						requestId: settlement.requestId,
						reservationId: reservation.id,
						lateActualDeltaMicros,
					});
					continue;
				}
				const settledMicros = settlement.mode === 'reserved'
					? Number(reservation.reservedMicros)
					: budgetChargedMicros;
				const [reservationUpdate] = (await tx.update(myGuardrailBudgetReservationsTable).set({
					state: settlement.mode === 'reserved' ? 'expired' : 'settled',
					settledMicros,
					terminalAt: guardrailNow,
					terminalReason: settlement.reason.slice(0, 128),
					updatedAt: guardrailNow,
				}).where(and(
					eq(myGuardrailBudgetReservationsTable.id, reservation.id),
					inArray(myGuardrailBudgetReservationsTable.state, ['reserved', 'dispatched']),
				))) as unknown as [ResultSetHeader, unknown];
				if (reservationUpdate.affectedRows !== 1) throw new Error('Guardrail budget settlement reservation changed concurrently');
				const [windowUpdate] = (await tx.update(myGuardrailBudgetWindowsTable).set({
					reservedMicros: sql`${myGuardrailBudgetWindowsTable.reservedMicros} - ${reservation.reservedMicros}`,
					settledMicros: sql`${myGuardrailBudgetWindowsTable.settledMicros} + ${settledMicros}`,
					updatedAt: guardrailNow,
				}).where(and(
					eq(myGuardrailBudgetWindowsTable.workspaceId, reservation.workspaceId),
					eq(myGuardrailBudgetWindowsTable.scopeType, reservation.scopeType),
					eq(myGuardrailBudgetWindowsTable.scopeId, reservation.scopeId),
					eq(myGuardrailBudgetWindowsTable.period, reservation.period),
					eq(myGuardrailBudgetWindowsTable.periodStart, reservation.periodStart),
				))) as unknown as [ResultSetHeader, unknown];
				if (windowUpdate.affectedRows !== 1) throw new Error('Guardrail budget settlement window is missing');
			}
		}
		if (budgetChargedMicros > 0 && requestWorkspaceId != null) {
			const budgetAccountedAt = params.requestLog.budgetAccountedAt
				? toMySqlDateTime(params.requestLog.budgetAccountedAt)
				: guardrailNow;
			await tx.execute(sql`UPDATE guardrail_budget_windows AS w
				SET unreserved_micros = w.unreserved_micros + ${budgetChargedMicros},
					updated_at = ${guardrailNow}
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
