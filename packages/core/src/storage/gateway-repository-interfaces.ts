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
} from "../types";
import type {
	ExtendDispatchedGuardrailBudgetsParams,
	ReserveGuardrailBudgetsParams,
	ReserveGuardrailBudgetsResult,
} from "../db/guardrail-budget-types";
import type {
	ReserveUserBudgetParams,
	ReserveUserBudgetResult,
} from "../db/user-budget-reservation-types";
import type { InsertUserAuditLogParams } from "../db/user-audit-logs-types";
import type {
	GenerationRequestLogRow,
	RoutePerformanceSample,
} from "../db/request-logs-types";
import type { InsertGenerationFeedbackForManagementAccountParams } from "../db/generation-feedback-types";
import type {
	ManagementAnalyticsQuery,
	ManagementAnalyticsQueryResult,
} from "../db/analytics-query";
import type { RouteAvailabilityAggregate } from "../db/provider-attempt-availability";
import type {
	BudgetFilter,
	InsertKeyParams,
	ManagementGatewayKeyListParams,
	ManagementGatewayKeyLookupParams,
	ManagementGatewayKeyPatch,
	ManagementGatewayKeyRow,
} from "../db/api-keys-types";
import type { InsertUserParams, UserMaxBudgetFilter } from "../db/users-types";
import type {
	ApiKeyListSortField,
	ApiKeyListSortOrder,
} from "../db/api-keys-list-sort";
import type {
	UserListSortField,
	UserListSortOrder,
} from "../db/users-list-sort";
import type { ProviderProtocolBases } from "../db/providers-types";
import type { SystemConfigRow } from "../db/system-config-types";
import type {
	AdminApiKeyListItem,
	EntityCountSnapshot,
	ModelAnalyticsRow,
	ModelEndpointDiscoveryRouteBindingRow,
	PublicModelAnalyticsRow,
	ModelProviderReliabilityRow,
	ModelRouteDetailRow,
	ModelRouteJoinRow,
	ModelWithRouteCountsRow,
	ProviderAdminRow,
	ProviderAnalyticsRow,
	ProviderReliabilityRow,
	RequestStatsByRangeRow,
	RequestActivityGroupRow,
	RequestTimeseriesRow,
	ThroughputSnapshot,
	UserAnalyticsRow,
	UserTokenTimeseriesRow,
} from "./repository-dtos";
import type { ResolvedModelSurfaceRow } from "../route-topology";
import type {
	RoutePoolStickyBindingRow,
	RoutePoolStickyBindingTargetCount,
} from "../db/route-pool-sticky-types";
import type {
	AdminApiKeyRow,
	AdminSessionRow,
	InsertAdminApiKeyParams,
} from "../db/admin-access-types";
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
} from "../db/shared-keys-types";
import type {
	AddRequestPresetVersionParams,
	CreateRequestPresetParams,
	RequestPresetRow,
	RequestPresetPage,
	RequestPresetVersionRow,
	RequestPresetVersionPage,
	RequestPresetWithVersionRow,
	UpdateRequestPresetMetadataPatch,
} from "../db/request-presets-types";
import type {
	AddGuardrailVersionParams,
	CreateGuardrailParams,
	EffectiveGuardrailRow,
	GuardrailAssignmentRow,
	GuardrailMutationOptions,
	GuardrailScopeType,
	GuardrailVersionRow,
	GuardrailWithVersionRow,
	UpdateGuardrailMetadataPatch,
	UpsertGuardrailAssignmentParams,
} from "../db/guardrails-types";
import type {
	InvalidateRouteDataPoliciesParams,
	RouteDataPolicyAdminRow,
	RouteDataPolicyAuditRow,
	RouteDataPolicyRow,
	UpsertRouteDataPolicyParams,
} from "../db/route-data-policy-types";
import type {
	InsertUnpublishedModelEndpointParams,
	LinkModelEndpointRouteParams,
	ModelEndpointListFilters,
	ModelEndpointRouteLinkRow,
	ModelEndpointRow,
	ModelEndpointRuntimeBindingRow,
	ModelEndpointStatus,
	PublishVerifiedModelEndpointParams,
	UnlinkModelEndpointRouteParams,
	UpdateUnpublishedModelEndpointParams,
} from "../db/model-endpoints-types";
import type {
	InsertManagementApiKeyParams,
	ManagementApiKeyAccount,
	ManagementApiKeyRow,
} from "../db/management-api-keys-types";
import type {
	ByokKeyInsertParams,
	ByokKeyListPage,
	ByokKeyReorderParams,
	ByokKeyReorderResult,
	ByokKeyRow,
	ByokRuntimeKeyRow,
	ByokKeyUpdateParams,
	ByokManagementMutation,
	ByokRuntimeLookup,
} from "../db/byok-keys-types";
import type {
	AdvanceBatchValidationParams,
	AdvanceBatchValidationResult,
	BatchLeaseParams,
	BatchItemRow,
	BatchPage,
	BatchRow,
	ClaimNextBatchItemParams,
	ClaimNextBatchItemResult,
	CompleteBatchValidationParams,
	CreateBatchParams,
	CreateBatchResult,
	FailBatchExecutionPreflightParams,
	FailBatchExecutionPreflightResult,
	FailBatchValidationParams,
	ListBatchesParams,
	MarkBatchItemDispatchStartedParams,
	ReleaseBatchItemBeforeDispatchParams,
} from "../db/batch-types";

