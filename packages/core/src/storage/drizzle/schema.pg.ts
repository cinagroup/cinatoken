import { sql } from "drizzle-orm";
import {
	pgTable,
	text,
	timestamp,
	integer,
	numeric,
	real,
	boolean,
	index,
	uniqueIndex,
	check,
	bigint,
	primaryKey,
} from "drizzle-orm/pg-core";

export const usersTable = pgTable(
	"users",
	{
		id: text("id").primaryKey(),
		/**
		 * 在 `external_system` 命名空间内唯一（含 internal 用户，即 `external_system IS NULL`）；
		 * 由两条 partial unique index 落实，见表选项末尾。
		 */
		email: text("email").notNull(),
		budgetMax: numeric("budget_max", { precision: 18, scale: 6 }),
		budgetBase: numeric("budget_base", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		budgetSpent: numeric("budget_spent", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		budgetPeriod: text("budget_period").notNull().default("none"),
		budgetResetAt: timestamp("budget_reset_at", {
			withTimezone: true,
			mode: "string",
		}),
		budgetEpoch: bigint("budget_epoch", { mode: "number" })
			.notNull()
			.default(0),
		budgetReservedMicros: bigint("budget_reserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		status: text("status").notNull().default("active"),
		metadata: text("metadata"),
		/** `{ "<models.id>": factor }` JSON；NULL 表示无用户级 Charged 折扣 */
		chargedCostFactors: text("charged_cost_factors"),
		/** 上游命名空间（产品/租户），与 external_user_id 成对做幂等；纯网关用户二者皆空。 */
		externalSystem: text("external_system"),
		externalUserId: text("external_user_id"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_users_external_system_user_id").on(
			t.externalSystem,
			t.externalUserId
		),
		uniqueIndex("uk_users_external_system_email")
			.on(t.externalSystem, t.email)
			.where(sql`external_system IS NOT NULL`),
		uniqueIndex("uk_users_internal_email")
			.on(t.email)
			.where(sql`external_system IS NULL`),
		check(
			"users_external_pair_chk",
			sql`(external_system IS NULL AND external_user_id IS NULL) OR (external_system IS NOT NULL AND external_user_id IS NOT NULL)`
		),
		check(
			"users_external_system_nonempty_chk",
			sql`external_system IS NULL OR length(external_system) > 0`
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
export const organizationsTable = pgTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		source: text("source").notNull(),
		name: text("name").notNull(),
		slug: text("slug"),
		status: text("status").notNull().default("active"),
		metadataJson: text("metadata_json"),
		sourceUpdatedAt: timestamp("source_updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		check(
			"organizations_status_chk",
			sql`${t.status} IN ('pending', 'active', 'suspended', 'deleted')`
		),
		check("organizations_source_nonempty_chk", sql`length(${t.source}) > 0`),
	]
);

/** Organization membership keyed by CinaAuth OIDC subject, even before first login. */
export const organizationMembershipsTable = pgTable(
	"organization_memberships",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizationsTable.id, { onDelete: "cascade" }),
		subject: text("subject").notNull(),
		userId: text("user_id").references(() => usersTable.id, {
			onDelete: "set null",
		}),
		email: text("email"),
		rolesJson: text("roles_json").notNull().default("[]"),
		status: text("status").notNull().default("active"),
		sourceUpdatedAt: timestamp("source_updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.organizationId, t.subject] }),
		check(
			"organization_memberships_status_chk",
			sql`${t.status} IN ('active', 'suspended', 'removed')`
		),
		check(
			"organization_memberships_subject_nonempty_chk",
			sql`length(${t.subject}) > 0`
		),
	]
);

/** Immutable receipt for idempotent identity-event application. */
export const identityEventInboxTable = pgTable(
	"identity_event_inbox",
	{
		source: text("source").notNull(),
		eventId: text("event_id").notNull(),
		eventType: text("event_type").notNull(),
		aggregateType: text("aggregate_type").notNull(),
		aggregateId: text("aggregate_id").notNull(),
		payloadSha256: text("payload_sha256").notNull(),
		processorToken: text("processor_token").notNull().unique(),
		occurredAt: timestamp("occurred_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		processedAt: timestamp("processed_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [primaryKey({ columns: [t.source, t.eventId] })]
);

/** CinaToken-owned gateway resource boundary; identity remains owned by CinaAuth. */
export const workspacesTable = pgTable(
	"workspaces",
	{
		id: text("id").primaryKey(),
		scopeType: text("scope_type").notNull(),
		organizationId: text("organization_id").references(
			() => organizationsTable.id,
			{ onDelete: "cascade" }
		),
		personalOwnerUserId: text("personal_owner_user_id").references(
			() => usersTable.id,
			{ onDelete: "cascade" }
		),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		isDefault: boolean("is_default").notNull().default(false),
		defaultScopeKey: text("default_scope_key").unique(),
		status: text("status").notNull().default("active"),
		settingsJson: text("settings_json"),
		createdByUserId: text("created_by_user_id").references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_workspaces_personal_slug")
			.on(t.personalOwnerUserId, t.slug)
			.where(sql`${t.personalOwnerUserId} IS NOT NULL`),
		uniqueIndex("uk_workspaces_organization_slug")
			.on(t.organizationId, t.slug)
			.where(sql`${t.organizationId} IS NOT NULL`),
		check(
			"workspaces_scope_type_chk",
			sql`${t.scopeType} IN ('personal', 'organization')`
		),
		check("workspaces_status_chk", sql`${t.status} IN ('active', 'archived')`),
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
			(${t.isDefault} AND ${t.defaultScopeKey} IS NOT NULL)
			OR (NOT ${t.isDefault} AND ${t.defaultScopeKey} IS NULL)
		)`
		),
	]
);

export const workspaceBudgetsTable = pgTable(
	"workspace_budgets",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		resetInterval: text("reset_interval").notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		configEpoch: integer("config_epoch").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
	},
	(t) => [
		uniqueIndex("uk_workspace_budgets_interval").on(t.workspaceId, t.resetInterval),
		index("idx_workspace_budgets_workspace").on(t.workspaceId),
		check("workspace_budgets_interval_chk", sql`${t.resetInterval} IN ('daily', 'weekly', 'monthly', 'lifetime')`),
		check("workspace_budgets_limit_chk", sql`${t.limitMicros} > 0 AND ${t.limitMicros} <= 9007199254740991`),
		check("workspace_budgets_epoch_chk", sql`${t.configEpoch} >= 0 AND ${t.configEpoch} <= 2147483646`),
	]
);

/** Explicit access for non-default organization workspaces. */
export const workspaceMembershipsTable = pgTable(
	"workspace_memberships",
	{
		id: text("id").primaryKey(),
		membershipKey: text("membership_key").notNull().unique(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		subject: text("subject").notNull(),
		role: text("role").notNull().default("member"),
		status: text("status").notNull().default("active"),
		grantedBySubject: text("granted_by_subject"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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
			sql`length(${t.subject}) BETWEEN 1 AND 255`
		),
		check(
			"workspace_memberships_key_chk",
			sql`length(${t.membershipKey}) = 64`
		),
	]
);

export const apiKeysTable = pgTable("api_keys", {
	id: text("id").primaryKey(),
	key: text("key").notNull(),
	keyHash: text("key_hash"),
	keyPreview: text("key_preview"),
	userId: text("user_id").notNull(),
	workspaceId: text("workspace_id")
		.notNull()
		.references(() => workspacesTable.id, { onDelete: "cascade" }),
	name: text("name"),
	status: text("status").notNull().default("active"),
	metadata: text("metadata"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
	limitMicros: bigint("limit_micros", { mode: "number" }),
	limitReset: text("limit_reset"),
	includeByokInLimit: boolean("include_byok_in_limit").notNull().default(false),
	limitEpoch: integer("limit_epoch").notNull().default(0),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

export const managementApiKeysTable = pgTable(
	"management_api_keys",
	{
		id: text("id").primaryKey(),
		keyHash: text("key_hash").notNull().unique(),
		keyPreview: text("key_preview").notNull(),
		accountType: text("account_type").notNull(),
		personalOwnerUserId: text("personal_owner_user_id").references(
			() => usersTable.id,
			{ onDelete: "cascade" }
		),
		organizationId: text("organization_id").references(
			() => organizationsTable.id,
			{ onDelete: "cascade" }
		),
		name: text("name").notNull(),
		status: text("status").notNull().default("active"),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
		lastUsedAt: timestamp("last_used_at", {
			withTimezone: true,
			mode: "string",
		}),
		createdByUserId: text("created_by_user_id").references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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
			sql`${t.keyHash} ~ '^sha256:[0-9a-f]{64}$'`
		),
		check(
			"management_api_keys_name_chk",
			sql`length(${t.name}) BETWEEN 1 AND 128`
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

export const providersTable = pgTable("providers", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
	/** JSON: `{ openai?: { base?, endpoints? }, … }` */
	endpoints: text("endpoints"),
	/** 该上游账号唯一 API Key */
	apiKey: text("api_key").notNull().default(""),
	/** `active` | `disabled` */
	status: text("status").notNull().default("active"),
	description: text("description"),
	/** 非空时该 provider 接受对应用户共享密钥池注入（openai/anthropic/zhipu/deepseek） */
	sharedChannelType: text("shared_channel_type"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

export const modelsTable = pgTable("models", {
	id: text("id").primaryKey(),
	displayName: text("display_name"),
	vendor: text("vendor").notNull().default("other"),
	contextWindow: integer("context_window"),
	/** Chat completion max output tokens; NULL for image-generation models. */
	maxTokens: integer("max_tokens").default(8192),
	pricingProfile: text("pricing_profile"),
	description: text("description"),
	metadata: text("metadata"),
	inputModalities: text("input_modalities"),
	outputModalities: text("output_modalities"),
	releasedAt: text("released_at"),
	/** 路由策略配置 JSON；NULL=使用全局/代码默认 */
	routePolicy: text("route_policy"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** Endpoint-first provider implementation and its verified public capabilities. */
export const modelEndpointsTable = pgTable(
	"model_endpoints",
	{
		id: text("id").primaryKey(),
		modelId: text("model_id")
			.notNull()
			.references(() => modelsTable.id, { onDelete: "cascade" }),
		providerId: text("provider_id")
			.notNull()
			.references(() => providersTable.id, { onDelete: "cascade" }),
		providerSlug: text("provider_slug").notNull(),
		tag: text("tag").notNull(),
		endpointClass: text("endpoint_class"),
		region: text("region"),
		contextLength: integer("context_length"),
		maxPromptTokens: integer("max_prompt_tokens"),
		maxCompletionTokens: integer("max_completion_tokens"),
		quantization: text("quantization"),
		supportedParameters: text("supported_parameters").notNull().default("[]"),
		pricing: text("pricing").notNull().default("{}"),
		supportsToolChoice: text("supports_tool_choice")
			.notNull()
			.default('{"auto":null,"function":null,"none":null,"required":null}'),
		imageCapabilities: text("image_capabilities").notNull().default("{}"),
		audioCapabilities: text("audio_capabilities").notNull().default("{}"),
		/** Nullable boolean: NULL means the capability has not been verified. */
		supportsImplicitCaching: boolean("supports_implicit_caching"),
		/** Nullable boolean: NULL means the capability has not been verified. */
		supportsVoiceCloning: boolean("supports_voice_cloning"),
		evidenceUrl: text("evidence_url"),
		verifiedBy: text("verified_by"),
		verifiedAt: timestamp("verified_at", {
			withTimezone: true,
			mode: "string",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
		status: text("status").notNull().default("draft"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_model_endpoints_identity").on(
			t.modelId,
			t.providerId,
			t.tag
		),
		index("idx_model_endpoints_provider").on(t.providerId),
		index("idx_model_endpoints_model_status").on(t.modelId, t.status),
		check(
			"model_endpoints_status_chk",
			sql`${t.status} IN ('draft', 'verified', 'disabled')`
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

export const routePoolsTable = pgTable("route_pools", {
	id: text("id").primaryKey(),
	modelId: text("model_id").notNull(),
	routeGroup: text("route_group").notNull().default("default"),
	name: text("name").notNull(),
	strategy: text("strategy"),
	/** JSON map: {"10":"hash_affinity","0":"weight_priority"} — per-priority-tier overrides */
	tierStrategies: text("tier_strategies"),
	stickyEnabled: boolean("sticky_enabled").notNull().default(false),
	stickyIdleTtlSeconds: integer("sticky_idle_ttl_seconds")
		.notNull()
		.default(3600),
	/** Bumped on sticky config change to invalidate existing bindings */
	stickyEpoch: integer("sticky_epoch").notNull().default(0),
	status: text("status").notNull().default("active"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

export const routePoolStickyBindingsTable = pgTable(
	"route_pool_sticky_bindings",
	{
		routePoolId: text("route_pool_id").notNull(),
		affinityHash: text("affinity_hash").notNull(),
		routeTargetId: text("route_target_id").notNull(),
		bindingToken: text("binding_token").notNull(),
		poolEpoch: integer("pool_epoch").notNull().default(0),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	}
);

export const modelSurfacesTable = pgTable("model_surfaces", {
	id: text("id").primaryKey(),
	modelId: text("model_id").notNull(),
	routeGroup: text("route_group").notNull().default("default"),
	requestProtocol: text("request_protocol").notNull(),
	requestOperation: text("request_operation").notNull().default("*"),
	routePoolId: text("route_pool_id").notNull(),
	status: text("status").notNull().default("active"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

export const modelRoutesTable = pgTable("model_routes", {
	id: text("id").primaryKey(),
	modelId: text("model_id").notNull(),
	providerId: text("provider_id").notNull(),
	providerModelName: text("provider_model_name").notNull(),
	priority: integer("priority").notNull().default(0),
	status: text("status").notNull().default("active"),
	routeGroup: text("route_group").notNull().default("default"),
	/** 同 priority 层内权重 */
	weight: integer("weight").notNull().default(1),
	priceOverride: text("price_override"),
	customParams: text("custom_params"),
	routingMetadata: text("routing_metadata"),
	upstreamProtocol: text("upstream_protocol").notNull().default("openai"),
	routePoolId: text("route_pool_id"),
	upstreamOperation: text("upstream_operation").notNull().default("*"),
	adapter: text("adapter").notNull().default("passthrough"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** A route target belongs to at most one endpoint during the migration. */
export const modelEndpointRoutesTable = pgTable(
	"model_endpoint_routes",
	{
		endpointId: text("endpoint_id")
			.notNull()
			.references(() => modelEndpointsTable.id, { onDelete: "cascade" }),
		routeTargetId: text("route_target_id")
			.notNull()
			.references(() => modelRoutesTable.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		/** SHA-256 of the exact route/provider subject verified for this binding. */
		subjectFingerprint: text("subject_fingerprint"),
	},
	(t) => [
		primaryKey({ columns: [t.endpointId, t.routeTargetId] }),
		uniqueIndex("uk_model_endpoint_routes_target").on(t.routeTargetId),
		check(
			"model_endpoint_routes_subject_fingerprint_chk",
			sql`${t.subjectFingerprint} IS NULL OR ${t.subjectFingerprint} ~ '^[0-9a-f]{64}$'`
		),
	]
);

export const apiKeyRequestLogsTable = pgTable("api_key_request_logs", {
	id: text("id").primaryKey(),
	userId: text("user_id"),
	apiKeyId: text("api_key_id"),
	workspaceId: text("workspace_id").references(() => workspacesTable.id, {
		onDelete: "set null",
	}),
	userEmail: text("user_email"),
	modelId: text("model_id"),
	providerId: text("provider_id"),
	providerModelName: text("provider_model_name"),
	modelName: text("model_name"),
	providerName: text("provider_name"),
	requestBody: text("request_body"),
	upstreamRequestBody: text("upstream_request_body"),
	requestProtocol: text("request_protocol"),
	requestOperation: text("request_operation"),
	upstreamProtocol: text("upstream_protocol").notNull().default("openai"),
	upstreamOperation: text("upstream_operation"),
	modelSurfaceId: text("model_surface_id"),
	routePoolId: text("route_pool_id"),
	routeTargetId: text("route_target_id"),
	adapter: text("adapter"),
	routeTrace: text("route_trace"),
	inputTokens: integer("input_tokens").notNull().default(0),
	outputTokens: integer("output_tokens").notNull().default(0),
	cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
	cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
	reasoningTokens: integer("reasoning_tokens").notNull().default(0),
	totalTokens: integer("total_tokens").notNull().default(0),
	meteredCost: numeric("metered_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	standardCost: numeric("standard_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	chargedCost: numeric("charged_cost", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	/** Guardrail/user budget debit in integer micro-units; NULL marks a pre-ledger row. */
	budgetChargedMicros: bigint("budget_charged_micros", { mode: "number" }),
	budgetAccountedAt: timestamp("budget_accounted_at", {
		withTimezone: true,
		mode: "string",
	}),
	routeGroup: text("route_group").notNull().default("default"),
	status: text("status").notNull().default("success"),
	latencyMs: integer("latency_ms"),
	gatewayOverheadMs: integer("gateway_overhead_ms"),
	upstreamResponseMs: integer("upstream_response_ms"),
	finalUpstreamHeadersMs: integer("final_upstream_headers_ms"),
	firstReasoningTokenMs: integer("first_reasoning_token_ms"),
	firstTokenMs: integer("first_token_ms"),
	streamDurationMs: integer("stream_duration_ms"),
	upstreamAttemptCount: integer("upstream_attempt_count"),
	upstreamFailoverCount: integer("upstream_failover_count"),
	timingMetadata: text("timing_metadata"),
	errorMessage: text("error_message"),
	rawUsage: text("raw_usage"),
	/** 计费审计 JSON 字符串；结构见 `db/pricing-audit.ts` */
	pricingAudit: text("pricing_audit"),
	providerKeyId: text("provider_key_id"),
	providerKeyLabel: text("provider_key_label"),
	providerKeyFingerprint: text("provider_key_fingerprint"),
	upstreamRequestId: text("upstream_request_id"),
	upstreamMessageId: text("upstream_message_id"),
	billingKind: text("billing_kind"),
	inputImageCount: integer("input_image_count").notNull().default(0),
	outputImageCount: integer("output_image_count").notNull().default(0),
	audioDurationSeconds: real("audio_duration_seconds"),
	audioCharacters: integer("audio_characters"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** 匿名公开排行专用的分片日汇总；公开请求不得回退扫描 api_key_request_logs。 */
export const publicModelDailyStatsTable = pgTable(
	"public_model_daily_stats",
	{
		statDate: text("stat_date").notNull(),
		modelId: text("model_id").notNull(),
		shard: integer("shard").notNull(),
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
		latencyTotalMs: bigint("latency_total_ms", { mode: "number" })
			.notNull()
			.default(0),
		latencySampleCount: bigint("latency_sample_count", { mode: "number" })
			.notNull()
			.default(0),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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

export const systemConfigTable = pgTable("system_config", {
	key: text("key").primaryKey(),
	value: text("value").notNull(),
	description: text("description"),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** OpenRouter-compatible request presets with immutable designated versions. */
export const requestPresetsTable = pgTable(
	"request_presets",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		ownerUserId: text("owner_user_id")
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		visibility: text("visibility").notNull().default("private"),
		status: text("status").notNull().default("active"),
		designatedVersion: integer("designated_version").notNull().default(1),
		latestVersion: integer("latest_version").notNull().default(1),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_request_presets_workspace_slug").on(t.workspaceId, t.slug),
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

export const requestPresetVersionsTable = pgTable(
	"request_preset_versions",
	{
		id: text("id").primaryKey(),
		presetId: text("preset_id")
			.notNull()
			.references(() => requestPresetsTable.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		systemPrompt: text("system_prompt"),
		configJson: text("config_json").notNull(),
		createdByUserId: text("created_by_user_id").references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [uniqueIndex("uk_request_preset_versions").on(t.presetId, t.version)]
);

export const guardrailsTable = pgTable(
	"guardrails",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		ownerUserId: text("owner_user_id")
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		status: text("status").notNull().default("active"),
		designatedVersion: integer("designated_version").notNull().default(1),
		latestVersion: integer("latest_version").notNull().default(1),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_guardrails_id_workspace").on(t.id, t.workspaceId),
		check("guardrails_status_chk", sql`${t.status} IN ('active', 'archived')`),
		check(
			"guardrails_versions_chk",
			sql`${t.designatedVersion} >= 1 AND ${t.latestVersion} >= ${t.designatedVersion}`
		),
	]
);

export const guardrailVersionsTable = pgTable(
	"guardrail_versions",
	{
		id: text("id").primaryKey(),
		guardrailId: text("guardrail_id")
			.notNull()
			.references(() => guardrailsTable.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		configJson: text("config_json").notNull(),
		createdByUserId: text("created_by_user_id").references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [uniqueIndex("uk_guardrail_versions").on(t.guardrailId, t.version)]
);

export const guardrailAssignmentsTable = pgTable(
	"guardrail_assignments",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		guardrailId: text("guardrail_id")
			.notNull()
			.references(() => guardrailsTable.id, { onDelete: "cascade" }),
		scopeType: text("scope_type").notNull(),
		scopeId: text("scope_id").notNull(),
		createdByUserId: text("created_by_user_id").references(
			() => usersTable.id,
			{ onDelete: "set null" }
		),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_guardrail_assignments_workspace_scope").on(
			t.workspaceId,
			t.scopeType,
			t.scopeId
		),
		check(
			"guardrail_assignments_scope_chk",
			sql`${t.scopeType} IN ('user', 'api_key', 'workspace')`
		),
	]
);

export const guardrailBudgetWindowsTable = pgTable(
	"guardrail_budget_windows",
	{
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		scopeType: text("scope_type").notNull(),
		scopeId: text("scope_id").notNull(),
		period: text("period").notNull(),
		periodStart: timestamp("period_start", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		periodEnd: timestamp("period_end", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		unreservedMicros: bigint("unreserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		reservedMicros: bigint("reserved_micros", { mode: "number" })
			.notNull()
			.default(0),
		seedRequestId: text("seed_request_id"),
		seededAt: timestamp("seeded_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		primaryKey({
			columns: [t.workspaceId, t.scopeType, t.scopeId, t.period, t.periodStart],
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

export const guardrailBudgetReservationsTable = pgTable(
	"guardrail_budget_reservations",
	{
		id: text("id").primaryKey(),
		workspaceId: text("workspace_id")
			.notNull()
			.references(() => workspacesTable.id, { onDelete: "cascade" }),
		requestId: text("request_id").notNull(),
		assignmentId: text("assignment_id").notNull(),
		guardrailId: text("guardrail_id").notNull(),
		guardrailVersion: integer("guardrail_version").notNull(),
		scopeType: text("scope_type").notNull(),
		scopeId: text("scope_id").notNull(),
		period: text("period").notNull(),
		periodStart: timestamp("period_start", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		periodEnd: timestamp("period_end", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		state: text("state").notNull().default("reserved"),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		dispatchedAt: timestamp("dispatched_at", {
			withTimezone: true,
			mode: "string",
		}),
		terminalAt: timestamp("terminal_at", {
			withTimezone: true,
			mode: "string",
		}),
		terminalReason: text("terminal_reason"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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
	]
);

export const userBudgetReservationsTable = pgTable(
	"user_budget_reservations",
	{
		requestId: text("request_id").primaryKey(),
		userId: text("user_id").notNull(),
		apiKeyId: text("api_key_id").notNull(),
		budgetEpoch: bigint("budget_epoch", { mode: "number" }).notNull(),
		limitMicros: bigint("limit_micros", { mode: "number" }).notNull(),
		reservedMicros: bigint("reserved_micros", { mode: "number" }).notNull(),
		settledMicros: bigint("settled_micros", { mode: "number" })
			.notNull()
			.default(0),
		state: text("state").notNull().default("reserved"),
		expiresAt: timestamp("expires_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		dispatchedAt: timestamp("dispatched_at", {
			withTimezone: true,
			mode: "string",
		}),
		terminalAt: timestamp("terminal_at", {
			withTimezone: true,
			mode: "string",
		}),
		terminalReason: text("terminal_reason"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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
		check(
			"user_budget_reservations_request_id_chk",
			sql`length(${t.requestId}) BETWEEN 1 AND 128`
		),
		check(
			"user_budget_reservations_user_id_chk",
			sql`length(${t.userId}) BETWEEN 1 AND 512`
		),
		check(
			"user_budget_reservations_api_key_id_chk",
			sql`length(${t.apiKeyId}) BETWEEN 1 AND 512`
		),
	]
);

export const routeDataPoliciesTable = pgTable(
	"route_data_policies",
	{
		routeTargetId: text("route_target_id")
			.primaryKey()
			.references(() => modelRoutesTable.id, { onDelete: "cascade" }),
		subjectFingerprint: text("subject_fingerprint"),
		retentionDays: integer("retention_days"),
		trainingAllowed: boolean("training_allowed").notNull().default(true),
		zdrSupported: boolean("zdr_supported").notNull().default(false),
		evidenceUrl: text("evidence_url"),
		verifiedBy: text("verified_by"),
		verifiedAt: timestamp("verified_at", {
			withTimezone: true,
			mode: "string",
		}),
		expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
		status: text("status").notNull().default("unknown"),
		invalidatedAt: timestamp("invalidated_at", {
			withTimezone: true,
			mode: "string",
		}),
		invalidationReason: text("invalidation_reason"),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
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
			sql`${t.subjectFingerprint} IS NULL OR ${t.subjectFingerprint} ~ '^[0-9a-f]{64}$'`
		),
	]
);

export const routeDataPolicyAuditTable = pgTable("route_data_policy_audit", {
	id: text("id").primaryKey(),
	routeTargetId: text("route_target_id").references(() => modelRoutesTable.id, {
		onDelete: "set null",
	}),
	snapshotJson: text("snapshot_json").notNull(),
	actorId: text("actor_id").notNull(),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** 用户维度审计：预算、资料等；扩展载荷见 `change_payload`。 */
export const userAuditLogsTable = pgTable("user_audit_logs", {
	id: text("id").primaryKey(),
	userId: text("user_id"),
	apiKeyId: text("api_key_id"),
	eventType: text("event_type").notNull(),
	actorType: text("actor_type").notNull().default("system"),
	requestLogId: text("request_log_id"),
	changePayload: text("change_payload"),
	beforeUserSnapshot: text("before_user_snapshot"),
	afterUserSnapshot: text("after_user_snapshot"),
	changedFields: text("changed_fields"),
	correlationId: text("correlation_id"),
	source: text("source"),
	actorId: text("actor_id"),
	reasonCode: text("reason_code"),
	reasonText: text("reason_text"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

export const adminApiKeysTable = pgTable("admin_api_keys", {
	id: text("id").primaryKey(),
	name: text("name").notNull().unique(),
	description: text("description"),
	secretKey: text("secret_key").notNull().unique(),
	secretKeyHash: text("secret_key_hash"),
	keyPrefix: text("key_prefix").notNull(),
	permissionsJson: text("permissions_json").notNull().default("[]"),
	status: text("status").notNull().default("active"),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "string" }),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
});

export const adminSessionsTable = pgTable("admin_sessions", {
	tokenHash: text("token_hash").primaryKey(),
	username: text("username").notNull(),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	expiresAt: timestamp("expires_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** 用户门户会话（`user_session` Cookie），独立于 admin_sessions。 */
export const portalSessionsTable = pgTable("portal_sessions", {
	tokenHash: text("token_hash").primaryKey(),
	/** CinaAuth OIDC `sub` */
	subject: text("subject").notNull(),
	email: text("email").notNull(),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	expiresAt: timestamp("expires_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** 卖家上架的个人上游 API Key（官方渠道白名单）。 */
export const sharedKeysTable = pgTable(
	"shared_keys",
	{
		id: text("id").primaryKey(),
		sellerUserId: text("seller_user_id")
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		/** openai | anthropic | zhipu | deepseek */
		channelType: text("channel_type").notNull(),
		apiKey: text("api_key").notNull(),
		keyFingerprint: text("key_fingerprint").notNull(),
		label: text("label"),
		/** validating | active | paused | invalid | disabled */
		status: text("status").notNull().default("validating"),
		sellerPriority: integer("seller_priority").notNull().default(0),
		weight: integer("weight").notNull().default(1),
		inputPrice: numeric("input_price", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		outputPrice: numeric("output_price", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		cacheReadPrice: numeric("cache_read_price", { precision: 18, scale: 6 }),
		cacheWritePrice: numeric("cache_write_price", { precision: 18, scale: 6 }),
		validatedAt: timestamp("validated_at", {
			withTimezone: true,
			mode: "string",
		}),
		lastUsedAt: timestamp("last_used_at", {
			withTimezone: true,
			mode: "string",
		}),
		lastFailureAt: timestamp("last_failure_at", {
			withTimezone: true,
			mode: "string",
		}),
		failureReason: text("failure_reason"),
		servedInputTokens: bigint("served_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		servedOutputTokens: bigint("served_output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		earnedTotal: numeric("earned_total", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		updatedAt: timestamp("updated_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("uk_shared_keys_seller_fingerprint").on(
			t.sellerUserId,
			t.keyFingerprint
		),
	]
);

/** 按请求结算的卖家收益流水；`request_log_id` 幂等。 */
export const sharedKeyEarningsTable = pgTable(
	"shared_key_earnings",
	{
		id: text("id").primaryKey(),
		requestLogId: text("request_log_id").notNull(),
		sharedKeyId: text("shared_key_id").notNull(),
		sellerUserId: text("seller_user_id").notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
		cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
		grossAmount: numeric("gross_amount", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		platformFee: numeric("platform_fee", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		netAmount: numeric("net_amount", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		currency: text("currency").notNull().default("USD"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [uniqueIndex("uk_shared_key_earnings_request_log").on(t.requestLogId)]
);

/** 卖家账本（1:1 users）。 */
export const userEarningsTable = pgTable("user_earnings", {
	userId: text("user_id")
		.primaryKey()
		.references(() => usersTable.id, { onDelete: "cascade" }),
	balance: numeric("balance", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lockedAmount: numeric("locked_amount", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lifetimeEarned: numeric("lifetime_earned", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	lifetimeWithdrawn: numeric("lifetime_withdrawn", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	contributionValue: numeric("contribution_value", { precision: 18, scale: 6 })
		.notNull()
		.default("0"),
	/** Canonical monetary state; NUMERIC columns above are compatibility projections. */
	balanceMicros: bigint("balance_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	lockedAmountMicros: bigint("locked_amount_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	lifetimeEarnedMicros: bigint("lifetime_earned_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	lifetimeWithdrawnMicros: bigint("lifetime_withdrawn_micros", {
		mode: "bigint",
	})
		.notNull()
		.default(sql`0`),
	contributionValueMicros: bigint("contribution_value_micros", {
		mode: "bigint",
	})
		.notNull()
		.default(sql`0`),
	walletAddress: text("wallet_address"),
	walletVerifiedAt: timestamp("wallet_verified_at", {
		withTimezone: true,
		mode: "string",
	}),
	highestBadgeTier: integer("highest_badge_tier").notNull().default(0),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
});

/** Append-only balance journal. Mutations are owned by database triggers. */
export const portalLedgerEntriesTable = pgTable(
	"portal_ledger_entries",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		amountMicros: bigint("amount_micros", { mode: "bigint" }).notNull(),
		balanceAfterMicros: bigint("balance_after_micros", {
			mode: "bigint",
		}).notNull(),
		lockedAfterMicros: bigint("locked_after_micros", {
			mode: "bigint",
		}).notNull(),
		referenceType: text("reference_type").notNull(),
		referenceId: text("reference_id").notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
	},
	(t) => [
		uniqueIndex("portal_ledger_entries_reference_unique").on(
			t.referenceType,
			t.referenceId,
			t.kind
		),
	]
);

/** 链上 CINA-C 自动提现单。 */
export const withdrawalsTable = pgTable("withdrawals", {
	id: text("id").primaryKey(),
	userId: text("user_id")
		.notNull()
		.references(() => usersTable.id, { onDelete: "cascade" }),
	amount: numeric("amount", { precision: 18, scale: 6 }).notNull(),
	fee: numeric("fee", { precision: 18, scale: 6 }).notNull().default("0"),
	netAmount: numeric("net_amount", { precision: 18, scale: 6 }).notNull(),
	amountMicros: bigint("amount_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	feeMicros: bigint("fee_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	netAmountMicros: bigint("net_amount_micros", { mode: "bigint" })
		.notNull()
		.default(sql`0`),
	currency: text("currency").notNull().default("USD"),
	walletAddress: text("wallet_address").notNull(),
	/** requested | processing | submitted | confirmed | failed */
	status: text("status").notNull().default("requested"),
	tokenAmount: numeric("token_amount", { precision: 18, scale: 6 }),
	txHash: text("tx_hash"),
	chainId: integer("chain_id"),
	failureReason: text("failure_reason"),
	createdAt: timestamp("created_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	updatedAt: timestamp("updated_at", {
		withTimezone: true,
		mode: "string",
	}).notNull(),
	confirmedAt: timestamp("confirmed_at", {
		withTimezone: true,
		mode: "string",
	}),
});

/** cinachain CinaBadge 位阶徽章铸造记录。 */
export const nftMintsTable = pgTable(
	"nft_mints",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => usersTable.id, { onDelete: "cascade" }),
		badgeTokenId: integer("badge_token_id").notNull(),
		tierName: text("tier_name").notNull(),
		walletAddress: text("wallet_address").notNull(),
		/** pending | submitted | confirmed | failed */
		status: text("status").notNull().default("pending"),
		txHash: text("tx_hash"),
		chainId: integer("chain_id"),
		valueSnapshot: numeric("value_snapshot", { precision: 18, scale: 6 })
			.notNull()
			.default("0"),
		failureReason: text("failure_reason"),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		confirmedAt: timestamp("confirmed_at", {
			withTimezone: true,
			mode: "string",
		}),
	},
	(t) => [uniqueIndex("uk_nft_mints_user_badge").on(t.userId, t.badgeTokenId)]
);

/** Signed transaction outbox used by the at-least-once chain queue consumer. */
export const chainJobTransactionsTable = pgTable(
	"chain_job_transactions",
	{
		jobKind: text("job_kind").notNull(),
		jobId: text("job_id").notNull(),
		txHash: text("tx_hash").notNull().unique(),
		rawTransaction: text("raw_transaction").notNull(),
		chainId: integer("chain_id").notNull(),
		createdAt: timestamp("created_at", {
			withTimezone: true,
			mode: "string",
		}).notNull(),
		broadcastAt: timestamp("broadcast_at", {
			withTimezone: true,
			mode: "string",
		}),
	},
	(t) => [primaryKey({ columns: [t.jobKind, t.jobId] })]
);

export const pgCoreSchema = {
	usersTable,
	organizationsTable,
	organizationMembershipsTable,
	identityEventInboxTable,
	workspacesTable,
	workspaceMembershipsTable,
	apiKeysTable,
	managementApiKeysTable,
	providersTable,
	modelsTable,
	modelEndpointsTable,
	routePoolsTable,
	modelSurfacesTable,
	modelRoutesTable,
	modelEndpointRoutesTable,
	apiKeyRequestLogsTable,
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
	portalLedgerEntriesTable,
	withdrawalsTable,
	nftMintsTable,
	chainJobTransactionsTable,
};
