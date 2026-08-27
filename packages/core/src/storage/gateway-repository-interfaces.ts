import type {
	GlobalUserAuditLogRow,
	ModelRow,
	ModelRouteRow,
	ProviderRow,
	RequestLogRow,
	ResolvedGatewayKeyRow,
	UserAuditLogRow,
	UserRow,
	ApiKeyRow,
} from '../types';
import type { InsertUserAuditLogParams } from '../db/user-audit-logs-types';
import type { BudgetFilter, InsertKeyParams } from '../db/api-keys-types';
import type { InsertUserParams, UserMaxBudgetFilter } from '../db/users-types';
import type { ApiKeyListSortField, ApiKeyListSortOrder } from '../db/api-keys-list-sort';
import type { UserListSortField, UserListSortOrder } from '../db/users-list-sort';
import type { ProviderProtocolBases } from '../db/providers-types';
import type { SystemConfigRow } from '../db/system-config-types';
import type {
	AdminApiKeyListItem,
	EntityCountSnapshot,
	ModelAnalyticsRow,
	PublicModelAnalyticsRow,
	ModelProviderReliabilityRow,
	ModelRouteDetailRow,
	ModelRouteJoinRow,
	ModelWithRouteCountsRow,
	ProviderAdminRow,
	ProviderAnalyticsRow,
	ProviderReliabilityRow,
	RequestStatsByRangeRow,
	RequestTimeseriesRow,
	ThroughputSnapshot,
	UserAnalyticsRow,
	UserTokenTimeseriesRow,
} from './repository-dtos';
import type { ResolvedModelSurfaceRow } from '../route-topology';
import type {
	RoutePoolStickyBindingRow,
	RoutePoolStickyBindingTargetCount,
} from '../db/route-pool-sticky-types';
import type {
	AdminApiKeyRow,
	AdminSessionRow,
	InsertAdminApiKeyParams,
} from '../db/admin-access-types';
import type {
	InsertNftMintParams,
	InsertSharedKeyEarningParams,
	InsertSharedKeyParams,
	InsertWithdrawalParams,
	NftMintRow,
	PortalSessionRow,
	SharedKeyEarningRow,
	SharedKeyRow,
	UpdateSharedKeyPatch,
	UserEarningsRow,
	WithdrawalRow,
} from '../db/shared-keys-types';

export interface AdminAccessRepository {
	listApiKeys(): Promise<AdminApiKeyRow[]>;
	getApiKeyById(id: string): Promise<AdminApiKeyRow | null>;
	getActiveApiKeyBySecret(secretKey: string): Promise<AdminApiKeyRow | null>;
	insertApiKey(params: InsertAdminApiKeyParams): Promise<void>;
	updateApiKey(
		id: string,
		patch: {
			name?: string;
			description?: string | null;
			permissionsJson?: string;
			secretKey?: string;
			keyPrefix?: string;
			status?: 'active' | 'revoked';
			revokedAt?: string | null;
		}
	): Promise<boolean>;
	rotateApiKey(id: string, secretKey: string, keyPrefix: string): Promise<boolean>;
	revokeApiKey(id: string): Promise<boolean>;
	touchApiKey(id: string): Promise<void>;
	insertSession(session: AdminSessionRow): Promise<void>;
	getValidSession(tokenHash: string, nowIso: string): Promise<AdminSessionRow | null>;
	deleteSession(tokenHash: string): Promise<void>;
	deleteExpiredSessions(nowIso: string): Promise<void>;
}

