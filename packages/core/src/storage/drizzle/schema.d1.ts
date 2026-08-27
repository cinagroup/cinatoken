import { sql } from 'drizzle-orm';
import { check, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const usersTable = sqliteTable(
	'users',
	{
		id: text('id').primaryKey(),
		/**
		 * 在 `external_system` 命名空间内唯一（含 internal 用户，即 `external_system IS NULL`）；
		 * 由两条 partial unique index 落实，见表选项末尾。
		 */
		email: text('email').notNull(),
		budgetMax: real('budget_max'),
		budgetBase: real('budget_base').notNull().default(0),
		budgetSpent: real('budget_spent').notNull().default(0),
		budgetPeriod: text('budget_period').notNull().default('none'),
		budgetResetAt: text('budget_reset_at'),
		status: text('status').notNull().default('active'),
		metadata: text('metadata'),
		/** `{ "<models.id>": factor }` JSON；NULL 表示无用户级 Charged 折扣 */
		chargedCostFactors: text('charged_cost_factors'),
		/** 上游命名空间（产品/租户），与 external_user_id 成对做幂等；纯网关用户二者皆空。 */
		externalSystem: text('external_system'),
		externalUserId: text('external_user_id'),
		createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [
		uniqueIndex('uk_users_external_system_user_id').on(t.externalSystem, t.externalUserId),
		uniqueIndex('uk_users_external_system_email')
			.on(t.externalSystem, t.email)
			.where(sql`external_system IS NOT NULL`),
		uniqueIndex('uk_users_internal_email')
			.on(t.email)
			.where(sql`external_system IS NULL`),
		check(
			'users_external_pair_chk',
			sql`(external_system IS NULL AND external_user_id IS NULL) OR (external_system IS NOT NULL AND external_user_id IS NOT NULL)`
		),
	]
);

export const apiKeysTable = sqliteTable('api_keys', {
	id: text('id').primaryKey(),
	key: text('key').notNull(),
	keyHash: text('key_hash'),
	keyPreview: text('key_preview'),
	userId: text('user_id').notNull(),
	name: text('name'),
	status: text('status').notNull().default('active'),
	metadata: text('metadata'),
	lastUsedAt: text('last_used_at'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const providersTable = sqliteTable('providers', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	/** JSON: `{ openai?: { base?, endpoints? }, … }` */
	endpoints: text('endpoints'),
	/** 该上游账号唯一 API Key */
	apiKey: text('api_key').notNull().default(''),
	/** `active` | `disabled` */
	status: text('status').notNull().default('active'),
	description: text('description'),
	/** 非空时该 provider 接受对应用户共享密钥池注入（openai/anthropic/zhipu/deepseek） */
	sharedChannelType: text('shared_channel_type'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const modelsTable = sqliteTable('models', {
	id: text('id').primaryKey(),
	displayName: text('display_name'),
	vendor: text('vendor').notNull().default('other'),
	contextWindow: integer('context_window'),
	/** Chat completion max output tokens; NULL for image-generation models. */
	maxTokens: integer('max_tokens').default(8192),
	/** JSON：统一阶梯/固定价（`models` 列价真源）。 */
	pricingProfile: text('pricing_profile'),
	description: text('description'),
	metadata: text('metadata'),
	inputModalities: text('input_modalities'),
	outputModalities: text('output_modalities'),
	releasedAt: text('released_at'),
	/** 路由策略配置 JSON；NULL=使用全局/代码默认 */
	routePolicy: text('route_policy'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const routePoolsTable = sqliteTable('route_pools', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	routeGroup: text('route_group').notNull().default('default'),
	name: text('name').notNull(),
	strategy: text('strategy'),
	/** JSON map: {"10":"hash_affinity","0":"weight_priority"} — per-priority-tier overrides */
	tierStrategies: text('tier_strategies'),
	/** Provider sticky routing: 0/1 */
	stickyEnabled: integer('sticky_enabled').notNull().default(0),
	stickyIdleTtlSeconds: integer('sticky_idle_ttl_seconds').notNull().default(3600),
	/** Bumped on sticky config change to invalidate existing bindings */
	stickyEpoch: integer('sticky_epoch').notNull().default(0),
	status: text('status').notNull().default('active'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const routePoolStickyBindingsTable = sqliteTable('route_pool_sticky_bindings', {
	routePoolId: text('route_pool_id').notNull(),
	affinityHash: text('affinity_hash').notNull(),
	routeTargetId: text('route_target_id').notNull(),
	bindingToken: text('binding_token').notNull(),
	poolEpoch: integer('pool_epoch').notNull().default(0),
	expiresAt: text('expires_at').notNull(),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const modelSurfacesTable = sqliteTable('model_surfaces', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	routeGroup: text('route_group').notNull().default('default'),
	requestProtocol: text('request_protocol').notNull(),
	requestOperation: text('request_operation').notNull().default('*'),
	routePoolId: text('route_pool_id').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const modelRoutesTable = sqliteTable('model_routes', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	providerId: text('provider_id').notNull(),
	providerModelName: text('provider_model_name').notNull(),
	priority: integer('priority').notNull().default(0),
	status: text('status').notNull().default('active'),
	routeGroup: text('route_group').notNull().default('default'),
	/** 同 priority 层内权重 */
	weight: integer('weight').notNull().default(1),
	priceOverride: text('price_override'),
	customParams: text('custom_params'),
	upstreamProtocol: text('upstream_protocol').notNull().default('openai'),
	routePoolId: text('route_pool_id'),
	upstreamOperation: text('upstream_operation').notNull().default('*'),
	adapter: text('adapter').notNull().default('passthrough'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const apiKeyRequestLogsTable = sqliteTable('api_key_request_logs', {
	id: text('id').primaryKey(),
	userId: text('user_id'),
	apiKeyId: text('api_key_id'),
	userEmail: text('user_email'),
	modelId: text('model_id'),
	providerId: text('provider_id'),
	providerModelName: text('provider_model_name'),
	modelName: text('model_name'),
	providerName: text('provider_name'),
	requestBody: text('request_body'),
	upstreamRequestBody: text('upstream_request_body'),
	requestProtocol: text('request_protocol'),
	requestOperation: text('request_operation'),
	upstreamProtocol: text('upstream_protocol').notNull().default('openai'),
	upstreamOperation: text('upstream_operation'),
	modelSurfaceId: text('model_surface_id'),
	routePoolId: text('route_pool_id'),
	routeTargetId: text('route_target_id'),
	adapter: text('adapter'),
	routeTrace: text('route_trace'),
	inputTokens: integer('input_tokens').notNull().default(0),
	outputTokens: integer('output_tokens').notNull().default(0),
	cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
	cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
	reasoningTokens: integer('reasoning_tokens').notNull().default(0),
	totalTokens: integer('total_tokens').notNull().default(0),
	meteredCost: real('metered_cost').notNull().default(0),
	standardCost: real('standard_cost').notNull().default(0),
	chargedCost: real('charged_cost').notNull().default(0),
	routeGroup: text('route_group').notNull().default('default'),
	status: text('status').notNull().default('success'),
	latencyMs: integer('latency_ms'),
	gatewayOverheadMs: integer('gateway_overhead_ms'),
	upstreamResponseMs: integer('upstream_response_ms'),
	finalUpstreamHeadersMs: integer('final_upstream_headers_ms'),
	firstReasoningTokenMs: integer('first_reasoning_token_ms'),
	firstTokenMs: integer('first_token_ms'),
	streamDurationMs: integer('stream_duration_ms'),
	upstreamAttemptCount: integer('upstream_attempt_count'),
	upstreamFailoverCount: integer('upstream_failover_count'),
	timingMetadata: text('timing_metadata'),
	errorMessage: text('error_message'),
	rawUsage: text('raw_usage'),
	/** 计费审计 JSON 字符串；结构见 `db/pricing-audit.ts` */
	pricingAudit: text('pricing_audit'),
	providerKeyId: text('provider_key_id'),
	providerKeyLabel: text('provider_key_label'),
	providerKeyFingerprint: text('provider_key_fingerprint'),
	upstreamRequestId: text('upstream_request_id'),
	upstreamMessageId: text('upstream_message_id'),
	billingKind: text('billing_kind'),
	inputImageCount: integer('input_image_count').notNull().default(0),
	outputImageCount: integer('output_image_count').notNull().default(0),
	audioDurationSeconds: real('audio_duration_seconds'),
	audioCharacters: integer('audio_characters'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 匿名公开排行专用的分片日汇总；公开请求不得回退扫描 api_key_request_logs。 */
export const publicModelDailyStatsTable = sqliteTable(
	'public_model_daily_stats',
	{
		statDate: text('stat_date').notNull(),
		modelId: text('model_id').notNull(),
		shard: integer('shard').notNull(),
		requestCount: integer('request_count').notNull().default(0),
		successCount: integer('success_count').notNull().default(0),
		errorCount: integer('error_count').notNull().default(0),
		outputTokens: integer('output_tokens').notNull().default(0),
		latencyTotalMs: integer('latency_total_ms').notNull().default(0),
		latencySampleCount: integer('latency_sample_count').notNull().default(0),
		updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [
		uniqueIndex('uk_public_model_daily_stats').on(t.statDate, t.modelId, t.shard),
		check('public_model_daily_stats_shard_chk', sql`shard >= 0 AND shard < 16`),
	]
);

export const systemConfigTable = sqliteTable('system_config', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	description: text('description'),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 用户维度审计：预算、资料等；扩展载荷见 `change_payload`。 */
export const userAuditLogsTable = sqliteTable('user_audit_logs', {
	id: text('id').primaryKey(),
	userId: text('user_id'),
	apiKeyId: text('api_key_id'),
	eventType: text('event_type').notNull(),
	actorType: text('actor_type').notNull().default('system'),
	requestLogId: text('request_log_id'),
	changePayload: text('change_payload'),
	beforeUserSnapshot: text('before_user_snapshot'),
	afterUserSnapshot: text('after_user_snapshot'),
	changedFields: text('changed_fields'),
	correlationId: text('correlation_id'),
	source: text('source'),
	actorId: text('actor_id'),
	reasonCode: text('reason_code'),
	reasonText: text('reason_text'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const adminApiKeysTable = sqliteTable('admin_api_keys', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	secretKey: text('secret_key').notNull().unique(),
	secretKeyHash: text('secret_key_hash'),
	keyPrefix: text('key_prefix').notNull(),
	permissionsJson: text('permissions_json').notNull().default('[]'),
	status: text('status').notNull().default('active'),
	lastUsedAt: text('last_used_at'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	revokedAt: text('revoked_at'),
});

export const adminSessionsTable = sqliteTable('admin_sessions', {
	tokenHash: text('token_hash').primaryKey(),
	username: text('username').notNull(),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	expiresAt: text('expires_at').notNull(),
});

/** 用户门户会话（`user_session` Cookie），独立于 admin_sessions。 */
export const portalSessionsTable = sqliteTable('portal_sessions', {
	tokenHash: text('token_hash').primaryKey(),
	/** CinaAuth OIDC `sub` */
	subject: text('subject').notNull(),
	email: text('email').notNull(),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	expiresAt: text('expires_at').notNull(),
});

/** 卖家上架的个人上游 API Key（官方渠道白名单）。 */
export const sharedKeysTable = sqliteTable(
	'shared_keys',
	{
		id: text('id').primaryKey(),
		sellerUserId: text('seller_user_id').notNull(),
		channelType: text('channel_type').notNull(),
		apiKey: text('api_key').notNull(),
		keyFingerprint: text('key_fingerprint').notNull(),
		label: text('label'),
		status: text('status').notNull().default('validating'),
		sellerPriority: integer('seller_priority').notNull().default(0),
		weight: integer('weight').notNull().default(1),
		inputPrice: real('input_price').notNull().default(0),
		outputPrice: real('output_price').notNull().default(0),
		cacheReadPrice: real('cache_read_price'),
		cacheWritePrice: real('cache_write_price'),
		validatedAt: text('validated_at'),
		lastUsedAt: text('last_used_at'),
		lastFailureAt: text('last_failure_at'),
		failureReason: text('failure_reason'),
		servedInputTokens: integer('served_input_tokens').notNull().default(0),
		servedOutputTokens: integer('served_output_tokens').notNull().default(0),
		earnedTotal: real('earned_total').notNull().default(0),
		createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
		updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [
		uniqueIndex('uk_shared_keys_seller_fingerprint').on(t.sellerUserId, t.keyFingerprint),
	]
);

/** 按请求结算的卖家收益流水；`request_log_id` 幂等。 */
export const sharedKeyEarningsTable = sqliteTable(
	'shared_key_earnings',
	{
		id: text('id').primaryKey(),
		requestLogId: text('request_log_id').notNull(),
		sharedKeyId: text('shared_key_id').notNull(),
		sellerUserId: text('seller_user_id').notNull(),
		inputTokens: integer('input_tokens').notNull().default(0),
		outputTokens: integer('output_tokens').notNull().default(0),
		cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
		cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
		grossAmount: real('gross_amount').notNull().default(0),
		platformFee: real('platform_fee').notNull().default(0),
		netAmount: real('net_amount').notNull().default(0),
		currency: text('currency').notNull().default('USD'),
		createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	},
	(t) => [uniqueIndex('uk_shared_key_earnings_request_log').on(t.requestLogId)]
);

/** 卖家账本（1:1 users）。 */
export const userEarningsTable = sqliteTable('user_earnings', {
	userId: text('user_id').primaryKey(),
	balance: real('balance').notNull().default(0),
	lockedAmount: real('locked_amount').notNull().default(0),
	lifetimeEarned: real('lifetime_earned').notNull().default(0),
	lifetimeWithdrawn: real('lifetime_withdrawn').notNull().default(0),
	contributionValue: real('contribution_value').notNull().default(0),
	walletAddress: text('wallet_address'),
	walletVerifiedAt: text('wallet_verified_at'),
	highestBadgeTier: integer('highest_badge_tier').notNull().default(0),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** 链上 CINA-C 自动提现单。 */
export const withdrawalsTable = sqliteTable('withdrawals', {
	id: text('id').primaryKey(),
	userId: text('user_id').notNull(),
	amount: real('amount').notNull(),
	fee: real('fee').notNull().default(0),
	netAmount: real('net_amount').notNull(),
	currency: text('currency').notNull().default('USD'),
	walletAddress: text('wallet_address').notNull(),
	status: text('status').notNull().default('requested'),
	tokenAmount: real('token_amount'),
	txHash: text('tx_hash'),
	chainId: integer('chain_id'),
	failureReason: text('failure_reason'),
	createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
	confirmedAt: text('confirmed_at'),
});

/** cinachain CinaBadge 位阶徽章铸造记录。 */
export const nftMintsTable = sqliteTable(
	'nft_mints',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull(),
		badgeTokenId: integer('badge_token_id').notNull(),
		tierName: text('tier_name').notNull(),
		walletAddress: text('wallet_address').notNull(),
		status: text('status').notNull().default('pending'),
		txHash: text('tx_hash'),
		chainId: integer('chain_id'),
		valueSnapshot: real('value_snapshot').notNull().default(0),
		failureReason: text('failure_reason'),
		createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
		confirmedAt: text('confirmed_at'),
	},
	(t) => [uniqueIndex('uk_nft_mints_user_badge').on(t.userId, t.badgeTokenId)]
);

export const d1CoreSchema = {
	usersTable,
	apiKeysTable,
	providersTable,
	modelsTable,
	routePoolsTable,
	modelSurfacesTable,
	modelRoutesTable,
	apiKeyRequestLogsTable,
	publicModelDailyStatsTable,
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