/** Batch metadata only. Prompt and response bodies never cross this repository boundary. */
export interface BatchesRepository {
	/** Persist a validating batch, or classify an exact idempotent replay. */
	create(params: CreateBatchParams): Promise<CreateBatchResult>;
	/** Account + Workspace scoping is mandatory; cross-tenant IDs resolve to null. */
	getByIdInWorkspace(
		id: string,
		accountId: string,
		workspaceId: string
	): Promise<BatchRow | null>;
	/** Internal Queue lookup. Callers must never expose this unscoped method to HTTP. */
	getByIdForDispatch(id: string): Promise<BatchRow | null>;
	/** Newest-first keyset page for the OpenRouter-compatible list surface. */
	listByWorkspace(params: ListBatchesParams): Promise<BatchPage>;
	/** Internal bounded scan used to repair lost Queue sends and expired leases. */
	listDispatchCandidates(nowIso: string, limit?: number): Promise<BatchRow[]>;
	/** Acquire only an absent/expired validating or in-progress lease via revision CAS. */
	claimLease(params: BatchLeaseParams): Promise<BatchRow | null>;
	/** Extend only the caller's still-live lease via revision CAS. */
	renewLease(params: BatchLeaseParams): Promise<BatchRow | null>;
	/** Atomically append a body-free validation chunk and advance its R2 byte cursor. */
	advanceValidation(
		params: AdvanceBatchValidationParams
	): Promise<AdvanceBatchValidationResult>;
	/** Enter in_progress only after every expected item and byte has been validated. */
	completeValidation(
		params: CompleteBatchValidationParams
	): Promise<BatchRow | null>;
	/** Fail closed on a terminal input/ledger validation error under the same lease. */
	failValidation(params: FailBatchValidationParams): Promise<BatchRow | null>;
	/**
	 * Claim or renew the lowest non-terminal item under a live in_progress batch
	 * lease. A prior dispatch marker is surfaced as outcome_unknown and is never
	 * silently replayed.
	 */
	claimNextItem(
		params: ClaimNextBatchItemParams
	): Promise<ClaimNextBatchItemResult>;
	/**
	 * Commit the irreversible no-replay boundary before marking budget leases
	 * dispatched and before issuing the upstream request.
	 */
	markItemDispatchStarted(
		params: MarkBatchItemDispatchStartedParams
	): Promise<BatchItemRow | null>;
	/** Release only a still-live owned item that has not crossed the dispatch fence. */
	releaseItemBeforeDispatch(
		params: ReleaseBatchItemBeforeDispatchParams
	): Promise<BatchItemRow | null>;
	/**
	 * Atomically fail every undispatched open item and the parent Batch when
	 * consumption-time Gateway-key authorization fails. A dispatch marker wins.
	 */
	failExecutionPreflight(
		params: FailBatchExecutionPreflightParams
	): Promise<FailBatchExecutionPreflightResult>;
}

export interface ManagementApiKeysRepository {
	getActiveBySecret(secret: string): Promise<ManagementApiKeyRow | null>;
	listByAccount(
		account: ManagementApiKeyAccount,
		options?: { includeRevoked?: boolean }
	): Promise<ManagementApiKeyRow[]>;
	getByIdInAccount(
		id: string,
		account: ManagementApiKeyAccount
	): Promise<ManagementApiKeyRow | null>;
	insert(params: InsertManagementApiKeyParams): Promise<void>;
	revokeByIdInAccount(
		id: string,
		account: ManagementApiKeyAccount,
		nowIso: string,
		actorUserId: string
	): Promise<boolean>;
	workspaceBelongsToAccount(
		workspaceId: string,
		account: ManagementApiKeyAccount
	): Promise<boolean>;
}