/** 管理端分析聚合 */
export interface AdminAnalyticsRepository {
	queryModelAnalytics(options: { start: string; end: string; tag?: string; providerId?: string; userEmail?: string }): Promise<ModelAnalyticsRow[]>;
	/** 公开排行专用：只读按日、按模型预聚合表，禁止回退扫描原始请求日志。 */
	queryPublicModelAnalytics(options: { startDate: string; endDate: string }): Promise<PublicModelAnalyticsRow[]>;
	queryDistinctModelTags(): Promise<string[]>;
	queryUserAnalytics(options: { start: string; end: string; email?: string }): Promise<UserAnalyticsRow[]>;
	queryProviderAnalytics(options: { start: string; end: string; tag?: string; modelId?: string; routeGroup?: string }): Promise<ProviderAnalyticsRow[]>;
	queryProviderReliability(options: { start: string; end: string }): Promise<ProviderReliabilityRow[]>;
	queryModelProviderReliability(options: { start: string; end: string }): Promise<ModelProviderReliabilityRow[]>;
}

export interface UserAuditLogsRepository {
	insertUserAuditLog(params: InsertUserAuditLogParams): Promise<void>;
	getUserAuditLogsByUserId(
		userId: string,
		page: number,
		pageSize: number
	): Promise<{ logs: UserAuditLogRow[]; total: number }>;
	getGlobalUserAuditLogs(options: {
		page?: number;
		pageSize?: number;
		userId?: string;
		apiKeyId?: string;
		userEmail?: string;
		eventTypes?: string[];
		actorTypes?: string[];
		/** 精确匹配完整 `actor_id`，如 `console:admin`、`admin_key:<uuid>`。 */
		actorId?: string;
		/** 按 `actor_id` 的身份前缀过滤（`console` / `admin_key` / `system` / …），多值取并集。 */
		actorKinds?: string[];
		reasonCodes?: string[];
		sources?: string[];
		correlationId?: string;
		startDate?: string;
		endDate?: string;
	}): Promise<{ logs: GlobalUserAuditLogRow[]; total: number }>;
	getGlobalUserAuditLogFilterOptions(): Promise<{ reasonCodes: string[] }>;
}

export interface ApiKeysRepository {
	getApiKeyByKey(key: string): Promise<ApiKeyRow | null>;
	getApiKeyByKeyAnyStatus(key: string): Promise<ApiKeyRow | null>;
	getApiKeyById(id: string): Promise<ApiKeyRow | null>;
	getApiKeyWithUserByKey(key: string): Promise<ResolvedGatewayKeyRow | null>;
	getApiKeyWithUserById(id: string): Promise<ResolvedGatewayKeyRow | null>;
	listKeysByUserId(userId: string, options?: { status?: string }): Promise<ApiKeyRow[]>;
	insertApiKey(params: InsertKeyParams): Promise<void>;
	revokeApiKey(id: string): Promise<boolean>;
	deleteApiKeyHard(id: string, secretKey: string): Promise<boolean>;
	updateApiKeyStatusById(id: string, status: string): Promise<boolean>;
	setApiKeyMetadataById(id: string, metadataJson: string | null): Promise<boolean>;
	/** Idempotent online migration: replace legacy plaintext bearer values with hash references. */
	scrubLegacyApiKeySecrets(limit?: number): Promise<{ scrubbed: number; remaining: number }>;
	updateApiKeyName(id: string, name: string | null): Promise<boolean>;
	getAllApiKeys(options?: {
		email?: string;
		userId?: string;
		maxBudget?: BudgetFilter;
		page?: number;
		pageSize?: number;
		sort?: ApiKeyListSortField;
		order?: ApiKeyListSortOrder;
	}): Promise<{ keys: AdminApiKeyListItem[]; total: number }>;
	getActiveApiKeysCount(): Promise<number>;
	getApiKeysCount(): Promise<EntityCountSnapshot>;
}

