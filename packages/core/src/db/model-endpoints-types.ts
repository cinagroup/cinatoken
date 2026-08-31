export const MODEL_ENDPOINT_STATUSES = [
	"draft",
	"verified",
	"disabled",
] as const;

export type ModelEndpointStatus = (typeof MODEL_ENDPOINT_STATUSES)[number];

/** A cross-driver raw database row. SQLite/MySQL may expose booleans as 0/1. */
export interface ModelEndpointRow {
	id: string;
	model_id: string;
	provider_id: string;
	provider_slug: string;
	tag: string;
	endpoint_class: string | null;
	region: string | null;
	context_length: number | null;
	max_prompt_tokens: number | null;
	max_completion_tokens: number | null;
	quantization: string | null;
	/** JSON array of parameter names supported by this endpoint. */
	supported_parameters: string;
	/** JSON object containing endpoint-specific pricing metadata. */
	pricing: string;
	supports_implicit_caching: boolean | 0 | 1 | null;
	supports_voice_cloning: boolean | 0 | 1 | null;
	/** JSON object with `auto`, `function`, `none`, and `required` tri-state booleans. */
	supports_tool_choice: string;
	/** JSON object containing endpoint-specific image capabilities. */
	image_capabilities: string;
	/** JSON object containing exact operation-scoped audio pricing evidence. */
	audio_capabilities?: string;
	evidence_url: string | null;
	verified_by: string | null;
	verified_at: string | null;
	expires_at: string | null;
	status: ModelEndpointStatus;
	created_at: string;
	updated_at: string;
}

export interface ModelEndpointRouteLinkRow {
	endpoint_id: string;
	route_target_id: string;
	subject_fingerprint: string | null;
	created_at: string;
}

/** Verified endpoint row loaded in the inference direction (route -> endpoint). */
export interface ModelEndpointRuntimeBindingRow extends ModelEndpointRow {
	route_target_id: string;
	subject_fingerprint: string | null;
}

export interface ModelEndpointListFilters {
	modelId?: string;
	providerId?: string;
	status?: ModelEndpointStatus;
	/** Defaults to 100 and is capped at 100. */
	limit?: number;
	/** Non-negative deterministic-page offset. */
	offset?: number;
}

export interface InsertModelEndpointParams {
	id: string;
	modelId: string;
	providerId: string;
	providerSlug: string;
	tag: string;
	endpointClass: string | null;
	region: string | null;
	contextLength: number | null;
	maxPromptTokens: number | null;
	maxCompletionTokens: number | null;
	quantization: string | null;
	supportedParameters: string;
	pricing: string;
	supportsImplicitCaching: boolean | null;
	supportsVoiceCloning: boolean | null;
	supportsToolChoice: string;
	imageCapabilities: string;
	/** Omission during phased rollout persists the explicit unknown sentinel. */
	audioCapabilities?: string;
	evidenceUrl: string | null;
	verifiedBy: string | null;
	verifiedAt: string | null;
	expiresAt: string | null;
	status: ModelEndpointStatus;
	createdAt: string;
	updatedAt: string;
}

/**
 * New endpoint rows are never public. Publication must pass through the
 * repository's atomic endpoint + route-subject verification boundary.
 */
export type InsertUnpublishedModelEndpointParams = Omit<
	InsertModelEndpointParams,
	"status" | "verifiedBy" | "verifiedAt"
> & {
	status: Exclude<ModelEndpointStatus, "verified">;
	verifiedBy: null;
	verifiedAt: null;
};

export function assertInsertUnpublishedModelEndpointParams(
	params: InsertModelEndpointParams
): asserts params is InsertUnpublishedModelEndpointParams {
	if (
		(params.status !== "draft" && params.status !== "disabled") ||
		params.verifiedBy !== null ||
		params.verifiedAt !== null
	) {
		throw new TypeError(
			"model endpoint insertion cannot publish verification state"
		);
	}
}

