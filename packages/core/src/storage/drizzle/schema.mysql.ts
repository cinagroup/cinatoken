import { sql } from 'drizzle-orm';
import { mysqlTable, text, timestamp, int, decimal, double, varchar, uniqueIndex, check, bigint } from 'drizzle-orm/mysql-core';

/**
 * PK / UNIQUE / FK 列宽与 migrations-mysql/0001_baseline.sql 对齐。
 * MySQL InnoDB 不允许无前缀长度的 TEXT/BLOB 作为键，因此主键与唯一键必须用 VARCHAR。
 */
const COL = {
	ID: 512,
	KEY: 767,
	USER_ID: 512,
	EMAIL: 512,
	EXTERNAL_USER_ID: 512,
	EXTERNAL_SYSTEM: 128,
	STATUS: 32,
	PERIOD: 64,
	PROVIDER_NAME: 512,
	MODEL_ID: 512,
	PROVIDER_ID: 512,
	ROUTE_GROUP: 64,
	VENDOR: 64,
	EVENT_TYPE: 64,
	ACTOR_TYPE: 32,
	SYSCONFIG_KEY: 255,
	TAG: 255,
	NAME: 512,
} as const;

export const usersTable = mysqlTable(
	'users',
	{
		id: varchar('id', { length: COL.ID }).primaryKey(),
		/**
		 * 在 `external_system` 命名空间内唯一（含 internal 用户，即 `external_system IS NULL`）；
		 * 因 InnoDB 不支持 partial index，靠生成列 `external_system_norm` + `uk_users_external_system_email` 实现。
		 */
		email: varchar('email', { length: COL.EMAIL }).notNull(),
		budgetMax: decimal('budget_max', { precision: 18, scale: 6 }),
		budgetBase: decimal('budget_base', { precision: 18, scale: 6 }).notNull().default('0'),
		budgetSpent: decimal('budget_spent', { precision: 18, scale: 6 }).notNull().default('0'),
		budgetPeriod: varchar('budget_period', { length: COL.PERIOD }).notNull().default('none'),
		budgetResetAt: timestamp('budget_reset_at', { fsp: 6, mode: 'string' }),
		status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
		metadata: text('metadata'),
		/** `{ "<models.id>": factor }` JSON；NULL 表示无用户级 Charged 折扣 */
		chargedCostFactors: text('charged_cost_factors'),
		/** 上游命名空间（产品/租户），与 external_user_id 成对做幂等；纯网关用户二者皆空。 */
		externalSystem: varchar('external_system', { length: COL.EXTERNAL_SYSTEM }),
		externalUserId: varchar('external_user_id', { length: COL.EXTERNAL_USER_ID }),
		/**
		 * MySQL-only generated column: `COALESCE(external_system, '')`. 与 `email` 组成
		 * `uk_users_external_system_email` 唯一约束，让 internal 用户共享一个 namespace。
		 * `users_external_system_nonempty_chk` 保证 `''` 哨兵不会与真实值碰撞。
		 */
		externalSystemNorm: varchar('external_system_norm', { length: COL.EXTERNAL_SYSTEM }).generatedAlwaysAs(
			sql`COALESCE(external_system, '')`,
			{ mode: 'stored' }
		),
		createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
		updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
	},
	(t) => [
		uniqueIndex('uk_users_external_system_user_id').on(t.externalSystem, t.externalUserId),
		uniqueIndex('uk_users_external_system_email').on(t.externalSystemNorm, t.email),
		check(
			'users_external_pair_chk',
			sql`(external_system IS NULL AND external_user_id IS NULL) OR (external_system IS NOT NULL AND external_user_id IS NOT NULL)`
		),
		check(
			'users_external_system_nonempty_chk',
			sql`external_system IS NULL OR CHAR_LENGTH(external_system) > 0`
		),
	]
);

