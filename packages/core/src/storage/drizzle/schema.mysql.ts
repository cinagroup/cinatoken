import { sql } from "drizzle-orm";
import {
	mysqlTable,
	text,
	timestamp,
	datetime,
	int,
	tinyint,
	decimal,
	double,
	varchar,
	index,
	uniqueIndex,
	check,
	bigint,
	primaryKey,
	customType,
} from "drizzle-orm/mysql-core";

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
	WORKSPACE_ID: 600,
	WORKSPACE_SLUG: 128,
	ENDPOINT_ID: 191,
} as const;

/** Preserve byte-exact lowercase SHA-256 equality across MySQL collations. */
const asciiBinarySha256 = customType<{ data: string; driverData: string }>({
	dataType: () => "char(64) character set ascii collate ascii_bin",
});

export const usersTable = mysqlTable(
	"users",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		/**
		 * 在 `external_system` 命名空间内唯一（含 internal 用户，即 `external_system IS NULL`）；
		 * 因 InnoDB 不支持 partial index，靠生成列 `external_system_norm` + `uk_users_external_system_email` 实现。
		 */
		email: varchar("email", { length: COL.EMAIL }).notNull(),
		budgetMax: decimal("budget_max", { precision: 18, scale: 6 }),
		budgetBase: decimal("budget_base", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		budgetSpent: decimal("budget_spent", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		budgetPeriod: varchar("budget_period", { length: COL.PERIOD })
			.notNull()
			.default("none"),
		budgetResetAt: timestamp("budget_reset_at", { fsp: 6, mode: "string" }),
		budgetEpoch: bigint("budget_epoch", { mode: "number" })
			.notNull()
			.default(0),
		budgetReservedMicros: bigint("budget_reserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		metadata: text("metadata"),
		/** `{ "<models.id>": factor }` JSON；NULL 表示无用户级 Charged 折扣 */
		chargedCostFactors: text("charged_cost_factors"),
		/** 上游命名空间（产品/租户），与 external_user_id 成对做幂等；纯网关用户二者皆空。 */
		externalSystem: varchar("external_system", { length: COL.EXTERNAL_SYSTEM }),
		externalUserId: varchar("external_user_id", {
			length: COL.EXTERNAL_USER_ID,
		}),
		/**
		 * MySQL-only generated column: `COALESCE(external_system, '')`. 与 `email` 组成
		 * `uk_users_external_system_email` 唯一约束，让 internal 用户共享一个 namespace。
		 * `users_external_system_nonempty_chk` 保证 `''` 哨兵不会与真实值碰撞。
		 */
		externalSystemNorm: varchar("external_system_norm", {
			length: COL.EXTERNAL_SYSTEM,
		}).generatedAlwaysAs(sql`COALESCE(external_system, '')`, {
			mode: "stored",
		}),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_users_external_system_user_id").on(
			t.externalSystem,
			t.externalUserId
		),
		uniqueIndex("uk_users_external_system_email").on(
			t.externalSystemNorm,
			t.email
		),
		check(
			"users_external_pair_chk",
			sql`(external_system IS NULL AND external_user_id IS NULL) OR (external_system IS NOT NULL AND external_user_id IS NOT NULL)`
		),
		check(
			"users_external_system_nonempty_chk",
			sql`external_system IS NULL OR CHAR_LENGTH(external_system) > 0`
		),
		check(
			"users_budget_epoch_chk",
			sql`${t.budgetEpoch} >= 0 AND ${t.budgetEpoch} <= 9007199254740991`
		),
		check(
			"users_budget_reserved_micros_chk",
			sql`${t.budgetReservedMicros} >= 0 AND ${t.budgetReservedMicros} <= 9007199254740991`
		),
	]
);

/** CinaAuth-owned organization projected into the gateway product boundary. */
export const organizationsTable = mysqlTable(
	"organizations",
	{
		id: varchar("id", { length: 255 }).primaryKey(),
		source: varchar("source", { length: COL.EXTERNAL_SYSTEM }).notNull(),
		name: varchar("name", { length: COL.NAME }).notNull(),
		slug: varchar("slug", { length: 255 }),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		metadataJson: text("metadata_json"),
		sourceUpdatedAt: timestamp("source_updated_at", {
			fsp: 6,
			mode: "string",
		}).notNull(),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		check(
			"organizations_status_chk",
			sql`${t.status} IN ('pending', 'active', 'suspended', 'deleted')`
		),
		check(
			"organizations_source_nonempty_chk",
			sql`CHAR_LENGTH(${t.source}) > 0`
		),
	]
);

/** Organization membership keyed by CinaAuth OIDC subject, even before first login. */
export const organizationMembershipsTable = mysqlTable(
	"organization_memberships",
	{
		organizationId: varchar("organization_id", { length: 255 })
			.notNull()
			.references(() => organizationsTable.id, { onDelete: "cascade" }),
		subject: varchar("subject", { length: 255 }).notNull(),
		userId: varchar("user_id", { length: COL.USER_ID }).references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		email: varchar("email", { length: COL.EMAIL }),
		rolesJson: text("roles_json").notNull(),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		sourceUpdatedAt: timestamp("source_updated_at", {
			fsp: 6,
			mode: "string",
		}).notNull(),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.subject] }),
		check(
			"organization_memberships_status_chk",
			sql`${t.status} IN ('active', 'suspended', 'removed')`
		),
		check(
			"organization_memberships_subject_nonempty_chk",
			sql`CHAR_LENGTH(${t.subject}) > 0`
		),
	]
);

/** Immutable receipt for idempotent identity-event application. */
export const identityEventInboxTable = mysqlTable(
	"identity_event_inbox",
	{
		source: varchar("source", { length: COL.EXTERNAL_SYSTEM }).notNull(),
		eventId: varchar("event_id", { length: 200 }).notNull(),
		eventType: varchar("event_type", { length: 128 }).notNull(),
		aggregateType: varchar("aggregate_type", { length: 64 }).notNull(),
		aggregateId: varchar("aggregate_id", { length: 512 }).notNull(),
		payloadSha256: varchar("payload_sha256", { length: 64 }).notNull(),
		processorToken: varchar("processor_token", { length: 64 })
			.notNull()
			.unique(),
		occurredAt: timestamp("occurred_at", { fsp: 6, mode: "string" }).notNull(),
		processedAt: timestamp("processed_at", {
			fsp: 6,
			mode: "string",
		}).notNull(),
	},
	(t) => [primaryKey({ columns: [t.source, t.eventId] })]
);