export interface UsersRepository {
	getById(id: string): Promise<UserRow | null>;
	getByExternalPair(externalSystem: string, externalUserId: string): Promise<UserRow | null>;
	listByEmail(email: string): Promise<UserRow[]>;
	list(options?: {
		email?: string;
		externalSystem?: string;
		externalUserId?: string;
		maxBudget?: UserMaxBudgetFilter;
		status?: string;
		page?: number;
		pageSize?: number;
		sort?: UserListSortField;
		order?: UserListSortOrder;
	}): Promise<{ users: UserRow[]; total: number }>;
	createUser(params: InsertUserParams): Promise<void>;
	updateUserPlan(
		id: string,
		budget_max: number | null,
		budget_period: string,
		budget_reset_at: string | null,
		resetBudget?: boolean,
		metadata?: string | null,
		budget_spent_override?: number | null,
		budget_base?: number | null
	): Promise<boolean>;
	updateUserStatus(id: string, status: string): Promise<boolean>;
	setUserMetadataById(id: string, metadataJson: string | null): Promise<boolean>;
	setUserChargedCostFactorsById(id: string, chargedCostFactorsJson: string | null): Promise<boolean>;
	setUserEmailById(id: string, email: string): Promise<boolean>;
	/**
	 * 同时更新一对 external 身份。两者要么都为非空字符串，要么都为 null
	 * （由调用方校验；底层依赖 `users_external_pair_chk` 兜底）。
	 */
	setUserExternalIdentityById(
		id: string,
		externalSystem: string | null,
		externalUserId: string | null
	): Promise<boolean>;
	deleteUserHard(id: string): Promise<boolean>;
	getUsersCount(): Promise<EntityCountSnapshot>;
}

/** 模型列表页、标签、级联删除（models + model_tags + model_routes） */
export interface ModelsRepository {
	listModelsWithRouteCounts(): Promise<ModelWithRouteCountsRow[]>;
	getModelDetailWithRouteCounts(id: string): Promise<ModelWithRouteCountsRow | null>;
	insertModel(params: {
		id: string;
		displayName: unknown;
		vendor: string;
		contextWindow: unknown;
		maxTokens: unknown;
		pricingProfile?: unknown;
		description: unknown;
		metadata: unknown;
		inputModalities?: unknown;
		outputModalities?: unknown;
		releasedAt?: unknown;
	}): Promise<void>;
	replaceModelTags(modelId: string, tags: string[]): Promise<void>;
	updateModelByPatch(id: string, rest: Record<string, unknown>): Promise<number>;
	deleteModelCascade(id: string): Promise<number>;
}

/** 推理路径：模型行（含 tags）、活跃路由列表、按 modelId 取路由 */
export interface ModelRoutingRepository {
	getModelById(id: string): Promise<ModelRow | null>;
	listModelsWithActiveRoutes(): Promise<ModelRow[]>;
	getModelRoutesByModelId(modelId: string): Promise<ModelRouteRow[]>;
	resolveModelSurface(params: {
		modelId: string;
		routeGroup: string;
		requestProtocol: string;
		requestOperation: string;
	}): Promise<ResolvedModelSurfaceRow | null>;
	getModelRoutesByPoolId(poolId: string): Promise<ModelRouteRow[]>;
}

export interface ModelRoutesRepository {
	listModelRoutesWithJoins(filters: { modelId?: string; providerId?: string }): Promise<ModelRouteJoinRow[]>;
	insertModelRoute(params: {
		id: string;
		modelId: string;
		providerId: string;
		providerModelName: string;
		priority: number;
		status: string;
		routeGroup: string;
		weight?: number;
		priceOverride: unknown;
		customParams: string | null;
		upstreamProtocol: string;
		routePoolId: string;
		upstreamOperation: string;
		adapter: string;
	}): Promise<void>;
	getModelRouteRowById(id: string): Promise<ModelRouteDetailRow | null>;
	ensureModelSurfacePool(params: {
		poolId: string;
		surfaceId: string;
		modelId: string;
		routeGroup: string;
		requestProtocol: string;
		requestOperation: string;
		poolName: string;
	}): Promise<{ poolId: string; surfaceId: string }>;
	/**
	 * Patch pool-level routing policy. Only provided fields are updated.
	 * Pass `null` for strategy/tierStrategies to clear (inherit).
	 * Sticky fields: providing any sticky* field bumps `sticky_epoch`.
	 */
	updateRoutePoolPolicy(
		poolId: string,
		patch: {
			strategy?: string | null;
			tierStrategies?: string | null;
			stickyEnabled?: boolean;
			stickyIdleTtlSeconds?: number;
		}
	): Promise<number>;
	/**
	 * Atomically bump `sticky_epoch` (invalidates all bindings for this pool).
	 * Returns new epoch, or null when pool not found.
	 */
	bumpRoutePoolStickyEpoch(poolId: string): Promise<number | null>;
	updateModelRouteByPatch(id: string, patch: Record<string, unknown>): Promise<number>;
	deleteModelRouteById(id: string): Promise<number>;
	/** Delete pool (and its surfaces) only when it has no model_routes targets. */
	deleteRoutePoolIfEmpty(poolId: string): Promise<boolean>;
}

