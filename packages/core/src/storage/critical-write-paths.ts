import type { D1Database } from '@cloudflare/workers-types';
import type { InsertUserBudgetAuditLogParams } from '../db/user-budget-audit-params';
import type { InsertKeyParams } from '../db/api-keys-types';
import type { InsertRequestLogParams } from '../db/request-logs-types';
import {
	createApiKeyWithAuditD1,
	getSystemConfigValueD1,
	getUserBudgetSnapshotD1,
	insertRequestUsageAndChargeTxD1,
	updateUserBudgetWithAuditTxD1,
	applyUserBudgetTransitionWithAuditD1,
} from '../db/d1/critical-writes.impl';
import {
	createApiKeyWithAuditMy,
	getSystemConfigValueMy,
	getUserBudgetSnapshotMy,
	insertRequestUsageAndChargeTxMy,
	updateUserBudgetWithAuditTxMy,
	applyUserBudgetTransitionWithAuditMy,
} from '../db/mysql/critical-writes.impl';
import {
	createApiKeyWithAuditPg,
	getSystemConfigValuePg,
	getUserBudgetSnapshotPg,
	insertRequestUsageAndChargeTxPg,
	updateUserBudgetWithAuditTxPg,
	applyUserBudgetTransitionWithAuditPg,
} from '../db/postgres/critical-writes.impl';
import type { GatewayDatabaseClient } from './database-client';
import { createD1DatabaseClient } from './database-client';
import type { InsertUserAuditLogParams } from '../db/user-audit-logs-types';
import type { GuardrailBudgetSettlement } from '../db/guardrail-budget-types';
import type { UserBudgetSettlement } from '../db/user-budget-reservation-types';
import type { GatewayRepositories } from './repositories';

export type StorageRef = D1Database | GatewayDatabaseClient | GatewayRepositories;

export function resolveDatabaseClient(storage: StorageRef): GatewayDatabaseClient {
	if ('driver' in storage) {
		return storage;
	}
	if ('client' in storage) {
		return (storage as GatewayRepositories).client;
	}
	return createD1DatabaseClient(storage as D1Database);
}

export async function getUserBudgetSnapshot(
	storage: StorageRef,
	userId: string
): Promise<{ budgetSpent: number; budgetMax: number | null; budgetPeriod: string | null; budgetResetAt: string | null } | null> {
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		return getUserBudgetSnapshotD1(client, userId);
	}
	if (client.driver === 'mysql') {
		return getUserBudgetSnapshotMy(client, userId);
	}
	return getUserBudgetSnapshotPg(client, userId);
}

export async function getSystemConfigValue(storage: StorageRef, key: string): Promise<string | null> {
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		return getSystemConfigValueD1(client, key);
	}
	if (client.driver === 'mysql') {
		return getSystemConfigValueMy(client, key);
	}
	return getSystemConfigValuePg(client, key);
}

export async function createApiKeyWithAudit(
	storage: StorageRef,
	params: {
		insert: InsertKeyParams;
		audit: InsertUserBudgetAuditLogParams;
	}
): Promise<void> {
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		await createApiKeyWithAuditD1(client, params);
		return;
	}
	if (client.driver === 'mysql') {
		await createApiKeyWithAuditMy(client, params);
		return;
	}
	await createApiKeyWithAuditPg(client, params);
}

/**
 * 条件更新 `users` 预算字段并写 `user_audit_logs`。
 * 三种驱动均以读取时的完整预算计算输入做 CAS；获胜者在同一事务中开启新 epoch、清零预留计数并写审计。
 */
export async function updateUserBudgetWithAuditTx(
	storage: StorageRef,
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
		/** 触发本次写回的密钥（若有），写入审计 `api_key_id` */
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
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		return updateUserBudgetWithAuditTxD1(client, params);
	}
	if (client.driver === 'mysql') {
		return updateUserBudgetWithAuditTxMy(client, params);
	}
	return updateUserBudgetWithAuditTxPg(client, params);
}

export async function insertRequestUsageAndChargeTx(
	storage: StorageRef,
	params: {
		requestLog: InsertRequestLogParams;
		shouldChargeBudget: boolean;
		/** `users.id`，与 `requestLog.userId` 一致 */
		userId: string;
		beforeSpent: number;
		chargedCost: number;
		guardrailBudgetSettlement?: GuardrailBudgetSettlement;
		userBudgetSettlement?: UserBudgetSettlement;
		audit: Omit<InsertUserBudgetAuditLogParams, 'id' | 'afterSpent' | 'deltaSpent'>;
	}
): Promise<void> {
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		await insertRequestUsageAndChargeTxD1(client, params);
		return;
	}
	if (client.driver === 'mysql') {
		await insertRequestUsageAndChargeTxMy(client, params);
		return;
	}
	await insertRequestUsageAndChargeTxPg(client, params);
}

/** 原子写入预算转换结果并插入审计（Admin budget transition）。 */
export async function applyUserBudgetTransitionWithAuditTx(
	storage: StorageRef,
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
		/** True only when this transition starts a new budget accounting generation. */
		resetEpoch: boolean;
		metadata?: string | null;
		audit: InsertUserAuditLogParams;
	}
): Promise<boolean> {
	if (!Number.isSafeInteger(params.expectedBudgetEpoch) || params.expectedBudgetEpoch < 0
		|| !Number.isSafeInteger(params.expectedBudgetReservedMicros) || params.expectedBudgetReservedMicros < 0
		|| !Number.isFinite(params.expectedBudgetBase) || params.expectedBudgetBase < 0
		|| !Number.isFinite(params.expectedBudgetSpent) || params.expectedBudgetSpent < 0
		|| (params.expectedBudgetMax !== null
			&& (!Number.isFinite(params.expectedBudgetMax) || params.expectedBudgetMax < 0))
		|| !Number.isFinite(params.budgetBase) || params.budgetBase < 0
		|| !Number.isFinite(params.budgetSpent) || params.budgetSpent < 0
		|| (params.budgetMax !== null && (!Number.isFinite(params.budgetMax) || params.budgetMax < 0))) {
		throw new Error('Invalid ordinary-user budget transition accounting values');
	}
	const client = resolveDatabaseClient(storage);
	if (client.driver === 'd1') {
		return applyUserBudgetTransitionWithAuditD1(client, params);
	}
	if (client.driver === 'mysql') {
		return applyUserBudgetTransitionWithAuditMy(client, params);
	}
	return applyUserBudgetTransitionWithAuditPg(client, params);
}
