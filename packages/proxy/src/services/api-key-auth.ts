/**
 * 用户密钥鉴权：校验 Bearer sk-，并在读库时触发与 `user-service.maybeResetBudget` 一致的预算周期重置写回。
 */
import type { GatewayRepositories } from '@octafuse/core';
import {
	MANAGEMENT_API_KEY_PREFIX,
	persistLazyBudgetResetIfNeeded,
	resolveMeMetadata,
	roundGatewayMoney,
} from '@octafuse/core';

/** 鉴权成功后注入上下文（与中间件 `ApiKeyContext` 字段对应）。 */
export type AuthenticatedApiKey = {
	/** `api_keys.id` */
	keyId: string;
	userId: string;
	workspaceId: string;
	userEmail: string | null;
	/** 周期内允许消耗上限；null 表示不按上限拦截（与路由逻辑配合） */
	budgetMax: number | null;
	/** 当前周期已计入的消耗（可能已懒重置） */
	budgetSpent: number;
	/** 单调预算周期世代；预留准入与结算均以此隔离。 */
	budgetEpoch: number;
	budgetPeriod: string;
	budgetResetAt: string | null;
	metadata: Record<string, unknown> | null;
	/** `users.charged_cost_factors` JSON；无折扣时为 null */
	chargedCostFactors: string | null;
};

/**
 * 校验 sk 是否存在且 active；若预算周期已到期则在此函数内写回数据库。
 * @param repos 网关仓储（D1 或 Postgres）
 * @param key 完整明文密钥（不含 `Bearer ` 前缀）
 * @returns 无效或吊销则 `null`
 */
export async function authenticateApiKey(repos: GatewayRepositories, key: string): Promise<AuthenticatedApiKey | null> {
	// Credential namespaces are authoritative. Even a malformed/imported
	// api_keys row must never turn a Management secret into an inference key.
	if (key.startsWith(MANAGEMENT_API_KEY_PREFIX)) return null;
	const row = await repos.apiKeys.getApiKeyWithUserByKey(key);
	if (!row) return null;

	const {
		budget_spent: nextSpent,
		budget_reset_at: nextReset,
		budget_max: nextMax,
		budget_epoch: nextEpoch,
	} =
		await persistLazyBudgetResetIfNeeded(repos, {
			budgetRow: row,
			userId: row.user_id,
			expectedBudgetResetAt: row.budget_reset_at,
			apiKeyId: row.id,
			kind: 'api_key_auth',
		});

	const metadata = resolveMeMetadata(row.user_metadata, row.metadata);

	return {
		keyId: row.id,
		userId: row.user_id,
		workspaceId: row.workspace_id,
		userEmail: row.user_email,
		budgetMax: nextMax == null ? null : roundGatewayMoney(nextMax),
		budgetSpent: roundGatewayMoney(nextSpent),
		budgetEpoch: nextEpoch,
		budgetPeriod: row.budget_period,
		budgetResetAt: nextReset,
		metadata,
		chargedCostFactors: row.user_charged_cost_factors ?? null,
	};
}