/** Account-scoped, encrypted bring-your-own-provider credentials. */
export interface ByokKeysRepository {
	listForAccount(
		account: ManagementApiKeyAccount,
		options: {
			offset: number;
			limit: number;
			workspaceId?: string;
			provider?: string;
		}
	): Promise<ByokKeyListPage>;
	getByIdInAccount(
		id: string,
		account: ManagementApiKeyAccount
	): Promise<ByokKeyRow | null>;
	insertForManagement(params: ByokKeyInsertParams): Promise<ByokKeyRow | null>;
	updateForManagement(params: ByokKeyUpdateParams): Promise<ByokKeyRow | null>;
	reorderForManagement(params: ByokKeyReorderParams): Promise<ByokKeyReorderResult>;
	deleteForManagement(params: ByokManagementMutation): Promise<boolean>;
	/** Bounded, deterministic runtime candidates: primary first, fallback last. */
	listActiveForRequest(params: ByokRuntimeLookup): Promise<ByokRuntimeKeyRow[]>;
	/**
	 * Whether an eligible prioritized credential forbids shared/platform
	 * capacity for this provider and model. The matching-model policy applies
	 * every filter; the strongest provider-wide policy intentionally ignores
	 * only model filters. Member and Gateway-key filters always scope both.
	 */
	shouldSuppressSharedCapacityForRequest(params: ByokRuntimeLookup): Promise<boolean>;
}

export interface ModelEndpointsRepository {
	/** Bounded list; implementations cap the result at 100 rows. */
	list(filters?: ModelEndpointListFilters): Promise<ModelEndpointRow[]>;
	listByModelId(
		modelId: string,
		options?: { status?: ModelEndpointStatus; limit?: number; offset?: number }
	): Promise<ModelEndpointRow[]>;
	getById(id: string): Promise<ModelEndpointRow | null>;
	/** Exact immutable identity lookup; production repositories implement this for bounded audits. */
	getByIdentity?(
		modelId: string,
		providerId: string,
		tag: string
	): Promise<ModelEndpointRow | null>;
	/** Inserts only draft/disabled rows; verified publication is atomic below. */
	insert(params: InsertUnpublishedModelEndpointParams): Promise<void>;
	/** Updates claims only while forcing the endpoint into a non-public state. */
	updateUnpublished(
		id: string,
		params: UpdateUnpublishedModelEndpointParams
	): Promise<number>;
	delete(id: string): Promise<number>;
	/** One bounded batch query; callers must pass no more than 100 endpoint ids. */
	listRouteLinks(endpointIds: string[]): Promise<ModelEndpointRouteLinkRow[]>;
	/**
	 * Lightweight endpoint-link -> route-target/pool projection for discovery.
	 * Input is capped at 100 ids; implementations return at most 1,001 rows so
	 * callers can fail closed at the 1,000 public binding ceiling.
	 */
	listDiscoveryRouteBindings(
		endpointIds: string[]
	): Promise<ModelEndpointDiscoveryRouteBindingRow[]>;
	/** Hot-path route -> verified endpoint lookup; raw input is capped at 100 ids. */
	listRuntimeBindingsByRouteTargetIds(
		routeTargetIds: string[]
	): Promise<ModelEndpointRuntimeBindingRow[]>;
	/** Atomically links a route and invalidates verified publication when needed. */
	linkRoute(params: LinkModelEndpointRouteParams): Promise<boolean>;
	/**
	 * Atomically publishes endpoint claims and the exact validated route-subject set.
	 * Returns false when the endpoint/link snapshot changed before the write boundary.
	 */
	publishVerified(params: PublishVerifiedModelEndpointParams): Promise<boolean>;
	unlinkRoute(params: UnlinkModelEndpointRouteParams): Promise<number>;
}