/** Shared Provider sticky bindings (cross-isolate / cross-instance). */
export interface RoutePoolStickyBindingsRepository {
	getBinding(routePoolId: string, affinityHash: string): Promise<RoutePoolStickyBindingRow | null>;
	/**
	 * Insert binding, or replace when existing row is expired, epoch-mismatched,
	 * or matches `expectedToken` (stale but still-valid row, e.g. invalid_target).
	 * Returns true when this write won.
	 */
	tryBind(params: {
		routePoolId: string;
		affinityHash: string;
		routeTargetId: string;
		bindingToken: string;
		poolEpoch: number;
		expiresAt: string;
		nowIso: string;
		/** When set, also allow overwrite of a still-valid row with this token. */
		expectedToken?: string | null;
	}): Promise<boolean>;
	/** Sliding TTL renew; CAS on binding_token. Returns true when updated. */
	touchBinding(params: {
		routePoolId: string;
		affinityHash: string;
		expectedToken: string;
		expiresAt: string;
		nowIso: string;
	}): Promise<boolean>;
	/** Clear sticky binding; CAS on binding_token. Returns true when deleted. */
	clearBinding(params: {
		routePoolId: string;
		affinityHash: string;
		expectedToken: string;
	}): Promise<boolean>;
	/**
	 * Admin force-clear: delete by (pool, hash) without token CAS.
	 * Returns true when a row was deleted.
	 */
	forceClearBinding(params: {
		routePoolId: string;
		affinityHash: string;
	}): Promise<boolean>;
	/**
	 * Active binding counts per target: epoch matches pool.sticky_epoch and not expired.
	 */
	listBindingTargetCounts(
		routePoolId: string,
		nowIso: string
	): Promise<RoutePoolStickyBindingTargetCount[]>;
	/** Rows that are expired or epoch-mismatched (GC debt). */
	countStaleBindings(routePoolId: string, nowIso: string): Promise<number>;
	/** Best-effort table hygiene; not required for correctness. */
	deleteStaleBefore(cutoffIso: string, limit: number): Promise<number>;
}

export interface ProvidersRepository {
	listProviders(): Promise<ProviderAdminRow[]>;
	providerIdExists(id: string): Promise<boolean>;
	insertProvider(params: {
		id: string;
		name: string;
		/** `providers.endpoints` JSON 文本 */
		endpoints: string | null;
		description: unknown;
		apiKey?: string;
		status?: string;
		/** 非空 = 接受用户共享密钥池注入的官方渠道。 */
		sharedChannelType?: string | null;
	}): Promise<void>;
	updateProviderByPatch(id: string, body: Record<string, unknown>): Promise<number>;
	deleteProviderById(id: string): Promise<number>;
	getProviderById(id: string): Promise<ProviderRow | null>;
	getProviderRowById(id: string): Promise<ProviderAdminRow | null>;
	getProviderProtocolBases(providerId: string): Promise<ProviderProtocolBases | null>;
	/** 读取 providers.api_key 明文（仅服务端推理/管理用）。 */
	getProviderApiKeyPlaintext(providerId: string): Promise<{ api_key: string } | null>;
}