/** CinaToken-owned gateway resource boundary; identity remains owned by CinaAuth. */
export const workspacesTable = mysqlTable(
	"workspaces",
	{
		id: varchar("id", { length: COL.WORKSPACE_ID }).primaryKey(),
		scopeType: varchar("scope_type", { length: COL.STATUS }).notNull(),
		organizationId: varchar("organization_id", { length: 255 }).references(
			() => organizationsTable.id,
			{ onDelete: "cascade" }
		),
		personalOwnerUserId: varchar("personal_owner_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "cascade" }),
		name: varchar("name", { length: 255 }).notNull(),
		slug: varchar("slug", { length: COL.WORKSPACE_SLUG }).notNull(),
		description: text("description"),
		isDefault: int("is_default").notNull().default(0),
		defaultScopeKey: varchar("default_scope_key", {
			length: COL.WORKSPACE_ID,
		}).unique(),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		settingsJson: text("settings_json"),
		createdByUserId: varchar("created_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_workspaces_personal_slug").on(
			t.personalOwnerUserId,
			t.slug
		),
		uniqueIndex("uk_workspaces_organization_slug").on(t.organizationId, t.slug),
		check(
			"workspaces_scope_type_chk",
			sql`${t.scopeType} IN ('personal', 'organization')`
		),
		check("workspaces_status_chk", sql`${t.status} IN ('active', 'archived')`),
		check("workspaces_default_flag_chk", sql`${t.isDefault} IN (0, 1)`),
		check(
			"workspaces_scope_owner_chk",
			sql`(
			(${t.scopeType} = 'personal' AND ${t.personalOwnerUserId} IS NOT NULL AND ${t.organizationId} IS NULL)
			OR (${t.scopeType} = 'organization' AND ${t.organizationId} IS NOT NULL AND ${t.personalOwnerUserId} IS NULL)
		)`
		),
		check(
			"workspaces_default_key_chk",
			sql`(
			(${t.isDefault} = 1 AND ${t.defaultScopeKey} IS NOT NULL)
			OR (${t.isDefault} = 0 AND ${t.defaultScopeKey} IS NULL)
		)`
		),
	]
);

export const workspaceBudgetsTable = mysqlTable(
	"workspace_budgets",
	{
		id: varchar("id", { length: 64 }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		resetInterval: varchar("reset_interval", { length: 16 }).notNull(),
		limitMicros: bigint("limit_micros", { mode: "number", unsigned: true }).notNull(),
		configEpoch: int("config_epoch", { unsigned: true }).notNull().default(0),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_workspace_budgets_interval").on(t.workspaceId, t.resetInterval),
		index("idx_workspace_budgets_workspace").on(t.workspaceId),
		check("workspace_budgets_interval_chk", sql`${t.resetInterval} IN ('daily', 'weekly', 'monthly', 'lifetime')`),
		check("workspace_budgets_limit_chk", sql`${t.limitMicros} > 0`),
		check("workspace_budgets_epoch_chk", sql`${t.configEpoch} <= 2147483646`),
	]
);

/** Explicit access for non-default organization workspaces. */
export const workspaceMembershipsTable = mysqlTable(
	"workspace_memberships",
	{
		id: varchar("id", { length: 64 }).primaryKey(),
		membershipKey: varchar("membership_key", { length: 64 }).notNull().unique(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		subject: varchar("subject", { length: 255 }).notNull(),
		role: varchar("role", { length: COL.STATUS }).notNull().default("member"),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		grantedBySubject: varchar("granted_by_subject", { length: 255 }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		check(
			"workspace_memberships_role_chk",
			sql`${t.role} IN ('admin', 'member')`
		),
		check(
			"workspace_memberships_status_chk",
			sql`${t.status} IN ('active', 'removed')`
		),
		check(
			"workspace_memberships_subject_chk",
			sql`CHAR_LENGTH(${t.subject}) BETWEEN 1 AND 255`
		),
		check(
			"workspace_memberships_key_chk",
			sql`CHAR_LENGTH(${t.membershipKey}) = 64`
		),
	]
);

export const apiKeysTable = mysqlTable("api_keys", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	key: varchar("key", { length: COL.KEY }).notNull(),
	keyHash: varchar("key_hash", { length: 80 }),
	keyPreview: varchar("key_preview", { length: 64 }),
	userId: varchar("user_id", { length: COL.USER_ID }).notNull(),
	workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
		.notNull()
		.references(() => workspacesTable.id, { onDelete: "cascade" }),
	name: varchar("name", { length: COL.NAME }),
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	metadata: text("metadata"),
	expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }),
	limitMicros: bigint("limit_micros", { mode: "number" }),
	limitReset: varchar("limit_reset", { length: 16 }),
	includeByokInLimit: tinyint("include_byok_in_limit").notNull().default(0),
	limitEpoch: int("limit_epoch").notNull().default(0),
	lastUsedAt: timestamp("last_used_at", { fsp: 6, mode: "string" }),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
});

export const managementApiKeysTable = mysqlTable(
	"management_api_keys",
	{
		id: varchar("id", { length: 64 }).primaryKey(),
		keyHash: varchar("key_hash", { length: 71 }).notNull().unique(),
		keyPreview: varchar("key_preview", { length: 64 }).notNull(),
		accountType: varchar("account_type", { length: COL.STATUS }).notNull(),
		personalOwnerUserId: varchar("personal_owner_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "cascade" }),
		organizationId: varchar("organization_id", { length: 255 }).references(
			() => organizationsTable.id,
			{ onDelete: "cascade" }
		),
		name: varchar("name", { length: 128 }).notNull(),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }),
		lastUsedAt: datetime("last_used_at", { fsp: 6, mode: "string" }),
		createdByUserId: varchar("created_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		index("idx_management_api_keys_personal_created").on(
			t.personalOwnerUserId,
			t.createdAt
		),
		index("idx_management_api_keys_organization_created").on(
			t.organizationId,
			t.createdAt
		),
		index("idx_management_api_keys_status_expiry").on(t.status, t.expiresAt),
		check(
			"management_api_keys_hash_chk",
			sql`CHAR_LENGTH(${t.keyHash}) = 71 AND ${t.keyHash} REGEXP '^sha256:[0-9a-f]{64}$'`
		),
		check(
			"management_api_keys_name_chk",
			sql`CHAR_LENGTH(${t.name}) BETWEEN 1 AND 128`
		),
		check(
			"management_api_keys_status_chk",
			sql`${t.status} IN ('active', 'revoked')`
		),
		check(
			"management_api_keys_account_type_chk",
			sql`${t.accountType} IN ('personal', 'organization')`
		),
		check(
			"management_api_keys_account_owner_chk",
			sql`(
			(${t.accountType} = 'personal' AND ${t.personalOwnerUserId} IS NOT NULL AND ${t.organizationId} IS NULL)
			OR (${t.accountType} = 'organization' AND ${t.personalOwnerUserId} IS NULL AND ${t.organizationId} IS NOT NULL)
		)`
		),
	]
);

