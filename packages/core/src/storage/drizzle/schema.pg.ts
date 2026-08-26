import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, integer, numeric, real, boolean, uniqueIndex, check, bigint, primaryKey } from 'drizzle-orm/pg-core';

export const usersTable = pgTable(
	'users',
	{
		id: text('id').primaryKey(),
		/**
		 * 在 `external_system` 命名空间内唯一（含 internal 用户，即 `external_system IS NULL`）；
		 * 由两条 partial unique index 落实，见表选项末尾。
		 */
		email: text('email').notNull(),
		budgetMax: numeric('budget_max', { precision: 18, scale: 6 }),
		budgetBase: numeric('budget_base', { precision: 18, scale: 6 }).notNull().default('0'),
		budgetSpent: numeric('budget_spent', { precision: 18, scale: 6 }).notNull().default('0'),
		budgetPeriod: text('budget_period').notNull().default('none'),
		budgetResetAt: timestamp('budget_reset_at', { withTimezone: true, mode: 'string' }),
		status: text('status').notNull().default('active'),
		metadata: text('metadata'),
		/** `{ "<models.id>": factor }` JSON；NULL 表示无用户级 Charged 折扣 */
		chargedCostFactors: text('charged_cost_factors'),
		/** 上游命名空间（产品/租户），与 external_user_id 成对做幂等；纯网关用户二者皆空。 */
		externalSystem: text('external_system'),
		externalUserId: text('external_user_id'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
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
		check(
			'users_external_system_nonempty_chk',
			sql`external_system IS NULL OR length(external_system) > 0`
		),
	]
);

export const apiKeysTable = pgTable('api_keys', {
	id: text('id').primaryKey(),
	key: text('key').notNull(),
	keyHash: text('key_hash'),
	userId: text('user_id').notNull(),
	name: text('name'),
	status: text('status').notNull().default('active'),
	metadata: text('metadata'),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const providersTable = pgTable('providers', {
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
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const modelsTable = pgTable('models', {
	id: text('id').primaryKey(),
	displayName: text('display_name'),
	vendor: text('vendor').notNull().default('other'),
	contextWindow: integer('context_window'),
	/** Chat completion max output tokens; NULL for image-generation models. */
	maxTokens: integer('max_tokens').default(8192),
	pricingProfile: text('pricing_profile'),
	description: text('description'),
	metadata: text('metadata'),
	inputModalities: text('input_modalities'),
	outputModalities: text('output_modalities'),
	releasedAt: text('released_at'),
	/** 路由策略配置 JSON；NULL=使用全局/代码默认 */
	routePolicy: text('route_policy'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const routePoolsTable = pgTable('route_pools', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	routeGroup: text('route_group').notNull().default('default'),
	name: text('name').notNull(),
	strategy: text('strategy'),
	/** JSON map: {"10":"hash_affinity","0":"weight_priority"} — per-priority-tier overrides */
	tierStrategies: text('tier_strategies'),
	stickyEnabled: boolean('sticky_enabled').notNull().default(false),
	stickyIdleTtlSeconds: integer('sticky_idle_ttl_seconds').notNull().default(3600),
	/** Bumped on sticky config change to invalidate existing bindings */
	stickyEpoch: integer('sticky_epoch').notNull().default(0),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const routePoolStickyBindingsTable = pgTable('route_pool_sticky_bindings', {
	routePoolId: text('route_pool_id').notNull(),
	affinityHash: text('affinity_hash').notNull(),
	routeTargetId: text('route_target_id').notNull(),
	bindingToken: text('binding_token').notNull(),
	poolEpoch: integer('pool_epoch').notNull().default(0),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const modelSurfacesTable = pgTable('model_surfaces', {
	id: text('id').primaryKey(),
	modelId: text('model_id').notNull(),
	routeGroup: text('route_group').notNull().default('default'),
	requestProtocol: text('request_protocol').notNull(),
	requestOperation: text('request_operation').notNull().default('*'),
	routePoolId: text('route_pool_id').notNull(),
	status: text('status').notNull().default('active'),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const modelRoutesTable = pgTable('model_routes', {
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
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const apiKeyRequestLogsTable = pgTable('api_key_request_logs', {
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
	meteredCost: numeric('metered_cost', { precision: 18, scale: 6 }).notNull().default('0'),
	standardCost: numeric('standard_cost', { precision: 18, scale: 6 }).notNull().default('0'),
	chargedCost: numeric('charged_cost', { precision: 18, scale: 6 }).notNull().default('0'),
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
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const systemConfigTable = pgTable('system_config', {
	key: text('key').primaryKey(),
	value: text('value').notNull(),
	description: text('description'),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

/** 用户维度审计：预算、资料等；扩展载荷见 `change_payload`。 */
export const userAuditLogsTable = pgTable('user_audit_logs', {
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
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
});

export const adminApiKeysTable = pgTable('admin_api_keys', {
	id: text('id').primaryKey(),
	name: text('name').notNull().unique(),
	description: text('description'),
	secretKey: text('secret_key').notNull().unique(),
	secretKeyHash: text('secret_key_hash'),
	keyPrefix: text('key_prefix').notNull(),
	permissionsJson: text('permissions_json').notNull().default('[]'),
	status: text('status').notNull().default('active'),
	lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
});

export const adminSessionsTable = pgTable('admin_sessions', {
	tokenHash: text('token_hash').primaryKey(),
	username: text('username').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
});

/** 用户门户会话（`user_session` Cookie），独立于 admin_sessions。 */
export const portalSessionsTable = pgTable('portal_sessions', {
	tokenHash: text('token_hash').primaryKey(),
	/** CinaAuth OIDC `sub` */
	subject: text('subject').notNull(),
	email: text('email').notNull(),
	createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
});

/** 卖家上架的个人上游 API Key（官方渠道白名单）。 */
export const sharedKeysTable = pgTable(
	'shared_keys',
	{
		id: text('id').primaryKey(),
		sellerUserId: text('seller_user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
		/** openai | anthropic | zhipu | deepseek */
		channelType: text('channel_type').notNull(),
		apiKey: text('api_key').notNull(),
		keyFingerprint: text('key_fingerprint').notNull(),
		label: text('label'),
		/** validating | active | paused | invalid | disabled */
		status: text('status').notNull().default('validating'),
		sellerPriority: integer('seller_priority').notNull().default(0),
		weight: integer('weight').notNull().default(1),
		inputPrice: numeric('input_price', { precision: 18, scale: 6 }).notNull().default('0'),
		outputPrice: numeric('output_price', { precision: 18, scale: 6 }).notNull().default('0'),
		cacheReadPrice: numeric('cache_read_price', { precision: 18, scale: 6 }),
		cacheWritePrice: numeric('cache_write_price', { precision: 18, scale: 6 }),
		validatedAt: timestamp('validated_at', { withTimezone: true, mode: 'string' }),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
		lastFailureAt: timestamp('last_failure_at', { withTimezone: true, mode: 'string' }),
		failureReason: text('failure_reason'),
		servedInputTokens: bigint('served_input_tokens', { mode: 'number' }).notNull().default(0),
		servedOutputTokens: bigint('served_output_tokens', { mode: 'number' }).notNull().default(0),
		earnedTotal: numeric('earned_total', { precision: 18, scale: 6 }).notNull().default('0'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
	},
	(t) => [
		uniqueIndex('uk_shared_keys_seller_fingerprint').on(t.sellerUserId, t.keyFingerprint),
	]
);

/** 按请求结算的卖家收益流水；`request_log_id` 幂等。 */
export const sharedKeyEarningsTable = pgTable(
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
		grossAmount: numeric('gross_amount', { precision: 18, scale: 6 }).notNull().default('0'),
		platformFee: numeric('platform_fee', { precision: 18, scale: 6 }).notNull().default('0'),
		netAmount: numeric('net_amount', { precision: 18, scale: 6 }).notNull().default('0'),
		currency: text('currency').notNull().default('USD'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	},
	(t) => [uniqueIndex('uk_shared_key_earnings_request_log').on(t.requestLogId)]
);

/** 卖家账本（1:1 users）。 */
export const userEarningsTable = pgTable('user_earnings', {
	userId: text('user_id').primaryKey().references(() => usersTable.id, { onDelete: 'cascade' }),
	balance: numeric('balance', { precision: 18, scale: 6 }).notNull().default('0'),
	lockedAmount: numeric('locked_amount', { precision: 18, scale: 6 }).notNull().default('0'),
	lifetimeEarned: numeric('lifetime_earned', { precision: 18, scale: 6 }).notNull().default('0'),
	lifetimeWithdrawn: numeric('lifetime_withdrawn', { precision: 18, scale: 6 }).notNull().default('0'),
	contributionValue: numeric('contribution_value', { precision: 18, scale: 6 }).notNull().default('0'),
	/** Canonical monetary state; NUMERIC columns above are compatibility projections. */
	balanceMicros: bigint('balance_micros', { mode: 'bigint' }).notNull().default(sql`0`),
	lockedAmountMicros: bigint('locked_amount_micros', { mode: 'bigint' }).notNull().default(sql`0`),
	lifetimeEarnedMicros: bigint('lifetime_earned_micros', { mode: 'bigint' }).notNull().default(sql`0`),
	lifetimeWithdrawnMicros: bigint('lifetime_withdrawn_micros', { mode: 'bigint' }).notNull().default(sql`0`),
	contributionValueMicros: bigint('contribution_value_micros', { mode: 'bigint' }).notNull().default(sql`0`),
	walletAddress: text('wallet_address'),
	walletVerifiedAt: timestamp('wallet_verified_at', { withTimezone: true, mode: 'string' }),
	highestBadgeTier: integer('highest_badge_tier').notNull().default(0),
	updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
});

/** Append-only balance journal. Mutations are owned by database triggers. */
export const portalLedgerEntriesTable = pgTable(
	'portal_ledger_entries',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull(),
		amountMicros: bigint('amount_micros', { mode: 'bigint' }).notNull(),
		balanceAfterMicros: bigint('balance_after_micros', { mode: 'bigint' }).notNull(),
		lockedAfterMicros: bigint('locked_after_micros', { mode: 'bigint' }).notNull(),
		referenceType: text('reference_type').notNull(),
		referenceId: text('reference_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
	},
	(t) => [uniqueIndex('portal_ledger_entries_reference_unique').on(t.referenceType, t.referenceId, t.kind)]
);

/** 链上 CINA-C 自动提现单。 */
export const withdrawalsTable = pgTable(
	'withdrawals',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
		amount: numeric('amount', { precision: 18, scale: 6 }).notNull(),
		fee: numeric('fee', { precision: 18, scale: 6 }).notNull().default('0'),
		netAmount: numeric('net_amount', { precision: 18, scale: 6 }).notNull(),
		amountMicros: bigint('amount_micros', { mode: 'bigint' }).notNull().default(sql`0`),
		feeMicros: bigint('fee_micros', { mode: 'bigint' }).notNull().default(sql`0`),
		netAmountMicros: bigint('net_amount_micros', { mode: 'bigint' }).notNull().default(sql`0`),
		currency: text('currency').notNull().default('USD'),
		walletAddress: text('wallet_address').notNull(),
		/** requested | processing | submitted | confirmed | failed */
		status: text('status').notNull().default('requested'),
		tokenAmount: numeric('token_amount', { precision: 18, scale: 6 }),
		txHash: text('tx_hash'),
		chainId: integer('chain_id'),
		failureReason: text('failure_reason'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
		updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
		confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
	}
);

/** cinachain CinaBadge 位阶徽章铸造记录。 */
export const nftMintsTable = pgTable(
	'nft_mints',
	{
		id: text('id').primaryKey(),
		userId: text('user_id').notNull().references(() => usersTable.id, { onDelete: 'cascade' }),
		badgeTokenId: integer('badge_token_id').notNull(),
		tierName: text('tier_name').notNull(),
		walletAddress: text('wallet_address').notNull(),
		/** pending | submitted | confirmed | failed */
		status: text('status').notNull().default('pending'),
		txHash: text('tx_hash'),
		chainId: integer('chain_id'),
		valueSnapshot: numeric('value_snapshot', { precision: 18, scale: 6 }).notNull().default('0'),
		failureReason: text('failure_reason'),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
		confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'string' }),
	},
	(t) => [uniqueIndex('uk_nft_mints_user_badge').on(t.userId, t.badgeTokenId)]
);

/** Signed transaction outbox used by the at-least-once chain queue consumer. */
export const chainJobTransactionsTable = pgTable(
	'chain_job_transactions',
	{
		jobKind: text('job_kind').notNull(),
		jobId: text('job_id').notNull(),
		txHash: text('tx_hash').notNull().unique(),
		rawTransaction: text('raw_transaction').notNull(),
		chainId: integer('chain_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
		broadcastAt: timestamp('broadcast_at', { withTimezone: true, mode: 'string' }),
	},
	(t) => [primaryKey({ columns: [t.jobKind, t.jobId] })]
);

export const pgCoreSchema = {
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
	portalLedgerEntriesTable,
	withdrawalsTable,
	nftMintsTable,
	chainJobTransactionsTable,
};