export const apiKeysTable = mysqlTable('api_keys', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	key: varchar('key', { length: COL.KEY }).notNull(),
	userId: varchar('user_id', { length: COL.USER_ID }).notNull(),
	name: varchar('name', { length: COL.NAME }),
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	metadata: text('metadata'),
	lastUsedAt: timestamp('last_used_at', { fsp: 6, mode: 'string' }),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const providersTable = mysqlTable('providers', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	name: varchar('name', { length: COL.PROVIDER_NAME }).notNull(),
	/** JSON: `{ openai?: { base?, endpoints? }, … }` */
	endpoints: text('endpoints'),
	/** 该上游账号唯一 API Key */
	apiKey: text('api_key').notNull().default(''),
	/** `active` | `disabled` */
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	description: text('description'),
	/** 非空时该 provider 接受对应用户共享密钥池注入（openai/anthropic/zhipu/deepseek） */
	sharedChannelType: varchar('shared_channel_type', { length: COL.VENDOR }),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const modelsTable = mysqlTable('models', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	displayName: text('display_name'),
	vendor: varchar('vendor', { length: COL.VENDOR }).notNull().default('other'),
	contextWindow: int('context_window'),
	/** Chat completion max output tokens; NULL for image-generation models. */
	maxTokens: int('max_tokens').default(8192),
	pricingProfile: text('pricing_profile'),
	description: text('description'),
	metadata: text('metadata'),
	inputModalities: text('input_modalities'),
	outputModalities: text('output_modalities'),
	releasedAt: text('released_at'),
	/** 路由策略配置 JSON；NULL=使用全局/代码默认 */
	routePolicy: text('route_policy'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const routePoolsTable = mysqlTable('route_pools', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	modelId: varchar('model_id', { length: COL.MODEL_ID }).notNull(),
	routeGroup: varchar('route_group', { length: COL.ROUTE_GROUP }).notNull().default('default'),
	name: varchar('name', { length: COL.NAME }).notNull(),
	strategy: varchar('strategy', { length: COL.STATUS }),
	/** JSON map: {"10":"hash_affinity","0":"weight_priority"} — per-priority-tier overrides */
	tierStrategies: text('tier_strategies'),
	stickyEnabled: int('sticky_enabled').notNull().default(0),
	stickyIdleTtlSeconds: int('sticky_idle_ttl_seconds').notNull().default(3600),
	/** Bumped on sticky config change to invalidate existing bindings */
	stickyEpoch: int('sticky_epoch').notNull().default(0),
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const routePoolStickyBindingsTable = mysqlTable('route_pool_sticky_bindings', {
	routePoolId: varchar('route_pool_id', { length: COL.ID }).notNull(),
	affinityHash: varchar('affinity_hash', { length: 64 }).notNull(),
	routeTargetId: varchar('route_target_id', { length: COL.ID }).notNull(),
	bindingToken: varchar('binding_token', { length: 64 }).notNull(),
	poolEpoch: int('pool_epoch').notNull().default(0),
	expiresAt: timestamp('expires_at', { fsp: 6, mode: 'string' }).notNull(),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const modelSurfacesTable = mysqlTable('model_surfaces', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	modelId: varchar('model_id', { length: COL.MODEL_ID }).notNull(),
	routeGroup: varchar('route_group', { length: COL.ROUTE_GROUP }).notNull().default('default'),
	requestProtocol: varchar('request_protocol', { length: COL.STATUS }).notNull(),
	requestOperation: varchar('request_operation', { length: 64 }).notNull().default('*'),
	routePoolId: varchar('route_pool_id', { length: COL.ID }).notNull(),
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const modelRoutesTable = mysqlTable('model_routes', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	modelId: varchar('model_id', { length: COL.MODEL_ID }).notNull(),
	providerId: varchar('provider_id', { length: COL.PROVIDER_ID }).notNull(),
	providerModelName: text('provider_model_name').notNull(),
	priority: int('priority').notNull().default(0),
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	routeGroup: varchar('route_group', { length: COL.ROUTE_GROUP }).notNull().default('default'),
	/** 同 priority 层内权重 */
	weight: int('weight').notNull().default(1),
	priceOverride: text('price_override'),
	customParams: text('custom_params'),
	upstreamProtocol: varchar('upstream_protocol', { length: COL.STATUS }).notNull().default('openai'),
	routePoolId: varchar('route_pool_id', { length: COL.ID }),
	upstreamOperation: varchar('upstream_operation', { length: 64 }).notNull().default('*'),
	adapter: varchar('adapter', { length: 128 }).notNull().default('passthrough'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const apiKeyRequestLogsTable = mysqlTable('api_key_request_logs', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	userId: varchar('user_id', { length: COL.USER_ID }),
	apiKeyId: varchar('api_key_id', { length: COL.ID }),
	userEmail: varchar('user_email', { length: COL.EMAIL }),
	modelId: varchar('model_id', { length: COL.ID }),
	providerId: varchar('provider_id', { length: COL.ID }),
	providerModelName: text('provider_model_name'),
	modelName: text('model_name'),
	providerName: text('provider_name'),
	requestBody: text('request_body'),
	upstreamRequestBody: text('upstream_request_body'),
	requestProtocol: varchar('request_protocol', { length: COL.STATUS }),
	requestOperation: varchar('request_operation', { length: 64 }),
	upstreamProtocol: varchar('upstream_protocol', { length: COL.STATUS }).notNull().default('openai'),
	upstreamOperation: varchar('upstream_operation', { length: 64 }),
	modelSurfaceId: varchar('model_surface_id', { length: COL.ID }),
	routePoolId: varchar('route_pool_id', { length: COL.ID }),
	routeTargetId: varchar('route_target_id', { length: COL.ID }),
	adapter: varchar('adapter', { length: 128 }),
	routeTrace: text('route_trace'),
	inputTokens: int('input_tokens').notNull().default(0),
	outputTokens: int('output_tokens').notNull().default(0),
	cacheReadTokens: int('cache_read_tokens').notNull().default(0),
	cacheWriteTokens: int('cache_write_tokens').notNull().default(0),
	reasoningTokens: int('reasoning_tokens').notNull().default(0),
	totalTokens: int('total_tokens').notNull().default(0),
	meteredCost: decimal('metered_cost', { precision: 18, scale: 6 }).notNull().default('0'),
	standardCost: decimal('standard_cost', { precision: 18, scale: 6 }).notNull().default('0'),
	chargedCost: decimal('charged_cost', { precision: 18, scale: 6 }).notNull().default('0'),
	routeGroup: varchar('route_group', { length: COL.ROUTE_GROUP }).notNull().default('default'),
	status: varchar('status', { length: COL.STATUS }).notNull().default('success'),
	latencyMs: int('latency_ms'),
	gatewayOverheadMs: int('gateway_overhead_ms'),
	upstreamResponseMs: int('upstream_response_ms'),
	finalUpstreamHeadersMs: int('final_upstream_headers_ms'),
	firstReasoningTokenMs: int('first_reasoning_token_ms'),
	firstTokenMs: int('first_token_ms'),
	streamDurationMs: int('stream_duration_ms'),
	upstreamAttemptCount: int('upstream_attempt_count'),
	upstreamFailoverCount: int('upstream_failover_count'),
	timingMetadata: text('timing_metadata'),
	errorMessage: text('error_message'),
	rawUsage: text('raw_usage'),
	/** 计费审计 JSON 字符串；结构见 `db/pricing-audit.ts` */
	pricingAudit: text('pricing_audit'),
	providerKeyId: varchar('provider_key_id', { length: COL.ID }),
	providerKeyLabel: varchar('provider_key_label', { length: COL.NAME }),
	providerKeyFingerprint: varchar('provider_key_fingerprint', { length: 64 }),
	upstreamRequestId: varchar('upstream_request_id', { length: 200 }),
	upstreamMessageId: varchar('upstream_message_id', { length: 200 }),
	billingKind: varchar('billing_kind', { length: 32 }),
	inputImageCount: int('input_image_count').notNull().default(0),
	outputImageCount: int('output_image_count').notNull().default(0),
	audioDurationSeconds: double('audio_duration_seconds'),
	audioCharacters: int('audio_characters'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const systemConfigTable = mysqlTable('system_config', {
	key: varchar('key', { length: COL.SYSCONFIG_KEY }).primaryKey(),
	value: text('value').notNull(),
	description: text('description'),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

/** 用户维度审计：预算、资料等；扩展载荷见 `change_payload`。 */
export const userAuditLogsTable = mysqlTable('user_audit_logs', {
	id: varchar('id', { length: COL.ID }).primaryKey(),
	userId: varchar('user_id', { length: COL.USER_ID }),
	apiKeyId: varchar('api_key_id', { length: COL.ID }),
	eventType: varchar('event_type', { length: COL.EVENT_TYPE }).notNull(),
	actorType: varchar('actor_type', { length: COL.ACTOR_TYPE }).notNull().default('system'),
	requestLogId: varchar('request_log_id', { length: COL.ID }),
	changePayload: text('change_payload'),
	beforeUserSnapshot: text('before_user_snapshot'),
	afterUserSnapshot: text('after_user_snapshot'),
	changedFields: text('changed_fields'),
	correlationId: varchar('correlation_id', { length: COL.ID }),
	source: varchar('source', { length: 128 }),
	actorId: varchar('actor_id', { length: COL.ID }),
	reasonCode: varchar('reason_code', { length: 128 }),
	reasonText: text('reason_text'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
});

export const adminApiKeysTable = mysqlTable('admin_api_keys', {
	id: varchar('id', { length: 128 }).primaryKey(),
	name: varchar('name', { length: 255 }).notNull().unique(),
	description: text('description'),
	secretKey: varchar('secret_key', { length: COL.KEY }).notNull().unique(),
	keyPrefix: varchar('key_prefix', { length: 32 }).notNull(),
	permissionsJson: text('permissions_json').notNull(),
	status: varchar('status', { length: COL.STATUS }).notNull().default('active'),
	lastUsedAt: timestamp('last_used_at', { fsp: 6, mode: 'string' }),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
	revokedAt: timestamp('revoked_at', { fsp: 6, mode: 'string' }),
});

export const adminSessionsTable = mysqlTable('admin_sessions', {
	tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
	username: varchar('username', { length: 255 }).notNull(),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	expiresAt: timestamp('expires_at', { fsp: 6, mode: 'string' }).notNull(),
});

/** 用户门户会话（`user_session` Cookie），独立于 admin_sessions。 */
export const portalSessionsTable = mysqlTable('portal_sessions', {
	tokenHash: varchar('token_hash', { length: 64 }).primaryKey(),
	/** CinaAuth OIDC `sub` */
	subject: varchar('subject', { length: 255 }).notNull(),
	email: varchar('email', { length: 512 }).notNull(),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	expiresAt: timestamp('expires_at', { fsp: 6, mode: 'string' }).notNull(),
});

/** 卖家上架的个人上游 API Key（官方渠道白名单）。 */
export const sharedKeysTable = mysqlTable(
	'shared_keys',
	{
		id: varchar('id', { length: 128 }).primaryKey(),
		sellerUserId: varchar('seller_user_id', { length: COL.USER_ID }).notNull(),
		channelType: varchar('channel_type', { length: COL.VENDOR }).notNull(),
		apiKey: text('api_key').notNull(),
		keyFingerprint: varchar('key_fingerprint', { length: 128 }).notNull(),
		label: varchar('label', { length: COL.NAME }),
		status: varchar('status', { length: COL.STATUS }).notNull().default('validating'),
		sellerPriority: int('seller_priority').notNull().default(0),
		weight: int('weight').notNull().default(1),
		inputPrice: decimal('input_price', { precision: 18, scale: 6 }).notNull().default('0'),
		outputPrice: decimal('output_price', { precision: 18, scale: 6 }).notNull().default('0'),
		cacheReadPrice: decimal('cache_read_price', { precision: 18, scale: 6 }),
		cacheWritePrice: decimal('cache_write_price', { precision: 18, scale: 6 }),
		validatedAt: timestamp('validated_at', { fsp: 6, mode: 'string' }),
		lastUsedAt: timestamp('last_used_at', { fsp: 6, mode: 'string' }),
		lastFailureAt: timestamp('last_failure_at', { fsp: 6, mode: 'string' }),
		failureReason: text('failure_reason'),
		servedInputTokens: bigint('served_input_tokens', { mode: 'number' }).notNull().default(0),
		servedOutputTokens: bigint('served_output_tokens', { mode: 'number' }).notNull().default(0),
		earnedTotal: decimal('earned_total', { precision: 18, scale: 6 }).notNull().default('0'),
		createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
		updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
	},
	(t) => [
		uniqueIndex('uk_shared_keys_seller_fingerprint').on(t.sellerUserId, t.keyFingerprint),
	]
);

/** 按请求结算的卖家收益流水；`request_log_id` 幂等。 */
export const sharedKeyEarningsTable = mysqlTable(
	'shared_key_earnings',
	{
		id: varchar('id', { length: 128 }).primaryKey(),
		requestLogId: varchar('request_log_id', { length: 128 }).notNull(),
		sharedKeyId: varchar('shared_key_id', { length: 128 }).notNull(),
		sellerUserId: varchar('seller_user_id', { length: COL.USER_ID }).notNull(),
		inputTokens: int('input_tokens').notNull().default(0),
		outputTokens: int('output_tokens').notNull().default(0),
		cacheReadTokens: int('cache_read_tokens').notNull().default(0),
		cacheWriteTokens: int('cache_write_tokens').notNull().default(0),
		grossAmount: decimal('gross_amount', { precision: 18, scale: 6 }).notNull().default('0'),
		platformFee: decimal('platform_fee', { precision: 18, scale: 6 }).notNull().default('0'),
		netAmount: decimal('net_amount', { precision: 18, scale: 6 }).notNull().default('0'),
		currency: varchar('currency', { length: 16 }).notNull().default('USD'),
		createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	},
	(t) => [uniqueIndex('uk_shared_key_earnings_request_log').on(t.requestLogId)]
);

/** 卖家账本（1:1 users）。 */
export const userEarningsTable = mysqlTable('user_earnings', {
	userId: varchar('user_id', { length: COL.USER_ID }).primaryKey(),
	balance: decimal('balance', { precision: 18, scale: 6 }).notNull().default('0'),
	lockedAmount: decimal('locked_amount', { precision: 18, scale: 6 }).notNull().default('0'),
	lifetimeEarned: decimal('lifetime_earned', { precision: 18, scale: 6 }).notNull().default('0'),
	lifetimeWithdrawn: decimal('lifetime_withdrawn', { precision: 18, scale: 6 }).notNull().default('0'),
	contributionValue: decimal('contribution_value', { precision: 18, scale: 6 }).notNull().default('0'),
	walletAddress: varchar('wallet_address', { length: 128 }),
	walletVerifiedAt: timestamp('wallet_verified_at', { fsp: 6, mode: 'string' }),
	highestBadgeTier: int('highest_badge_tier').notNull().default(0),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
});

/** 链上 CINA-C 自动提现单。 */
export const withdrawalsTable = mysqlTable('withdrawals', {
	id: varchar('id', { length: 128 }).primaryKey(),
	userId: varchar('user_id', { length: COL.USER_ID }).notNull(),
	amount: decimal('amount', { precision: 18, scale: 6 }).notNull(),
	fee: decimal('fee', { precision: 18, scale: 6 }).notNull().default('0'),
	netAmount: decimal('net_amount', { precision: 18, scale: 6 }).notNull(),
	currency: varchar('currency', { length: 16 }).notNull().default('USD'),
	walletAddress: varchar('wallet_address', { length: 128 }).notNull(),
	status: varchar('status', { length: COL.STATUS }).notNull().default('requested'),
	tokenAmount: decimal('token_amount', { precision: 18, scale: 6 }),
	txHash: varchar('tx_hash', { length: 128 }),
	chainId: int('chain_id'),
	failureReason: text('failure_reason'),
	createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { fsp: 6, mode: 'string' }).notNull(),
	confirmedAt: timestamp('confirmed_at', { fsp: 6, mode: 'string' }),
});

/** cinachain CinaBadge 位阶徽章铸造记录。 */
export const nftMintsTable = mysqlTable(
	'nft_mints',
	{
		id: varchar('id', { length: 128 }).primaryKey(),
		userId: varchar('user_id', { length: COL.USER_ID }).notNull(),
		badgeTokenId: int('badge_token_id').notNull(),
		tierName: varchar('tier_name', { length: COL.VENDOR }).notNull(),
		walletAddress: varchar('wallet_address', { length: 128 }).notNull(),
		status: varchar('status', { length: COL.STATUS }).notNull().default('pending'),
		txHash: varchar('tx_hash', { length: 128 }),
		chainId: int('chain_id'),
		valueSnapshot: decimal('value_snapshot', { precision: 18, scale: 6 }).notNull().default('0'),
		failureReason: text('failure_reason'),
		createdAt: timestamp('created_at', { fsp: 6, mode: 'string' }).notNull(),
		confirmedAt: timestamp('confirmed_at', { fsp: 6, mode: 'string' }),
	},
	(t) => [uniqueIndex('uk_nft_mints_user_badge').on(t.userId, t.badgeTokenId)]
);

export const mysqlCoreSchema = {
	usersTable,
	apiKeysTable,
	providersTable,
	modelsTable,
	routePoolsTable,
	modelSurfacesTable,
	modelRoutesTable,
	apiKeyRequestLogsTable,
	systemConfigTable,
	userAuditLogsTable,
	adminApiKeysTable,
	adminSessionsTable,
	portalSessionsTable,
	sharedKeysTable,
	sharedKeyEarningsTable,
	userEarningsTable,
	withdrawalsTable,
	nftMintsTable,
};