export const byokKeysTable = mysqlTable(
	"byok_keys",
	{
		id: varchar("id", { length: 64 }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		provider: varchar("provider", { length: 128 }).notNull(),
		name: varchar("name", { length: 255 }),
		apiKeyEncrypted: text("api_key_encrypted").notNull(),
		label: varchar("label", { length: 512 }).notNull(),
		disabled: tinyint("disabled").notNull().default(0),
		isFallback: tinyint("is_fallback").notNull().default(0),
		alwaysUseForProvider: tinyint("always_use_for_provider").notNull().default(0),
		alwaysUseForMatchingModels: tinyint("always_use_for_matching_models").notNull().default(0),
		sortOrder: int("sort_order", { unsigned: true }).notNull(),
		allowedModelsJson: text("allowed_models_json"),
		allowedUserIdsJson: text("allowed_user_ids_json"),
		allowedApiKeyHashesJson: text("allowed_api_key_hashes_json"),
		createdByManagementKeyId: varchar("created_by_management_key_id", {
			length: 64,
		}).references(() => managementApiKeysTable.id, { onDelete: "set null" }),
		deletedAt: datetime("deleted_at", { fsp: 6, mode: "string" }),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		index("idx_byok_keys_workspace_created").on(t.workspaceId, t.createdAt),
		index("idx_byok_keys_runtime").on(
			t.workspaceId,
			t.provider,
			t.disabled,
			t.isFallback,
			t.sortOrder
		),
		index("idx_byok_keys_creator").on(t.createdByManagementKeyId, t.createdAt),
		check(
			"byok_keys_always_use_priority_chk",
			sql`(${t.alwaysUseForProvider} = 0 AND ${t.alwaysUseForMatchingModels} = 0) OR ${t.isFallback} = 0`
		),
		check(
			"byok_keys_shared_capacity_policy_exclusive_chk",
			sql`${t.alwaysUseForProvider} = 0 OR ${t.alwaysUseForMatchingModels} = 0`
		),
	]
);

export const providersTable = mysqlTable("providers", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	name: varchar("name", { length: COL.PROVIDER_NAME }).notNull(),
	/** JSON: `{ openai?: { base?, endpoints? }, … }` */
	endpoints: text("endpoints"),
	/** 该上游账号唯一 API Key */
	apiKey: text("api_key").notNull().default(""),
	/** `active` | `disabled` */
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	description: text("description"),
	/** 非空时该 provider 接受对应用户共享密钥池注入（openai/anthropic/zhipu/deepseek） */
	sharedChannelType: varchar("shared_channel_type", { length: COL.VENDOR }),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

export const modelsTable = mysqlTable("models", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	displayName: text("display_name"),
	vendor: varchar("vendor", { length: COL.VENDOR }).notNull().default("other"),
	contextWindow: int("context_window"),
	/** Chat completion max output tokens; NULL for image-generation models. */
	maxTokens: int("max_tokens").default(8192),
	pricingProfile: text("pricing_profile"),
	description: text("description"),
	metadata: text("metadata"),
	inputModalities: text("input_modalities"),
	outputModalities: text("output_modalities"),
	releasedAt: text("released_at"),
	/** 路由策略配置 JSON；NULL=使用全局/代码默认 */
	routePolicy: text("route_policy"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

/** Endpoint-first provider implementation and its verified public capabilities. */
export const modelEndpointsTable = mysqlTable(
	"model_endpoints",
	{
		/** 191 keeps the endpoint/route-target composite PK below InnoDB's key limit. */
		id: varchar("id", { length: COL.ENDPOINT_ID }).primaryKey(),
		modelId: varchar("model_id", { length: COL.MODEL_ID })
			.notNull()
			.references(() => modelsTable.id, { onDelete: "cascade" }),
		providerId: varchar("provider_id", { length: COL.PROVIDER_ID })
			.notNull()
			.references(() => providersTable.id, { onDelete: "cascade" }),
		providerSlug: varchar("provider_slug", { length: 255 }).notNull(),
		tag: varchar("tag", { length: COL.TAG }).notNull(),
		/** Exact logical UNIQUE(model_id, provider_id, tag), without prefix indexes. */
		endpointIdentityKey: varchar("endpoint_identity_key", {
			length: 64,
		}).generatedAlwaysAs(
			sql`SHA2(CONCAT(CHAR_LENGTH(model_id), ':', model_id, CHAR_LENGTH(provider_id), ':', provider_id, CHAR_LENGTH(tag), ':', tag), 256)`,
			{ mode: "stored" }
		),
		endpointClass: varchar("endpoint_class", { length: COL.STATUS }),
		region: varchar("region", { length: 64 }),
		contextLength: int("context_length"),
		maxPromptTokens: int("max_prompt_tokens"),
		maxCompletionTokens: int("max_completion_tokens"),
		quantization: varchar("quantization", { length: COL.STATUS }),
		supportedParameters: text("supported_parameters").notNull().default("[]"),
		pricing: text("pricing").notNull().default("{}"),
		supportsToolChoice: text("supports_tool_choice")
			.notNull()
			.default('{"auto":null,"function":null,"none":null,"required":null}'),
		imageCapabilities: text("image_capabilities").notNull().default("{}"),
		audioCapabilities: text("audio_capabilities").notNull().default("{}"),
		/** Nullable boolean: NULL means the capability has not been verified. */
		supportsImplicitCaching: tinyint("supports_implicit_caching"),
		/** Nullable boolean: NULL means the capability has not been verified. */
		supportsVoiceCloning: tinyint("supports_voice_cloning"),
		evidenceUrl: text("evidence_url"),
		verifiedBy: varchar("verified_by", { length: COL.ID }),
		verifiedAt: timestamp("verified_at", { fsp: 6, mode: "string" }),
		expiresAt: timestamp("expires_at", { fsp: 6, mode: "string" }),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("draft"),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_model_endpoints_identity").on(t.endpointIdentityKey),
		index("idx_model_endpoints_provider").on(t.providerId),
		index("idx_model_endpoints_model_status").on(t.modelId, t.status),
		check(
			"model_endpoints_status_chk",
			sql`${t.status} IN ('draft', 'verified', 'disabled')`
		),
		check(
			"model_endpoints_implicit_caching_chk",
			sql`${t.supportsImplicitCaching} IS NULL OR ${t.supportsImplicitCaching} IN (0, 1)`
		),
		check(
			"model_endpoints_voice_cloning_chk",
			sql`${t.supportsVoiceCloning} IS NULL OR ${t.supportsVoiceCloning} IN (0, 1)`
		),
		check(
			"model_endpoints_context_length_chk",
			sql`${t.contextLength} IS NULL OR ${t.contextLength} > 0`
		),
		check(
			"model_endpoints_max_prompt_tokens_chk",
			sql`${t.maxPromptTokens} IS NULL OR ${t.maxPromptTokens} > 0`
		),
		check(
			"model_endpoints_max_completion_tokens_chk",
			sql`${t.maxCompletionTokens} IS NULL OR ${t.maxCompletionTokens} > 0`
		),
	]
);

export const routePoolsTable = mysqlTable("route_pools", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	modelId: varchar("model_id", { length: COL.MODEL_ID }).notNull(),
	routeGroup: varchar("route_group", { length: COL.ROUTE_GROUP })
		.notNull()
		.default("default"),
	name: varchar("name", { length: COL.NAME }).notNull(),
	strategy: varchar("strategy", { length: COL.STATUS }),
	/** JSON map: {"10":"hash_affinity","0":"weight_priority"} — per-priority-tier overrides */
	tierStrategies: text("tier_strategies"),
	stickyEnabled: int("sticky_enabled").notNull().default(0),
	stickyIdleTtlSeconds: int("sticky_idle_ttl_seconds").notNull().default(3600),
	/** Bumped on sticky config change to invalidate existing bindings */
	stickyEpoch: int("sticky_epoch").notNull().default(0),
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
});

export const routePoolStickyBindingsTable = mysqlTable(
	"route_pool_sticky_bindings",
	{
		routePoolId: varchar("route_pool_id", { length: COL.ID }).notNull(),
		affinityHash: varchar("affinity_hash", { length: 64 }).notNull(),
		routeTargetId: varchar("route_target_id", { length: COL.ID }).notNull(),
		bindingToken: varchar("binding_token", { length: 64 }).notNull(),
		poolEpoch: int("pool_epoch").notNull().default(0),
		expiresAt: timestamp("expires_at", { fsp: 6, mode: "string" }).notNull(),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	}
);

export const modelSurfacesTable = mysqlTable("model_surfaces", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	modelId: varchar("model_id", { length: COL.MODEL_ID }).notNull(),
	routeGroup: varchar("route_group", { length: COL.ROUTE_GROUP })
		.notNull()
		.default("default"),
	requestProtocol: varchar("request_protocol", {
		length: COL.STATUS,
	}).notNull(),
	requestOperation: varchar("request_operation", { length: 64 })
		.notNull()
		.default("*"),
	routePoolId: varchar("route_pool_id", { length: COL.ID }).notNull(),
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
});

export const modelRoutesTable = mysqlTable("model_routes", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	modelId: varchar("model_id", { length: COL.MODEL_ID }).notNull(),
	providerId: varchar("provider_id", { length: COL.PROVIDER_ID }).notNull(),
	providerModelName: text("provider_model_name").notNull(),
	priority: int("priority").notNull().default(0),
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	routeGroup: varchar("route_group", { length: COL.ROUTE_GROUP })
		.notNull()
		.default("default"),
	/** 同 priority 层内权重 */
	weight: int("weight").notNull().default(1),
	priceOverride: text("price_override"),
	customParams: text("custom_params"),
	routingMetadata: text("routing_metadata"),
	upstreamProtocol: varchar("upstream_protocol", { length: COL.STATUS })
		.notNull()
		.default("openai"),
	routePoolId: varchar("route_pool_id", { length: COL.ID }),
	upstreamOperation: varchar("upstream_operation", { length: 64 })
		.notNull()
		.default("*"),
	adapter: varchar("adapter", { length: 128 }).notNull().default("passthrough"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

/** A route target belongs to at most one endpoint during the migration. */
export const modelEndpointRoutesTable = mysqlTable(
	"model_endpoint_routes",
	{
		endpointId: varchar("endpoint_id", { length: COL.ENDPOINT_ID })
			.notNull()
			.references(() => modelEndpointsTable.id, { onDelete: "cascade" }),
		routeTargetId: varchar("route_target_id", { length: COL.ID })
			.notNull()
			.references(() => modelRoutesTable.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		/** SHA-256 of the exact route/provider subject verified for this binding. */
		subjectFingerprint: asciiBinarySha256("subject_fingerprint"),
	},
	(t) => [
		primaryKey({ columns: [t.endpointId, t.routeTargetId] }),
		uniqueIndex("uk_model_endpoint_routes_target").on(t.routeTargetId),
		check(
			"model_endpoint_routes_subject_fingerprint_chk",
			sql`${t.subjectFingerprint} IS NULL OR ${t.subjectFingerprint} REGEXP '^[0-9a-f]{64}$'`
		),
	]
);

export const apiKeyRequestLogsTable = mysqlTable("api_key_request_logs", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	userId: varchar("user_id", { length: COL.USER_ID }),
	apiKeyId: varchar("api_key_id", { length: COL.ID }),
	workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID }).references(
		() => workspacesTable.id,
		{ onDelete: "set null" }
	),
	userEmail: varchar("user_email", { length: COL.EMAIL }),
	modelId: varchar("model_id", { length: COL.ID }),
	providerId: varchar("provider_id", { length: COL.ID }),
	providerModelName: text("provider_model_name"),
	modelName: text("model_name"),
	providerName: text("provider_name"),
	requestBody: text("request_body"),
	upstreamRequestBody: text("upstream_request_body"),
	requestProtocol: varchar("request_protocol", { length: COL.STATUS }),
	requestOperation: varchar("request_operation", { length: 64 }),
	upstreamProtocol: varchar("upstream_protocol", { length: COL.STATUS })
		.notNull()
		.default("openai"),
	upstreamOperation: varchar("upstream_operation", { length: 64 }),
	modelSurfaceId: varchar("model_surface_id", { length: COL.ID }),
	routePoolId: varchar("route_pool_id", { length: COL.ID }),
	routeTargetId: varchar("route_target_id", { length: COL.ID }),
	adapter: varchar("adapter", { length: 128 }),
	routeTrace: text("route_trace"),
	inputTokens: int("input_tokens").notNull().default(0),
	outputTokens: int("output_tokens").notNull().default(0),
	cacheReadTokens: int("cache_read_tokens").notNull().default(0),
	cacheWriteTokens: int("cache_write_tokens").notNull().default(0),
	reasoningTokens: int("reasoning_tokens").notNull().default(0),
	totalTokens: int("total_tokens").notNull().default(0),
	nativeTokensPrompt: bigint("native_tokens_prompt", { mode: "number", unsigned: true }),
	nativeTokensCompletion: bigint("native_tokens_completion", { mode: "number", unsigned: true }),
	nativeTokensCached: bigint("native_tokens_cached", { mode: "number", unsigned: true }),
	nativeTokensReasoning: bigint("native_tokens_reasoning", { mode: "number", unsigned: true }),
	nativeTokensCompletionImages: bigint("native_tokens_completion_images", { mode: "number", unsigned: true }),
	meteredCost: decimal("metered_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	standardCost: decimal("standard_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	chargedCost: decimal("charged_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	/** Guardrail/user budget debit in integer micro-units; NULL marks a pre-ledger row. */
	budgetChargedMicros: bigint("budget_charged_micros", { mode: "number" }),
	budgetAccountedAt: datetime("budget_accounted_at", {
		fsp: 6,
		mode: "string",
	}),
	routeGroup: varchar("route_group", { length: COL.ROUTE_GROUP })
		.notNull()
		.default("default"),
	status: varchar("status", { length: COL.STATUS })
		.notNull()
		.default("success"),
	latencyMs: int("latency_ms"),
	gatewayOverheadMs: int("gateway_overhead_ms"),
	upstreamResponseMs: int("upstream_response_ms"),
	finalUpstreamHeadersMs: int("final_upstream_headers_ms"),
	firstReasoningTokenMs: int("first_reasoning_token_ms"),
	firstTokenMs: int("first_token_ms"),
	streamDurationMs: int("stream_duration_ms"),
	upstreamAttemptCount: int("upstream_attempt_count"),
	upstreamFailoverCount: int("upstream_failover_count"),
	timingMetadata: text("timing_metadata"),
	errorMessage: text("error_message"),
	rawUsage: text("raw_usage"),
	/** 计费审计 JSON 字符串；结构见 `db/pricing-audit.ts` */
	pricingAudit: text("pricing_audit"),
	providerKeyId: varchar("provider_key_id", { length: COL.ID }),
	providerKeyLabel: varchar("provider_key_label", { length: COL.NAME }),
	providerKeyFingerprint: varchar("provider_key_fingerprint", { length: 64 }),
	upstreamRequestId: varchar("upstream_request_id", { length: 200 }),
	upstreamMessageId: varchar("upstream_message_id", { length: 200 }),
	billingKind: varchar("billing_kind", { length: 32 }),
	inputImageCount: int("input_image_count").notNull().default(0),
	outputImageCount: int("output_image_count").notNull().default(0),
	audioDurationSeconds: double("audio_duration_seconds"),
	audioCharacters: int("audio_characters"),
	sessionId: varchar("session_id", { length: 256 }),
	requestOrigin: varchar("request_origin", { length: 512 }),
	httpReferer: varchar("http_referer", { length: 512 }),
	userAgent: varchar("user_agent", { length: 512 }),
	responseStreamed: tinyint("response_streamed"),
	dataRegion: varchar("data_region", { length: 16 }),
	isByok: tinyint("is_byok"),
	chargedCostUsd: decimal("charged_cost_usd", { precision: 24, scale: 12 }),
	upstreamInferenceCostUsd: decimal("upstream_inference_cost_usd", { precision: 24, scale: 12 }),
	serviceTier: varchar("service_tier", { length: 16 }),
	finishReason: varchar("finish_reason", { length: 16 }),
	nativeFinishReason: varchar("native_finish_reason", { length: 128 }),
	providerResponses: text("provider_responses"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

export const providerAttemptAvailabilityTable = mysqlTable(
	"provider_attempt_availability",
	{
		requestLogId: varchar("request_log_id", { length: COL.ID }).notNull().references(
			() => apiKeyRequestLogsTable.id,
			{ onDelete: "cascade" }
		),
		attemptIndex: int("attempt_index").notNull(),
		routeTargetId: varchar("route_target_id", { length: COL.ID }).notNull(),
		providerId: varchar("provider_id", { length: COL.ID }).notNull(),
		outcome: varchar("outcome", { length: 16 }).notNull(),
		reason: varchar("reason", { length: 32 }).notNull(),
		httpStatus: int("http_status"),
		observedAt: datetime("observed_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.requestLogId, t.attemptIndex] }),
		index("idx_provider_attempt_availability_route_observed")
			.on(t.routeTargetId, t.observedAt),
		index("idx_provider_attempt_availability_observed").on(t.observedAt),
		check(
			"provider_attempt_availability_attempt_index_chk",
			sql`${t.attemptIndex} BETWEEN 1 AND 128`
		),
		check(
			"provider_attempt_availability_outcome_chk",
			sql`${t.outcome} IN ('available', 'unavailable', 'excluded')`
		),
		check(
			"provider_attempt_availability_reason_chk",
			sql`${t.reason} IN ('accepted', 'provider_http_error', 'rate_limited', 'network_error', 'invalid_response', 'client_error', 'client_cancelled', 'unknown')`
		),
		check(
			"provider_attempt_availability_http_status_chk",
			sql`${t.httpStatus} IS NULL OR ${t.httpStatus} BETWEEN 100 AND 599`
		),
	]
);

export const generationFeedbackTable = mysqlTable(
	"generation_feedback",
	{
		id: varchar("id", { length: 40 }).primaryKey(),
		generationId: varchar("generation_id", { length: COL.ID }).notNull().references(
			() => apiKeyRequestLogsTable.id,
			{ onDelete: "cascade" }
		),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID }).notNull().references(
			() => workspacesTable.id,
			{ onDelete: "cascade" }
		),
		managementApiKeyId: varchar("management_api_key_id", { length: 64 }).notNull().references(
			() => managementApiKeysTable.id,
			{ onDelete: "cascade" }
		),
		accountType: varchar("account_type", { length: COL.STATUS }).notNull(),
		personalOwnerUserId: varchar("personal_owner_user_id", { length: COL.USER_ID }).references(
			() => usersTable.id,
			{ onDelete: "cascade" }
		),
		organizationId: varchar("organization_id", { length: 255 }).references(
			() => organizationsTable.id,
			{ onDelete: "cascade" }
		),
		category: varchar("category", { length: COL.STATUS }).notNull(),
		comment: text("comment"),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		index("idx_generation_feedback_generation_created").on(t.generationId, t.createdAt),
		index("idx_generation_feedback_personal_created").on(t.personalOwnerUserId, t.createdAt),
		index("idx_generation_feedback_organization_created").on(t.organizationId, t.createdAt),
		check("generation_feedback_id_chk", sql`CHAR_LENGTH(${t.id}) = 40 AND LEFT(${t.id}, 4) = 'gfb_'`),
		check("generation_feedback_category_chk", sql`${t.category} IN ('latency', 'incoherence', 'incorrect_response', 'formatting', 'billing', 'api_error', 'other')`),
		check("generation_feedback_comment_chk", sql`${t.comment} IS NULL OR CHAR_LENGTH(${t.comment}) <= 1000`),
		check(
			"generation_feedback_account_owner_chk",
			sql`(
			(${t.accountType} = 'personal' AND ${t.personalOwnerUserId} IS NOT NULL AND ${t.organizationId} IS NULL)
			OR (${t.accountType} = 'organization' AND ${t.personalOwnerUserId} IS NULL AND ${t.organizationId} IS NOT NULL)
			)`
		),
	]
);

/** 匿名公开排行专用的分片日汇总；公开请求不得回退扫描 api_key_request_logs。 */
export const publicModelDailyStatsTable = mysqlTable(
	"public_model_daily_stats",
	{
		statDate: varchar("stat_date", { length: 10 }).notNull(),
		modelId: varchar("model_id", { length: COL.MODEL_ID }).notNull(),
		shard: int("shard").notNull(),
		requestCount: bigint("request_count", { mode: "number" })
			.notNull()
			.default(0),
		successCount: bigint("success_count", { mode: "number" })
			.notNull()
			.default(0),
		errorCount: bigint("error_count", { mode: "number" }).notNull().default(0),
		outputTokens: bigint("output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		totalTokens: bigint("total_tokens", { mode: "number" })
			.notNull()
			.default(0),
		latencyTotalMs: bigint("latency_total_ms", { mode: "number" })
			.notNull()
			.default(0),
		latencySampleCount: bigint("latency_sample_count", { mode: "number" })
			.notNull()
			.default(0),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_public_model_daily_stats").on(
			t.statDate,
			t.modelId,
			t.shard
		),
		check("public_model_daily_stats_shard_chk", sql`shard >= 0 AND shard < 16`),
	]
);

export const systemConfigTable = mysqlTable("system_config", {
	key: varchar("key", { length: COL.SYSCONFIG_KEY }).primaryKey(),
	value: text("value").notNull(),
	description: text("description"),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
});

/** OpenRouter-compatible request presets with immutable designated versions. */
export const requestPresetsTable = mysqlTable(
	"request_presets",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		workspaceKey: varchar("workspace_key", { length: 64 }).notNull(),
		ownerUserId: varchar("owner_user_id", { length: COL.USER_ID })
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		slug: varchar("slug", { length: 128 }).notNull(),
		name: varchar("name", { length: COL.NAME }).notNull(),
		description: text("description"),
		visibility: varchar("visibility", { length: 16 })
			.notNull()
			.default("private"),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		designatedVersion: int("designated_version").notNull().default(1),
		latestVersion: int("latest_version").notNull().default(1),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_request_presets_workspace_slug").on(t.workspaceKey, t.slug),
		check(
			"request_presets_visibility_chk",
			sql`${t.visibility} IN ('private', 'public')`
		),
		check(
			"request_presets_status_chk",
			sql`${t.status} IN ('active', 'archived')`
		),
		check(
			"request_presets_versions_chk",
			sql`${t.designatedVersion} >= 1 AND ${t.latestVersion} >= ${t.designatedVersion}`
		),
	]
);

export const requestPresetVersionsTable = mysqlTable(
	"request_preset_versions",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		presetId: varchar("preset_id", { length: COL.ID })
			.notNull()
			.references(() => requestPresetsTable.id, { onDelete: "cascade" }),
		version: int("version").notNull(),
		systemPrompt: text("system_prompt"),
		configJson: text("config_json").notNull(),
		createdByUserId: varchar("created_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [uniqueIndex("uk_request_preset_versions").on(t.presetId, t.version)]
);

export const guardrailsTable = mysqlTable(
	"guardrails",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		workspaceKey: varchar("workspace_key", { length: 64 }).notNull(),
		ownerUserId: varchar("owner_user_id", { length: COL.USER_ID })
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		name: varchar("name", { length: COL.NAME }).notNull(),
		description: text("description"),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("active"),
		isWorkspaceDefault: tinyint("is_workspace_default").notNull().default(0),
		isAccountDefault: tinyint("is_account_default").notNull().default(0),
		accountScopeKey: varchar("account_scope_key", { length: COL.WORKSPACE_ID }),
		workspaceDefaultKey: varchar("workspace_default_key", { length: 64 })
			.generatedAlwaysAs(
				sql`CASE WHEN is_workspace_default = TRUE THEN SHA2(workspace_id, 256) ELSE NULL END`,
				{ mode: "stored" }
			),
		designatedVersion: int("designated_version").notNull().default(1),
		latestVersion: int("latest_version").notNull().default(1),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_guardrails_id_workspace").on(t.id, t.workspaceKey),
		uniqueIndex("uk_guardrails_workspace_default").on(t.workspaceDefaultKey),
		uniqueIndex("uk_guardrails_account_default").on(t.accountScopeKey),
		check(
			"guardrails_default_kind_chk",
			sql`NOT (${t.isWorkspaceDefault} = TRUE AND ${t.isAccountDefault} = TRUE)`
		),
		check(
			"guardrails_account_scope_key_chk",
			sql`(${t.isAccountDefault} = TRUE AND ${t.accountScopeKey} IS NOT NULL) OR (${t.isAccountDefault} = FALSE AND ${t.accountScopeKey} IS NULL)`
		),
		check("guardrails_status_chk", sql`${t.status} IN ('active', 'archived')`),
		check(
			"guardrails_versions_chk",
			sql`${t.designatedVersion} >= 1 AND ${t.latestVersion} >= ${t.designatedVersion}`
		),
	]
);

export const guardrailVersionsTable = mysqlTable(
	"guardrail_versions",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		guardrailId: varchar("guardrail_id", { length: COL.ID })
			.notNull()
			.references(() => guardrailsTable.id, { onDelete: "cascade" }),
		version: int("version").notNull(),
		configJson: text("config_json").notNull(),
		createdByUserId: varchar("created_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [uniqueIndex("uk_guardrail_versions").on(t.guardrailId, t.version)]
);

export const guardrailAssignmentsTable = mysqlTable(
	"guardrail_assignments",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		workspaceKey: varchar("workspace_key", { length: 64 }).notNull(),
		guardrailId: varchar("guardrail_id", { length: COL.ID })
			.notNull()
			.references(() => guardrailsTable.id, { onDelete: "cascade" }),
		scopeType: varchar("scope_type", { length: 16 }).notNull(),
		scopeId: varchar("scope_id", { length: COL.ID }).notNull(),
		createdByUserId: varchar("created_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		managementSource: varchar("management_source", { length: 32 }),
		assignedByUserId: varchar("assigned_by_user_id", {
			length: COL.USER_ID,
		}).references(() => usersTable.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_guardrail_assignments_workspace_scope").on(
			t.workspaceKey,
			t.scopeType,
			t.scopeId
		),
		index("idx_guardrail_assignments_assigned_by").on(t.assignedByUserId),
		index("idx_guardrail_assignments_management_list").on(
			t.workspaceKey,
			t.managementSource,
			t.createdAt,
			t.id
		),
		check(
			"guardrail_assignments_scope_chk",
			sql`${t.scopeType} IN ('user', 'api_key', 'workspace')`
		),
	]
);

export const guardrailBudgetWindowsTable = mysqlTable(
	"guardrail_budget_windows",
	{
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		workspaceKey: varchar("workspace_key", { length: 64 }).notNull(),
		scopeType: varchar("scope_type", { length: 16 }).notNull(),
		scopeId: varchar("scope_id", { length: COL.ID }).notNull(),
		period: varchar("period", { length: 16 }).notNull(),
		periodStart: datetime("period_start", { fsp: 6, mode: "string" }).notNull(),
		periodEnd: datetime("period_end", { fsp: 6, mode: "string" }).notNull(),
		unreservedMicros: bigint("unreserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		reservedMicros: bigint("reserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		seedRequestId: varchar("seed_request_id", { length: 128 }),
		seededAt: datetime("seeded_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		primaryKey({
			columns: [
				t.workspaceKey,
				t.scopeType,
				t.scopeId,
				t.period,
				t.periodStart,
			],
		}),
		check(
			"guardrail_budget_windows_scope_chk",
			sql`${t.scopeType} IN ('user', 'api_key', 'workspace')`
		),
		check(
			"guardrail_budget_windows_period_chk",
			sql`${t.period} IN ('daily', 'weekly', 'monthly', 'lifetime')`
		),
		check(
			"guardrail_budget_windows_amount_chk",
			sql`${t.unreservedMicros} >= 0 AND ${t.settledMicros} >= 0 AND ${t.reservedMicros} >= 0`
		),
	]
);

export const guardrailBudgetReservationsTable = mysqlTable(
	"guardrail_budget_reservations",
	{
		id: varchar("id", { length: COL.ID }).primaryKey(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID })
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		workspaceKey: varchar("workspace_key", { length: 64 }).notNull(),
		requestId: varchar("request_id", { length: 128 }).notNull(),
		assignmentId: varchar("assignment_id", { length: COL.ID }).notNull(),
		guardrailId: varchar("guardrail_id", { length: COL.ID }).notNull(),
		guardrailVersion: int("guardrail_version").notNull(),
		scopeType: varchar("scope_type", { length: 16 }).notNull(),
		scopeId: varchar("scope_id", { length: COL.ID }).notNull(),
		period: varchar("period", { length: 16 }).notNull(),
		periodStart: datetime("period_start", { fsp: 6, mode: "string" }).notNull(),
		periodEnd: datetime("period_end", { fsp: 6, mode: "string" }).notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		settlementBasis: varchar("settlement_basis", { length: 32 })
			.notNull()
			.default("charged"),
		state: varchar("state", { length: 16 }).notNull().default("reserved"),
		expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }).notNull(),
		dispatchedAt: datetime("dispatched_at", { fsp: 6, mode: "string" }),
		terminalAt: datetime("terminal_at", { fsp: 6, mode: "string" }),
		terminalReason: varchar("terminal_reason", { length: 128 }),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_guardrail_budget_reservation_request_assignment").on(
			t.requestId,
			t.assignmentId
		),
		check(
			"guardrail_budget_reservations_scope_chk",
			sql`${t.scopeType} IN ('user', 'api_key')`
		),
		check(
			"guardrail_budget_reservations_period_chk",
			sql`${t.period} IN ('daily', 'weekly', 'monthly', 'lifetime')`
		),
		check(
			"guardrail_budget_reservations_amount_chk",
			sql`${t.limitMicros} >= 0 AND ${t.reservedMicros} > 0 AND ${t.settledMicros} >= 0`
		),
		check(
			"guardrail_budget_reservations_state_chk",
			sql`${t.state} IN ('reserved', 'dispatched', 'settled', 'released', 'expired')`
		),
		check(
			"guardrail_budget_reservations_settlement_basis_chk",
			sql`${t.settlementBasis} IN ('charged', 'gateway_key_route')`
		),
	]
);

export const userBudgetReservationsTable = mysqlTable(
	"user_budget_reservations",
	{
		requestId: varchar("request_id", { length: 128 }).primaryKey(),
		userId: varchar("user_id", { length: COL.USER_ID }).notNull(),
		apiKeyId: varchar("api_key_id", { length: COL.ID }).notNull(),
		budgetEpoch: bigint("budget_epoch", { mode: "number" }).notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		state: varchar("state", { length: 16 }).notNull().default("reserved"),
		expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }).notNull(),
		dispatchedAt: datetime("dispatched_at", { fsp: 6, mode: "string" }),
		terminalAt: datetime("terminal_at", { fsp: 6, mode: "string" }),
		terminalReason: varchar("terminal_reason", { length: 128 }),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		check(
			"user_budget_reservations_epoch_chk",
			sql`${t.budgetEpoch} >= 0 AND ${t.budgetEpoch} <= 9007199254740991`
		),
		check(
			"user_budget_reservations_amount_chk",
			sql`${t.limitMicros} >= 0 AND ${t.limitMicros} <= 9007199254740991 AND ${t.reservedMicros} > 0 AND ${t.reservedMicros} <= 9007199254740991 AND ${t.settledMicros} >= 0 AND ${t.settledMicros} <= 9007199254740991`
		),
		check(
			"user_budget_reservations_state_chk",
			sql`${t.state} IN ('reserved', 'dispatched', 'settled', 'released', 'expired')`
		),
		check(
			"user_budget_reservations_range_chk",
			sql`${t.expiresAt} > ${t.createdAt}`
		),
	]
);