export interface RequestPresetsRepository {
	listOwnedByWorkspace(
		workspaceId: string,
		userId: string,
		includeArchived?: boolean
	): Promise<RequestPresetWithVersionRow[]>;
	listAll(includeArchived?: boolean): Promise<RequestPresetWithVersionRow[]>;
	listVisibleByWorkspacePage(
		workspaceId: string,
		userId: string,
		page: { offset: number; limit: number }
	): Promise<RequestPresetPage>;
	getById(id: string): Promise<RequestPresetWithVersionRow | null>;
	getByIdInWorkspace(
		id: string,
		workspaceId: string
	): Promise<RequestPresetWithVersionRow | null>;
	getBySlug(
		slug: string,
		workspaceId: string
	): Promise<RequestPresetWithVersionRow | null>;
	getAccessibleBySlug(
		slug: string,
		workspaceId: string,
		userId: string
	): Promise<RequestPresetWithVersionRow | null>;
	getVisibleBySlug(
		slug: string,
		workspaceId: string,
		userId: string
	): Promise<RequestPresetWithVersionRow | null>;
	listVersions(presetId: string): Promise<RequestPresetVersionRow[]>;
	listVersionsPage(
		presetId: string,
		page: { offset: number; limit: number }
	): Promise<RequestPresetVersionPage>;
	getVersion(
		presetId: string,
		version: number
	): Promise<RequestPresetVersionRow | null>;
	createWithVersion(
		params: CreateRequestPresetParams
	): Promise<RequestPresetWithVersionRow>;
	addVersion(
		params: AddRequestPresetVersionParams
	): Promise<RequestPresetWithVersionRow>;
	updateMetadata(
		id: string,
		patch: UpdateRequestPresetMetadataPatch
	): Promise<boolean>;
	designateVersion(
		id: string,
		version: number,
		nowIso: string
	): Promise<boolean>;
}

export interface GuardrailsRepository {
	listOwnedByWorkspace(
		workspaceId: string,
		userId: string,
		includeArchived?: boolean
	): Promise<GuardrailWithVersionRow[]>;
	listAll(includeArchived?: boolean): Promise<GuardrailWithVersionRow[]>;
	getById(id: string): Promise<GuardrailWithVersionRow | null>;
	getByIdInWorkspace(
		id: string,
		workspaceId: string
	): Promise<GuardrailWithVersionRow | null>;
	listVersions(guardrailId: string): Promise<GuardrailVersionRow[]>;
	listAssignments(guardrailId: string): Promise<GuardrailAssignmentRow[]>;
	getEffectiveForRequest(
		workspaceId: string,
		userId: string,
		apiKeyId: string
	): Promise<EffectiveGuardrailRow[]>;
	createWithVersion(
		params: CreateGuardrailParams
	): Promise<GuardrailWithVersionRow>;
	addVersion(
		params: AddGuardrailVersionParams
	): Promise<GuardrailWithVersionRow | null>;
	updateMetadata(
		id: string,
		patch: UpdateGuardrailMetadataPatch
	): Promise<boolean>;
	designateVersion(
		id: string,
		version: number,
		nowIso: string,
		options?: GuardrailMutationOptions
	): Promise<boolean>;
	upsertAssignment(
		params: UpsertGuardrailAssignmentParams
	): Promise<GuardrailAssignmentRow>;
	deleteAssignment(
		workspaceId: string,
		scopeType: GuardrailScopeType,
		scopeId: string,
		createdByUserId?: string
	): Promise<boolean>;
	getSettledBudgetSpent(
		workspaceId: string,
		scopeType: GuardrailScopeType,
		scopeId: string,
		sinceIso: string
	): Promise<number>;
}

export interface GuardrailBudgetsRepository {
	/** Atomically reserves every user/API-key policy or none of them. */
	reserveMany(
		params: ReserveGuardrailBudgetsParams
	): Promise<ReserveGuardrailBudgetsResult>;
	/**
	 * Extends an already-dispatched BYOK Gateway-key reservation with the
	 * charged-budget intents required before shared/platform fallback.
	 */
	extendDispatched(
		params: ExtendDispatchedGuardrailBudgetsParams
	): Promise<ReserveGuardrailBudgetsResult>;
	/** Transfers lifecycle ownership to the upstream dispatch path. */
	markDispatched(
		requestId: string,
		nowIso: string,
		expiresAtIso: string
	): Promise<boolean>;
	/** Releases only leases that have never been dispatched. */
	releaseMany(
		requestId: string,
		nowIso: string,
		reason: string
	): Promise<number>;
	/** Conservatively consumes the full ceiling after dispatch when exact usage cannot be persisted. */
	forfeitMany(
		requestId: string,
		nowIso: string,
		reason: string
	): Promise<number>;
	/**
	 * Reclaims abandoned leases. Undispatched leases are released; dispatched
	 * leases are conservatively charged at their reserved ceiling.
	 */
	expireBefore(nowIso: string, limit?: number): Promise<number>;
}

export interface UserBudgetReservationsRepository {
	/** Atomically admits one finite ordinary-user budget lease. */
	reserve(params: ReserveUserBudgetParams): Promise<ReserveUserBudgetResult>;
	/** Transfers lifecycle ownership to the upstream dispatch path. */
	markDispatched(
		requestId: string,
		nowIso: string,
		expiresAtIso: string
	): Promise<boolean>;
	/** Releases a lease only before dispatch; returns 1 when already released, otherwise 0 on an illegal/missing lease. */
	release(requestId: string, nowIso: string, reason: string): Promise<number>;
	/** Conservatively charges after dispatch; returns 1 when already expired/settled, otherwise 0 on an illegal/missing lease. */
	forfeitDispatched(
		requestId: string,
		nowIso: string,
		reason: string
	): Promise<number>;
	/** Releases expired reserved leases and forfeits expired dispatched leases. */
	expireBefore(nowIso: string, limit?: number): Promise<number>;
}