/** Filters for {@link RequestLogsRepository.getRequestLogsByKeyId}. If `includeStatuses` is non-empty after whitelist, use `status IN (...)`; else if `excludeStatus` is set, use `(status IS NULL OR status != ?)`; else no status predicate. */
export type RequestLogsByKeyIdFilter = {
	excludeStatus?: string;
	includeStatuses?: string[];
};

export interface RequestLogsRepository {
	getRequestLogsByKeyId(
		apiKeyId: string,
		page: number,
		pageSize: number,
		filter?: RequestLogsByKeyIdFilter
	): Promise<{ logs: RequestLogRow[]; total: number }>;
	getRequestLogs(options: {
		page?: number;
		pageSize?: number;
		apiKeyId?: string;
		userId?: string;
		userEmail?: string;
		modelId?: string;
		providerId?: string;
		routeGroup?: string;
		protocol?: string;
		status?: string;
		startDate?: string;
		endDate?: string;
	}): Promise<{ logs: RequestLogRow[]; total: number }>;
	getRequestStatsByRange(options: {
		startDate: string;
		endDate: string;
		endExclusive?: boolean;
	}): Promise<RequestStatsByRangeRow>;
	queryRequestTimeseries(options: {
		startDate: string;
		endDate: string;
		granularity: 'hour' | 'day';
	}): Promise<RequestTimeseriesRow[]>;
	queryUserTokenTimeseries(options: {
		startDate: string;
		endDate: string;
		granularity: 'hour' | 'day';
		userEmails: string[];
	}): Promise<UserTokenTimeseriesRow[]>;
	getThroughputLastMinute(): Promise<ThroughputSnapshot>;
	getRecentLogs(limit: number): Promise<RequestLogRow[]>;
	getRecentErrors(limit: number): Promise<RequestLogRow[]>;
	getDistinctActiveUsersCount(options: { startDate: string; endDate: string; endExclusive?: boolean }): Promise<number>;
}

export interface SystemConfigRepository {
	listSystemConfigRows(): Promise<SystemConfigRow[]>;
	upsertSystemConfigValue(key: string, value: string): Promise<void>;
	getConfig(key: string): Promise<string | null>;
	getAllConfig(): Promise<Record<string, string>>;
}

/** 用户门户会话（`user_session` Cookie）。 */
export interface PortalAccessRepository {
	insertSession(session: PortalSessionRow): Promise<void>;
	getValidSession(tokenHash: string, nowIso: string): Promise<PortalSessionRow | null>;
	deleteSession(tokenHash: string): Promise<void>;
	deleteExpiredSessions(nowIso: string): Promise<void>;
}

/** 卖家共享密钥（上架/调度/停用）。 */
export interface SharedKeysRepository {
	insertSharedKey(params: InsertSharedKeyParams): Promise<void>;
	getSharedKeyById(id: string): Promise<SharedKeyRow | null>;
	listSharedKeysBySeller(sellerUserId: string): Promise<SharedKeyRow[]>;
	listAllSharedKeys(options?: { status?: string; channelType?: string }): Promise<SharedKeyRow[]>;
	/** 调度候选：指定渠道全部 active key，已按固定顺序排好（seller_priority DESC → weight DESC → id ASC）。 */
	listActiveSharedKeysByChannel(channelType: string): Promise<SharedKeyRow[]>;
	updateSharedKey(id: string, patch: UpdateSharedKeyPatch): Promise<boolean>;
	/** Internal encryption migration/write path; never exposed to an HTTP route. */
	replaceSharedKeySecret?(id: string, protectedSecret: string): Promise<boolean>;
	/** 上游 401/403 或校验失败：置 invalid 并记录原因。 */
	markSharedKeyFailure(id: string, reason: string, nowIso: string): Promise<void>;
	deleteSharedKey(id: string): Promise<boolean>;
	/** 收益入账后累计使用统计（与收益事务同批执行）。 */
	addSharedKeyUsage(id: string, inputTokens: number, outputTokens: number, netAmount: number, nowIso: string): Promise<void>;
}