export const routeDataPoliciesTable = mysqlTable(
	"route_data_policies",
	{
		routeTargetId: varchar("route_target_id", { length: COL.ID })
			.primaryKey()
			.references(() => modelRoutesTable.id, { onDelete: "cascade" }),
		subjectFingerprint: asciiBinarySha256("subject_fingerprint"),
		retentionDays: int("retention_days"),
		trainingAllowed: int("training_allowed").notNull().default(1),
		zdrSupported: int("zdr_supported").notNull().default(0),
		evidenceUrl: text("evidence_url"),
		verifiedBy: varchar("verified_by", { length: COL.ID }),
		verifiedAt: timestamp("verified_at", { fsp: 6, mode: "string" }),
		expiresAt: timestamp("expires_at", { fsp: 6, mode: "string" }),
		status: varchar("status", { length: 16 }).notNull().default("unknown"),
		invalidatedAt: timestamp("invalidated_at", { fsp: 6, mode: "string" }),
		invalidationReason: varchar("invalidation_reason", { length: 128 }),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		check(
			"route_data_policies_retention_chk",
			sql`${t.retentionDays} IS NULL OR ${t.retentionDays} >= 0`
		),
		check(
			"route_data_policies_status_chk",
			sql`${t.status} IN ('verified', 'expired', 'unknown')`
		),
		check(
			"route_data_policies_subject_fingerprint_chk",
			sql`${t.subjectFingerprint} IS NULL OR ${t.subjectFingerprint} REGEXP '^[0-9a-f]{64}$'`
		),
	]
);