export interface RouteDataPoliciesRepository {
	listAll(): Promise<RouteDataPolicyAdminRow[]>;
	getByRouteTargetIds(routeTargetIds: string[]): Promise<RouteDataPolicyRow[]>;
	getByRouteTargetId(routeTargetId: string): Promise<RouteDataPolicyRow | null>;
	listAudit(routeTargetId: string): Promise<RouteDataPolicyAuditRow[]>;
	upsertWithAudit(
		params: UpsertRouteDataPolicyParams
	): Promise<RouteDataPolicyRow>;
	invalidateForRouteTarget(
		routeTargetId: string,
		params: InvalidateRouteDataPoliciesParams
	): Promise<number>;
	invalidateForProvider(
		providerId: string,
		params: InvalidateRouteDataPoliciesParams
	): Promise<number>;
}

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
			status?: "active" | "revoked";
			revokedAt?: string | null;
		}
	): Promise<boolean>;
	rotateApiKey(id: string, secretKey: string): Promise<boolean>;
	revokeApiKey(id: string): Promise<boolean>;
	touchApiKey(id: string): Promise<void>;
	insertSession(session: AdminSessionRow): Promise<void>;
	getValidSession(
		tokenHash: string,
		nowIso: string
	): Promise<AdminSessionRow | null>;
	deleteSession(tokenHash: string): Promise<void>;
	deleteExpiredSessions(nowIso: string): Promise<void>;
}