/** 门户账本：卖家收益、余额、提现、NFT 铸造。 */
export interface PortalLedgerRepository {
	getUserEarnings(userId: string): Promise<UserEarningsRow | null>;
	/** 幂等建立 1:1 账本行（首次登录/首次上架时调用）。 */
	ensureUserEarnings(userId: string): Promise<void>;
	updateWallet(userId: string, walletAddress: string | null, verifiedAtIso: string | null): Promise<void>;
	/** 幂等插入收益流水；重复 `request_log_id` 返回 false。 */
	insertEarning(params: InsertSharedKeyEarningParams): Promise<boolean>;
	/**
	 * 幂等写入收益流水并在同一数据库事务中增加卖家余额。
	 * 重复 `request_log_id` 不得再次入账。
	 */
	recordEarningAndCredit(params: InsertSharedKeyEarningParams): Promise<boolean>;
	/** 收益入账：balance/contribution_value/lifetime_earned 增加 net（与请求计费同批/独立事务均可）。 */
	creditEarningBalance(sellerUserId: string, netAmount: number, nowIso: string): Promise<void>;
	listEarningsBySeller(sellerUserId: string, page: number, pageSize: number): Promise<{ rows: SharedKeyEarningRow[]; total: number }>;
	insertWithdrawal(params: InsertWithdrawalParams): Promise<void>;
	/** Atomically creates the withdrawal and locks its balance. */
	createWithdrawalWithBalanceLock(
		params: InsertWithdrawalParams,
	): Promise<'created' | 'insufficient_balance' | 'active_withdrawal_exists'>;
	getWithdrawal(id: string): Promise<WithdrawalRow | null>;
	/** requested | processing | submitted 任一状态的进行中提现单。 */
	getActiveWithdrawalByUser(userId: string): Promise<WithdrawalRow | null>;
	listWithdrawalsByUser(userId: string, page: number, pageSize: number): Promise<{ rows: WithdrawalRow[]; total: number }>;
	listAllWithdrawals(status?: string): Promise<WithdrawalRow[]>;
	/** @deprecated Use createWithdrawalWithBalanceLock for new callers. */
	lockBalanceForWithdrawal(userId: string, amount: number, nowIso: string): Promise<boolean>;
	/** 提现确认：locked_amount -= amount, lifetime_withdrawn += amount, status=confirmed。 */
	settleWithdrawalConfirmed(id: string, userId: string, amount: number, nowIso: string): Promise<void>;
	/** 提现失败/驳回：locked_amount -= amount, balance += amount, status=failed。 */
	refundWithdrawal(id: string, userId: string, amount: number, reason: string, nowIso: string): Promise<void>;
	updateWithdrawalStatus(
		id: string,
		patch: {
			status?: string;
			txHash?: string | null;
			chainId?: number | null;
			tokenAmount?: number | null;
			failureReason?: string | null;
			nowIso: string;
			/** CAS 条件：仅当当前 status 等于该值才更新（并发处理器防双铸）。 */
			expectedStatus?: string;
		}
	): Promise<boolean>;
	/** 幂等创建铸造记录；UNIQUE(user_id, badge_token_id) 冲突返回 false。 */
	insertNftMint(params: InsertNftMintParams): Promise<boolean>;
	getNftMintsByUser(userId: string): Promise<NftMintRow[]>;
	listAllNftMints(status?: string): Promise<NftMintRow[]>;
	updateNftMintStatus(
		id: string,
		patch: {
			status?: string;
			txHash?: string | null;
			chainId?: number | null;
			failureReason?: string | null;
			confirmedAt?: string | null;
			expectedStatus?: string;
		}
	): Promise<boolean>;
	setHighestBadgeTier(userId: string, tier: number, nowIso: string): Promise<void>;
}