export interface LinkModelEndpointRouteParams {
	endpointId: string;
	routeTargetId: string;
	/** Null until an administrator explicitly verifies this exact route/provider subject. */
	subjectFingerprint: string | null;
	createdAt: string;
	/** Snapshot used to serialize link mutation against endpoint publication. */
	expectedEndpointStatus: ModelEndpointStatus;
	expectedEndpointUpdatedAt: string;
	/** Timestamp used when a verified endpoint must be invalidated atomically. */
	updatedAt: string;
}

export interface PublishModelEndpointRouteSubject {
	routeTargetId: string;
	/** Subject value observed during pre-publication validation. */
	expectedSubjectFingerprint: string | null;
	/** Exact route/provider subject that will be published. */
	subjectFingerprint: string;
}

export interface PublishVerifiedModelEndpointParams {
	endpointId: string;
	expectedStatus: ModelEndpointStatus;
	expectedUpdatedAt: string;
	/** Endpoint claim columns; repository implementations apply the column allowlist. */
	endpointPatch: Record<string, unknown>;
	verifiedBy: string;
	verifiedAt: string;
	updatedAt: string;
	routeSubjects: PublishModelEndpointRouteSubject[];
}

export interface UpdateUnpublishedModelEndpointParams {
	status: Exclude<ModelEndpointStatus, "verified">;
	updatedAt: string;
	/** Endpoint claim columns; publication-reserved columns are always ignored. */
	endpointPatch: Record<string, unknown>;
}

const SUBJECT_FINGERPRINT_RE = /^[0-9a-f]{64}$/u;

export function assertPublishVerifiedModelEndpointParams(
	params: PublishVerifiedModelEndpointParams
): void {
	if (!params.endpointId || !params.verifiedBy) {
		throw new TypeError(
			"model endpoint publication requires endpoint and verifier ids"
		);
	}
	if (!params.expectedUpdatedAt || !params.verifiedAt || !params.updatedAt) {
		throw new TypeError(
			"model endpoint publication requires timestamp snapshots"
		);
	}
	if (
		params.routeSubjects.length < 1 ||
		params.routeSubjects.length > MAX_MODEL_ENDPOINT_LIST_LIMIT
	) {
		throw new RangeError(
			`model endpoint publication requires between 1 and ${MAX_MODEL_ENDPOINT_LIST_LIMIT} route subjects`
		);
	}
	const routeIds = new Set<string>();
	for (const subject of params.routeSubjects) {
		if (!subject.routeTargetId || routeIds.has(subject.routeTargetId)) {
			throw new TypeError(
				"model endpoint publication route subjects must be unique"
			);
		}
		routeIds.add(subject.routeTargetId);
		if (!SUBJECT_FINGERPRINT_RE.test(subject.subjectFingerprint)) {
			throw new TypeError(
				"model endpoint publication subject fingerprint is invalid"
			);
		}
		if (
			subject.expectedSubjectFingerprint !== null &&
			!SUBJECT_FINGERPRINT_RE.test(subject.expectedSubjectFingerprint)
		) {
			throw new TypeError(
				"model endpoint publication expected subject fingerprint is invalid"
			);
		}
	}
}

export interface UnlinkModelEndpointRouteParams {
	endpointId: string;
	routeTargetId: string;
}

export const MAX_MODEL_ENDPOINT_LIST_LIMIT = 100;

/**
 * One extra row over the public 1,000-binding ceiling is returned as an
 * overflow sentinel. Keep this a SQL literal for D1: a 100-id batch already
 * consumes D1's full 100-bound-parameter allowance.
 */
export const MAX_MODEL_ENDPOINT_DISCOVERY_BINDING_RESULTS = 1_001;

export function normalizeModelEndpointListLimit(
	limit: number | undefined
): number {
	if (limit === undefined || !Number.isFinite(limit))
		return MAX_MODEL_ENDPOINT_LIST_LIMIT;
	return Math.min(
		MAX_MODEL_ENDPOINT_LIST_LIMIT,
		Math.max(1, Math.trunc(limit))
	);
}

export function normalizeModelEndpointListOffset(
	offset: number | undefined
): number {
	if (offset === undefined || !Number.isFinite(offset)) return 0;
	return Math.max(0, Math.trunc(offset));
}