/** 管理端分析聚合 */
export interface AdminAnalyticsRepository {
	queryModelAnalytics(options: {
		start: string;
		end: string;
		tag?: string;
		providerId?: string;
		userEmail?: string;
	}): Promise<ModelAnalyticsRow[]>;
	/** 公开排行专用：只读按日、按模型预聚合表，禁止回退扫描原始请求日志。 */
	queryPublicModelAnalytics(options: {
		startDate: string;
		endDate: string;
	}): Promise<PublicModelAnalyticsRow[]>;
	queryDistinctModelTags(): Promise<string[]>;
	queryUserAnalytics(options: {
		start: string;
		end: string;
		email?: string;
	}): Promise<UserAnalyticsRow[]>;
	queryProviderAnalytics(options: {
		start: string;
		end: string;
		tag?: string;
		modelId?: string;
		routeGroup?: string;
	}): Promise<ProviderAnalyticsRow[]>;
	queryProviderReliability(options: {
		start: string;
		end: string;
	}): Promise<ProviderReliabilityRow[]>;
	queryModelProviderReliability(options: {
		start: string;
		end: string;
	}): Promise<ModelProviderReliabilityRow[]>;
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
	/** Current-key metadata lookup after the same Gateway key has authenticated. */
	getCurrentById(id: string): Promise<ManagementGatewayKeyRow | null>;
	listForManagement(
		params: ManagementGatewayKeyListParams
	): Promise<ManagementGatewayKeyRow[]>;
	getByHashForManagement(
		params: ManagementGatewayKeyLookupParams
	): Promise<ManagementGatewayKeyRow | null>;
	updateByHashForManagement(
		params: ManagementGatewayKeyLookupParams,
		patch: ManagementGatewayKeyPatch
	): Promise<boolean>;
	deleteByHashForManagement(
		params: ManagementGatewayKeyLookupParams
	): Promise<boolean>;
	getApiKeyByKey(key: string): Promise<ApiKeyRow | null>;
	getApiKeyByKeyAnyStatus(key: string): Promise<ApiKeyRow | null>;
	getApiKeyById(id: string): Promise<ApiKeyRow | null>;
	getApiKeyWithUserByKey(key: string): Promise<ResolvedGatewayKeyRow | null>;
	/**
	 * Internal asynchronous reauthorization by the irreversible lookup hash.
	 * Applies the same active Key, user, Workspace, organization, membership,
	 * and expiry predicates as bearer authentication without requiring plaintext.
	 */
	getActiveApiKeyWithUserByLookupHash(
		keyHash: string
	): Promise<ResolvedGatewayKeyRow | null>;
	getApiKeyWithUserById(id: string): Promise<ResolvedGatewayKeyRow | null>;
	listKeysByUserId(
		userId: string,
		options?: { status?: string }
	): Promise<ApiKeyRow[]>;
	listKeysByWorkspaceId(
		workspaceId: string,
		options?: { status?: string; creatorUserId?: string }
	): Promise<ApiKeyRow[]>;
	getApiKeyByIdInWorkspace(
		id: string,
		workspaceId: string
	): Promise<ApiKeyRow | null>;
	insertApiKey(params: InsertKeyParams): Promise<void>;
	revokeApiKey(id: string): Promise<boolean>;
	revokeApiKeyInWorkspace(
		id: string,
		workspaceId: string,
		creatorUserId?: string
	): Promise<boolean>;
	deleteApiKeyHard(id: string, secretKey: string): Promise<boolean>;
	updateApiKeyStatusById(id: string, status: string): Promise<boolean>;
	setApiKeyMetadataById(
		id: string,
		metadataJson: string | null
	): Promise<boolean>;
	/** Idempotent online migration: replace legacy plaintext bearer values with hash references. */
	scrubLegacyApiKeySecrets(
		limit?: number
	): Promise<{ scrubbed: number; remaining: number }>;
	updateApiKeyName(id: string, name: string | null): Promise<boolean>;
	getAllApiKeys(options?: {
		email?: string;
		userId?: string;
		workspaceId?: string;
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
	getByExternalPair(
		externalSystem: string,
		externalUserId: string
	): Promise<UserRow | null>;
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
	setUserMetadataById(
		id: string,
		metadataJson: string | null
	): Promise<boolean>;
	setUserChargedCostFactorsById(
		id: string,
		chargedCostFactorsJson: string | null
	): Promise<boolean>;
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
	getModelDetailWithRouteCounts(
		id: string
	): Promise<ModelWithRouteCountsRow | null>;
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
	updateModelByPatch(
		id: string,
		rest: Record<string, unknown>
	): Promise<number>;
	deleteModelCascade(id: string): Promise<number>;
}

/** 推理路径：模型行（含 tags）、活跃路由列表、按 modelId 取路由 */
export interface ModelRoutingRepository {
	getModelById(id: string): Promise<ModelRow | null>;
	listModelsWithActiveRoutes(): Promise<ModelRow[]>;
	/**
	 * Returns at most MAX_CALLABLE_EMBEDDING_MODEL_QUERY_RESULTS model rows that
	 * have an active OpenAI embeddings route/surface. The output-modality SQL
	 * predicate is deliberately only a safe prefilter; callers must still apply
	 * isEmbeddingModel so malformed legacy JSON fails closed.
	 */
	listCallableEmbeddingModelCandidates(): Promise<ModelRow[]>;
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
	listModelRoutesWithJoins(filters: {
		modelId?: string;
		providerId?: string;
		/** Optional bounded read for previews and public control surfaces. */
		limit?: number;
	}): Promise<ModelRouteJoinRow[]>;
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
		routingMetadata: string | null;
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
	updateModelRouteByPatch(
		id: string,
		patch: Record<string, unknown>
	): Promise<number>;
	deleteModelRouteById(id: string): Promise<number>;
	/** Delete pool (and its surfaces) only when it has no model_routes targets. */
	deleteRoutePoolIfEmpty(poolId: string): Promise<boolean>;
}

/** Shared Provider sticky bindings (cross-isolate / cross-instance). */
export interface RoutePoolStickyBindingsRepository {
	getBinding(
		routePoolId: string,
		affinityHash: string
	): Promise<RoutePoolStickyBindingRow | null>;
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
	/** Bounded provider read; callers must pass no more than 100 raw ids. */
	getProvidersByIds(ids: string[]): Promise<ProviderRow[]>;
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
	updateProviderByPatch(
		id: string,
		body: Record<string, unknown>
	): Promise<number>;
	deleteProviderById(id: string): Promise<number>;
	getProviderById(id: string): Promise<ProviderRow | null>;
	getProviderRowById(id: string): Promise<ProviderAdminRow | null>;
	getProviderProtocolBases(
		providerId: string
	): Promise<ProviderProtocolBases | null>;
	/** 读取 providers.api_key 明文（仅服务端推理/管理用）。 */
	getProviderApiKeyPlaintext(
		providerId: string
	): Promise<{ api_key: string } | null>;
}

/** Filters for {@link RequestLogsRepository.getRequestLogsByKeyId}. If `includeStatuses` is non-empty after whitelist, use `status IN (...)`; else if `excludeStatus` is set, use `(status IS NULL OR status != ?)`; else no status predicate. */
export type RequestLogsByKeyIdFilter = {
	excludeStatus?: string;
	includeStatuses?: string[];
};

export interface RequestLogsRepository {
	/**
	 * Execute an OpenRouter-shaped analytics query inside the authenticated
	 * Management principal's account boundary. Storage must enforce that
	 * boundary in SQL rather than relying on caller-supplied Workspace filters.
	 */
	queryManagementAnalytics(
		query: ManagementAnalyticsQuery
	): Promise<ManagementAnalyticsQueryResult>;
	/**
	 * Atomically records feedback only when the generation and Management key
	 * belong to the same personal or organization account. A false result is an
	 * indistinguishable missing/foreign/revoked-key outcome.
	 */
	insertGenerationFeedbackForManagementAccount(
		params: InsertGenerationFeedbackForManagementAccountParams
	): Promise<boolean>;
	/**
	 * Resolve one generation within the authenticated user's current Workspace.
	 * All three predicates must be enforced by the storage query itself; callers
	 * must not fetch a broader row set and filter it in application memory.
	 */
	getRequestLogByIdForOwner(options: {
		id: string;
		userId: string;
		workspaceId: string;
	}): Promise<GenerationRequestLogRow | null>;
	getRequestLogsByKeyId(
		apiKeyId: string,
		page: number,
		pageSize: number,
		filter?: RequestLogsByKeyIdFilter
	): Promise<{ logs: RequestLogRow[]; total: number }>;
	getRequestLogs(options: {
		page?: number;
		pageSize?: number;
		/** Server-controlled resource boundary inherited from the owning Gateway Key. */
		workspaceId?: string;
		apiKeyId?: string;
		userId?: string;
		userEmail?: string;
		modelId?: string;
		providerId?: string;
		/** Public provider display-name snapshot captured on the request log. */
		providerName?: string;
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
		/** Optional tenant boundary for ordinary-user Activity summaries. */
		userId?: string;
		/** Optional Workspace boundary, resolved through the owning Gateway Key. */
		workspaceId?: string;
		apiKeyId?: string;
		modelId?: string;
		/** Public provider display-name snapshot captured on the request log. */
		providerName?: string;
		status?: string;
	}): Promise<RequestStatsByRangeRow>;
	/** Bounded ordinary-user Activity aggregation; dimensions are fixed to public model/key/provider identifiers. */
	getRequestActivityGroups(options: {
		startDate: string;
		endDate: string;
		endExclusive?: boolean;
		userId: string;
		workspaceId: string;
		apiKeyId?: string;
		modelId?: string;
		/** Public provider display-name snapshot captured on the request log. */
		providerName?: string;
		status?: string;
		dimension: 'model' | 'apiKey' | 'provider';
		limit: number;
	}): Promise<RequestActivityGroupRow[]>;
	queryRequestTimeseries(options: {
		startDate: string;
		endDate: string;
		endExclusive?: boolean;
		granularity: "hour" | "day";
		/** Optional tenant boundary for ordinary-user Activity trends. */
		userId?: string;
		/** Optional Workspace boundary for ordinary-user Activity trends. */
		workspaceId?: string;
		apiKeyId?: string;
		modelId?: string;
		/** Public provider display-name snapshot captured on the request log. */
		providerName?: string;
		status?: string;
	}): Promise<RequestTimeseriesRow[]>;
	queryUserTokenTimeseries(options: {
		startDate: string;
		endDate: string;
		granularity: "hour" | "day";
		userEmails: string[];
	}): Promise<UserTokenTimeseriesRow[]>;
	getThroughputLastMinute(): Promise<ThroughputSnapshot>;
	getRecentLogs(limit: number): Promise<RequestLogRow[]>;
	getRecentErrors(limit: number): Promise<RequestLogRow[]>;
	getRecentRoutePerformanceSamples(options: {
		routeTargetIds: string[];
		sinceIso: string;
		/** Independent cap for each route target, never a shared/global row limit. */
		maxSamplesPerRoute: number;
	}): Promise<RoutePerformanceSample[]>;
	getRouteAvailabilityAggregates(options: {
		routeTargetIds: string[];
		since5mIso: string;
		since30mIso: string;
		since1dIso: string;
	}): Promise<RouteAvailabilityAggregate[]>;
	/** Bounded oldest-first hygiene; never deletes inside request settlement. */
	deleteProviderAttemptAvailabilityBefore(options: {
		cutoffIso: string;
		limit: number;
	}): Promise<number>;
	getDistinctActiveUsersCount(options: {
		startDate: string;
		endDate: string;
		endExclusive?: boolean;
	}): Promise<number>;
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
	getValidSession(
		tokenHash: string,
		nowIso: string
	): Promise<PortalSessionRow | null>;
	deleteSession(tokenHash: string): Promise<void>;
	deleteExpiredSessions(nowIso: string): Promise<void>;
}

/** 卖家共享密钥（上架/调度/停用）。 */
export interface SharedKeysRepository {
	insertSharedKey(params: InsertSharedKeyParams): Promise<void>;
	getSharedKeyById(id: string): Promise<SharedKeyRow | null>;
	listSharedKeysBySeller(sellerUserId: string): Promise<SharedKeyRow[]>;
	listAllSharedKeys(options?: {
		status?: string;
		channelType?: string;
	}): Promise<SharedKeyRow[]>;
	/** 调度候选：指定渠道全部 active key，已按固定顺序排好（seller_priority DESC → weight DESC → id ASC）。 */
	listActiveSharedKeysByChannel(channelType: string): Promise<SharedKeyRow[]>;
	updateSharedKey(id: string, patch: UpdateSharedKeyPatch): Promise<boolean>;
	/** Internal encryption migration/write path; never exposed to an HTTP route. */
	replaceSharedKeySecret?(
		id: string,
		protectedSecret: string
	): Promise<boolean>;
	/** 上游 401/403 或校验失败：置 invalid 并记录原因。 */
	markSharedKeyFailure(
		id: string,
		reason: string,
		nowIso: string
	): Promise<void>;
	deleteSharedKey(id: string): Promise<boolean>;
	/** 收益入账后累计使用统计（与收益事务同批执行）。 */
	addSharedKeyUsage(
		id: string,
		inputTokens: number,
		outputTokens: number,
		netAmount: number,
		nowIso: string
	): Promise<void>;
}

/** 门户账本：卖家收益、余额、提现、NFT 铸造。 */
export interface PortalLedgerRepository {
	getUserEarnings(userId: string): Promise<UserEarningsRow | null>;
	/** 幂等建立 1:1 账本行（首次登录/首次上架时调用）。 */
	ensureUserEarnings(userId: string): Promise<void>;
	updateWallet(
		userId: string,
		walletAddress: string | null,
		verifiedAtIso: string | null
	): Promise<void>;
	/** 幂等插入收益流水；重复 `request_log_id` 返回 false。 */
	insertEarning(params: InsertSharedKeyEarningParams): Promise<boolean>;
	/**
	 * 幂等写入收益流水并在同一数据库事务中增加卖家余额。
	 * 重复 `request_log_id` 不得再次入账。
	 */
	recordEarningAndCredit(
		params: InsertSharedKeyEarningParams
	): Promise<boolean>;
	/** 收益入账：balance/contribution_value/lifetime_earned 增加 net（与请求计费同批/独立事务均可）。 */
	creditEarningBalance(
		sellerUserId: string,
		netAmount: number,
		nowIso: string
	): Promise<void>;
	listEarningsBySeller(
		sellerUserId: string,
		page: number,
		pageSize: number
	): Promise<{ rows: SharedKeyEarningRow[]; total: number }>;
	insertWithdrawal(params: InsertWithdrawalParams): Promise<void>;
	/** Atomically creates the withdrawal and locks its balance. */
	createWithdrawalWithBalanceLock(
		params: InsertWithdrawalParams
	): Promise<"created" | "insufficient_balance" | "active_withdrawal_exists">;
	getWithdrawal(id: string): Promise<WithdrawalRow | null>;
	/** requested | processing | submitted 任一状态的进行中提现单。 */
	getActiveWithdrawalByUser(userId: string): Promise<WithdrawalRow | null>;
	listWithdrawalsByUser(
		userId: string,
		page: number,
		pageSize: number
	): Promise<{ rows: WithdrawalRow[]; total: number }>;
	listAllWithdrawals(status?: string): Promise<WithdrawalRow[]>;
	/** @deprecated Use createWithdrawalWithBalanceLock for new callers. */
	lockBalanceForWithdrawal(
		userId: string,
		amount: number,
		nowIso: string
	): Promise<boolean>;
	/** 提现确认：locked_amount -= amount, lifetime_withdrawn += amount, status=confirmed。 */
	settleWithdrawalConfirmed(
		id: string,
		userId: string,
		amount: number,
		nowIso: string
	): Promise<void>;
	/** 提现失败/驳回：locked_amount -= amount, balance += amount, status=failed。 */
	refundWithdrawal(
		id: string,
		userId: string,
		amount: number,
		reason: string,
		nowIso: string
	): Promise<void>;
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
	setHighestBadgeTier(
		userId: string,
		tier: number,
		nowIso: string
	): Promise<void>;
}