export const routeDataPolicyAuditTable = mysqlTable("route_data_policy_audit", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	routeTargetId: varchar("route_target_id", { length: COL.ID }).references(
		() => modelRoutesTable.id,
		{ onDelete: "set null" }
	),
	snapshotJson: text("snapshot_json").notNull(),
	actorId: varchar("actor_id", { length: COL.ID }).notNull(),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

/** 用户维度审计：预算、资料等；扩展载荷见 `change_payload`。 */
export const userAuditLogsTable = mysqlTable("user_audit_logs", {
	id: varchar("id", { length: COL.ID }).primaryKey(),
	userId: varchar("user_id", { length: COL.USER_ID }),
	apiKeyId: varchar("api_key_id", { length: COL.ID }),
	eventType: varchar("event_type", { length: COL.EVENT_TYPE }).notNull(),
	actorType: varchar("actor_type", { length: COL.ACTOR_TYPE })
		.notNull()
		.default("system"),
	requestLogId: varchar("request_log_id", { length: COL.ID }),
	changePayload: text("change_payload"),
	beforeUserSnapshot: text("before_user_snapshot"),
	afterUserSnapshot: text("after_user_snapshot"),
	changedFields: text("changed_fields"),
	correlationId: varchar("correlation_id", { length: COL.ID }),
	source: varchar("source", { length: 128 }),
	actorId: varchar("actor_id", { length: COL.ID }),
	reasonCode: varchar("reason_code", { length: 128 }),
	reasonText: text("reason_text"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
});

export const adminApiKeysTable = mysqlTable("admin_api_keys", {
	id: varchar("id", { length: 128 }).primaryKey(),
	name: varchar("name", { length: 255 }).notNull().unique(),
	description: text("description"),
	secretKey: varchar("secret_key", { length: COL.KEY }).notNull().unique(),
	secretKeyHash: varchar("secret_key_hash", { length: 80 }),
	keyPrefix: varchar("key_prefix", { length: 32 }).notNull(),
	permissionsJson: text("permissions_json").notNull(),
	status: varchar("status", { length: COL.STATUS }).notNull().default("active"),
	lastUsedAt: timestamp("last_used_at", { fsp: 6, mode: "string" }),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	revokedAt: timestamp("revoked_at", { fsp: 6, mode: "string" }),
});

export const adminSessionsTable = mysqlTable("admin_sessions", {
	tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
	username: varchar("username", { length: 255 }).notNull(),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	expiresAt: timestamp("expires_at", { fsp: 6, mode: "string" }).notNull(),
});

/** 用户门户会话（`user_session` Cookie），独立于 admin_sessions。 */
export const portalSessionsTable = mysqlTable("portal_sessions", {
	tokenHash: varchar("token_hash", { length: 64 }).primaryKey(),
	/** CinaAuth OIDC `sub` */
	subject: varchar("subject", { length: 255 }).notNull(),
	email: varchar("email", { length: 512 }).notNull(),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	expiresAt: timestamp("expires_at", { fsp: 6, mode: "string" }).notNull(),
});

/** 卖家上架的个人上游 API Key（官方渠道白名单）。 */
export const sharedKeysTable = mysqlTable(
	"shared_keys",
	{
		id: varchar("id", { length: 128 }).primaryKey(),
		sellerUserId: varchar("seller_user_id", { length: COL.USER_ID }).notNull(),
		channelType: varchar("channel_type", { length: COL.VENDOR }).notNull(),
		apiKey: text("api_key").notNull(),
		keyFingerprint: varchar("key_fingerprint", { length: 128 }).notNull(),
		label: varchar("label", { length: COL.NAME }),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("validating"),
		sellerPriority: int("seller_priority").notNull().default(0),
		weight: int("weight").notNull().default(1),
		inputPrice: decimal("input_price", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		outputPrice: decimal("output_price", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		cacheReadPrice: decimal("cache_read_price", { precision: 18, scale: 6 }),
		cacheWritePrice: decimal("cache_write_price", { precision: 18, scale: 6 }),
		validatedAt: timestamp("validated_at", { fsp: 6, mode: "string" }),
		lastUsedAt: timestamp("last_used_at", { fsp: 6, mode: "string" }),
		lastFailureAt: timestamp("last_failure_at", { fsp: 6, mode: "string" }),
		failureReason: text("failure_reason"),
		servedInputTokens: bigint("served_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		servedOutputTokens: bigint("served_output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		earnedTotal: decimal("earned_total", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_shared_keys_seller_fingerprint").on(
			t.sellerUserId,
			t.keyFingerprint
		),
	]
);

/** 按请求结算的卖家收益流水；`request_log_id` 幂等。 */
export const sharedKeyEarningsTable = mysqlTable(
	"shared_key_earnings",
	{
		id: varchar("id", { length: 128 }).primaryKey(),
		requestLogId: varchar("request_log_id", { length: 128 }).notNull(),
		sharedKeyId: varchar("shared_key_id", { length: 128 }).notNull(),
		sellerUserId: varchar("seller_user_id", { length: COL.USER_ID }).notNull(),
		inputTokens: int("input_tokens").notNull().default(0),
		outputTokens: int("output_tokens").notNull().default(0),
		cacheReadTokens: int("cache_read_tokens").notNull().default(0),
		cacheWriteTokens: int("cache_write_tokens").notNull().default(0),
		grossAmount: decimal("gross_amount", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		platformFee: decimal("platform_fee", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		netAmount: decimal("net_amount", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		currency: varchar("currency", { length: 16 }).notNull().default("USD"),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [uniqueIndex("uk_shared_key_earnings_request_log").on(t.requestLogId)]
);

/** 卖家账本（1:1 users）。 */
export const userEarningsTable = mysqlTable("user_earnings", {
	userId: varchar("user_id", { length: COL.USER_ID }).primaryKey(),
	balance: decimal("balance", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lockedAmount: decimal("locked_amount", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lifetimeEarned: decimal("lifetime_earned", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lifetimeWithdrawn: decimal("lifetime_withdrawn", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	contributionValue: decimal("contribution_value", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	walletAddress: varchar("wallet_address", { length: 128 }),
	walletVerifiedAt: timestamp("wallet_verified_at", { fsp: 6, mode: "string" }),
	highestBadgeTier: int("highest_badge_tier").notNull().default(0),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
});

/** 链上 CINA-C 自动提现单。 */
export const withdrawalsTable = mysqlTable("withdrawals", {
	id: varchar("id", { length: 128 }).primaryKey(),
	userId: varchar("user_id", { length: COL.USER_ID }).notNull(),
	amount: decimal("amount", { precision: 18, scale: 6 }).notNull(),
	fee: decimal("fee", { precision: 18, scale: 6 }).notNull().default("0"),
	netAmount: decimal("net_amount", { precision: 18, scale: 6 }).notNull(),
	currency: varchar("currency", { length: 16 }).notNull().default("USD"),
	walletAddress: varchar("wallet_address", { length: 128 }).notNull(),
	status: varchar("status", { length: COL.STATUS })
		.notNull()
		.default("requested"),
	tokenAmount: decimal("token_amount", { precision: 18, scale: 6 }),
	txHash: varchar("tx_hash", { length: 128 }),
	chainId: int("chain_id"),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
	updatedAt: timestamp("updated_at", { fsp: 6, mode: "string" }).notNull(),
	confirmedAt: timestamp("confirmed_at", { fsp: 6, mode: "string" }),
});

/** cinachain CinaBadge 位阶徽章铸造记录。 */
export const nftMintsTable = mysqlTable(
	"nft_mints",
	{
		id: varchar("id", { length: 128 }).primaryKey(),
		userId: varchar("user_id", { length: COL.USER_ID }).notNull(),
		badgeTokenId: int("badge_token_id").notNull(),
		tierName: varchar("tier_name", { length: COL.VENDOR }).notNull(),
		walletAddress: varchar("wallet_address", { length: 128 }).notNull(),
		status: varchar("status", { length: COL.STATUS })
			.notNull()
			.default("pending"),
		txHash: varchar("tx_hash", { length: 128 }),
		chainId: int("chain_id"),
		valueSnapshot: decimal("value_snapshot", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at", { fsp: 6, mode: "string" }).notNull(),
		confirmedAt: timestamp("confirmed_at", { fsp: 6, mode: "string" }),
	},
	(t) => [uniqueIndex("uk_nft_mints_user_badge").on(t.userId, t.badgeTokenId)]
);

/** Batch metadata only; request and response bodies stay in private R2 objects. */
export const batchesTable = mysqlTable(
	"batches",
	{
		id: varchar("id", { length: 128 }).primaryKey(),
		accountId: varchar("account_id", { length: 1024 }).notNull(),
		workspaceId: varchar("workspace_id", { length: COL.WORKSPACE_ID }).notNull(),
		workspaceKey: asciiBinarySha256("workspace_key").generatedAlwaysAs(
			sql`SHA2(workspace_id, 256)`,
			{ mode: "stored" }
		),
		userId: varchar("user_id", { length: COL.USER_ID }).notNull(),
		apiKeyHash: varchar("api_key_hash", { length: 71 }).notNull(),
		endpoint: varchar("endpoint", { length: 32 }).notNull(),
		modelId: varchar("model_id", { length: COL.ID }).notNull(),
		routeGroup: varchar("route_group", { length: COL.ROUTE_GROUP }).notNull(),
		status: varchar("status", { length: COL.STATUS }).notNull().default("validating"),
		completionWindow: varchar("completion_window", { length: 8 }).notNull().default("24h"),
		idempotencyKeyHash: asciiBinarySha256("idempotency_key_hash"),
		idempotencyScopeKey: asciiBinarySha256("idempotency_scope_key").generatedAlwaysAs(
			sql`CASE WHEN idempotency_key_hash IS NULL THEN NULL ELSE SHA2(CONCAT(CHAR_LENGTH(workspace_id), ':', workspace_id, ':', api_key_hash, ':', idempotency_key_hash), 256) END`,
			{ mode: "stored" }
		),
		inputObjectKey: varchar("input_object_key", { length: 1024 }).notNull(),
		inputSha256: asciiBinarySha256("input_sha256").notNull(),
		inputBytes: int("input_bytes", { unsigned: true }).notNull(),
		resultObjectKey: varchar("result_object_key", { length: 1024 }),
		resultSha256: asciiBinarySha256("result_sha256"),
		requestCount: int("request_count", { unsigned: true }).notNull(),
		validationNextOrdinal: int("validation_next_ordinal", { unsigned: true })
			.notNull()
			.default(0),
		validationInputOffset: int("validation_input_offset", { unsigned: true })
			.notNull()
			.default(0),
		completedCount: int("completed_count", { unsigned: true }).notNull().default(0),
		failedCount: int("failed_count", { unsigned: true }).notNull().default(0),
		cancelledCount: int("cancelled_count", { unsigned: true }).notNull().default(0),
		promptTokens: bigint("prompt_tokens", { mode: "number", unsigned: true }).notNull().default(0),
		completionTokens: bigint("completion_tokens", { mode: "number", unsigned: true })
			.notNull()
			.default(0),
		totalTokens: bigint("total_tokens", { mode: "number", unsigned: true }).notNull().default(0),
		chargedCostMicros: bigint("charged_cost_micros", {
			mode: "number",
			unsigned: true,
		})
			.notNull()
			.default(0),
		byokRequestCount: int("byok_request_count", { unsigned: true }).notNull().default(0),
		unknownCostCount: int("unknown_cost_count", { unsigned: true }).notNull().default(0),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		inProgressAt: datetime("in_progress_at", { fsp: 6, mode: "string" }),
		finalizingAt: datetime("finalizing_at", { fsp: 6, mode: "string" }),
		finalizedAt: datetime("finalized_at", { fsp: 6, mode: "string" }),
		expiresAt: datetime("expires_at", { fsp: 6, mode: "string" }).notNull(),
		retentionExpiresAt: datetime("retention_expires_at", { fsp: 6, mode: "string" }).notNull(),
		leaseOwner: varchar("lease_owner", { length: 128 }),
		leaseExpiresAt: datetime("lease_expires_at", { fsp: 6, mode: "string" }),
		attemptCount: bigint("attempt_count", { mode: "number", unsigned: true }).notNull().default(0),
		revision: bigint("revision", { mode: "number", unsigned: true }).notNull().default(0),
		lastErrorCode: varchar("last_error_code", { length: 128 }),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_batches_idempotency").on(t.idempotencyScopeKey),
		index("idx_batches_workspace_created").on(t.workspaceKey, t.createdAt, t.id),
		index("idx_batches_status_lease").on(t.status, t.leaseExpiresAt),
		index("idx_batches_retention").on(t.retentionExpiresAt),
		check(
			"batches_status_chk",
			sql`${t.status} IN ('validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled')`
		),
		check(
			"batches_counts_chk",
			sql`${t.requestCount} BETWEEN 1 AND 1000000 AND ${t.completedCount} + ${t.failedCount} + ${t.cancelledCount} <= ${t.requestCount}`
		),
		check(
			"batches_validation_checkpoint_chk",
			sql`${t.inputBytes} BETWEEN 1 AND 52428800 AND ${t.validationNextOrdinal} <= ${t.requestCount} AND ${t.validationInputOffset} <= ${t.inputBytes}`
		),
	]
);

/** Idempotent per-request ledger for an accepted batch. */
export const batchItemsTable = mysqlTable(
	"batch_items",
	{
		id: varchar("id", { length: 128 }).notNull().unique(),
		batchId: varchar("batch_id", { length: 128 }).notNull(),
		ordinal: int("ordinal", { unsigned: true }).notNull(),
		customId: varchar("custom_id", { length: 256 }).notNull(),
		status: varchar("status", { length: COL.STATUS }).notNull().default("pending"),
		attemptCount: bigint("attempt_count", { mode: "number", unsigned: true }).notNull().default(0),
		startedAt: datetime("started_at", { fsp: 6, mode: "string" }),
		dispatchStartedAt: datetime("dispatch_started_at", { fsp: 6, mode: "string" }),
		completedAt: datetime("completed_at", { fsp: 6, mode: "string" }),
		generationId: varchar("generation_id", { length: COL.ID }),
		reservationId: varchar("reservation_id", { length: COL.ID }),
		leaseOwner: varchar("lease_owner", { length: 128 }),
		leaseExpiresAt: datetime("lease_expires_at", { fsp: 6, mode: "string" }),
		requestStartOffset: int("request_start_offset", { unsigned: true }).notNull(),
		requestEndOffset: int("request_end_offset", { unsigned: true }).notNull(),
		requestSha256: asciiBinarySha256("request_sha256").notNull(),
		resultObjectKey: varchar("result_object_key", { length: 1024 }),
		resultSha256: asciiBinarySha256("result_sha256"),
		errorCode: varchar("error_code", { length: 128 }),
		errorSummary: varchar("error_summary", { length: 1000 }),
		revision: bigint("revision", { mode: "number", unsigned: true }).notNull().default(0),
		createdAt: datetime("created_at", { fsp: 6, mode: "string" }).notNull(),
		updatedAt: datetime("updated_at", { fsp: 6, mode: "string" }).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.batchId, t.ordinal] }),
		uniqueIndex("uk_batch_items_custom").on(t.batchId, t.customId),
		index("idx_batch_items_status_ordinal").on(t.batchId, t.status, t.ordinal),
		check(
			"batch_items_status_chk",
			sql`${t.status} IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')`
		),
		check(
			"batch_items_request_range_chk",
			sql`${t.requestStartOffset} BETWEEN 0 AND 52428799 AND ${t.requestEndOffset} BETWEEN 1 AND 52428800 AND ${t.requestEndOffset} > ${t.requestStartOffset} AND ${t.requestEndOffset} - ${t.requestStartOffset} <= 1048578`
		),
		check(
			"batch_items_lease_pair_chk",
			sql`(${t.leaseOwner} IS NULL AND ${t.leaseExpiresAt} IS NULL) OR (${t.leaseOwner} IS NOT NULL AND char_length(${t.leaseOwner}) BETWEEN 1 AND 128 AND ${t.leaseExpiresAt} IS NOT NULL)`
		),
		check(
			"batch_items_dispatch_chk",
			sql`(${t.dispatchStartedAt} IS NULL AND ${t.generationId} IS NULL AND ${t.reservationId} IS NULL) OR (${t.dispatchStartedAt} IS NOT NULL AND ${t.startedAt} IS NOT NULL AND ${t.generationId} IS NOT NULL AND char_length(${t.generationId}) BETWEEN 1 AND 512 AND ${t.reservationId} IS NOT NULL AND char_length(${t.reservationId}) BETWEEN 1 AND 512)`
		),
	]
);

export const mysqlCoreSchema = {
	usersTable,
	organizationsTable,
	organizationMembershipsTable,
	identityEventInboxTable,
	workspacesTable,
	workspaceMembershipsTable,
	apiKeysTable,
	managementApiKeysTable,
	byokKeysTable,
	providersTable,
	modelsTable,
	modelEndpointsTable,
	routePoolsTable,
	modelSurfacesTable,
	modelRoutesTable,
	modelEndpointRoutesTable,
	apiKeyRequestLogsTable,
	generationFeedbackTable,
	publicModelDailyStatsTable,
	systemConfigTable,
	requestPresetsTable,
	requestPresetVersionsTable,
	guardrailsTable,
	guardrailVersionsTable,
	guardrailAssignmentsTable,
	guardrailBudgetWindowsTable,
	guardrailBudgetReservationsTable,
	userBudgetReservationsTable,
	routeDataPoliciesTable,
	routeDataPolicyAuditTable,
	userAuditLogsTable,
	adminApiKeysTable,
	adminSessionsTable,
	portalSessionsTable,
	sharedKeysTable,
	sharedKeyEarningsTable,
	userEarningsTable,
	withdrawalsTable,
	nftMintsTable,
	batchesTable,
	batchItemsTable,
};
