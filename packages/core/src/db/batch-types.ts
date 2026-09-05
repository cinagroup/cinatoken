/** Persisted Batch API metadata. Request and response bodies live only in private object storage. */

export const BATCH_ENDPOINTS = [
	"/v1/chat/completions",
	"/v1/responses",
	"/v1/messages",
	"/v1/embeddings",
] as const;

export type BatchEndpoint = (typeof BATCH_ENDPOINTS)[number];

export const BATCH_STATUSES = [
	"validating",
	"in_progress",
	"finalizing",
	"completed",
	"failed",
	"expired",
	"cancelling",
	"cancelled",
] as const;

export type BatchStatus = (typeof BATCH_STATUSES)[number];

/** OpenRouter-compatible list filters intentionally exclude transient internal states. */
export const BATCH_PUBLIC_LIST_STATUSES = [
	"validating",
	"in_progress",
	"completed",
	"failed",
	"expired",
	"cancelled",
] as const;

export type BatchPublicListStatus =
	(typeof BATCH_PUBLIC_LIST_STATUSES)[number];

export const BATCH_ITEM_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"failed",
	"cancelled",
] as const;

export type BatchItemStatus = (typeof BATCH_ITEM_STATUSES)[number];

export const BATCH_COMPLETION_WINDOW = "24h" as const;
export const DEFAULT_BATCH_LIST_LIMIT = 20;
export const MAX_BATCH_LIST_LIMIT = 100;
export const MAX_BATCH_REQUEST_COUNT = 1_000_000;
export const MAX_BATCH_INPUT_BYTES = 50 * 1024 * 1024;
/** One 1 MiB JSON line plus an optional CRLF delimiter. */
export const MAX_BATCH_ITEM_RANGE_BYTES = 1024 * 1024 + 2;
export const MAX_BATCH_LEASE_MILLISECONDS = 5 * 60 * 1000;
/** Keeps D1 validation chunks comfortably below per-invocation query limits. */
export const MAX_BATCH_VALIDATION_CHUNK_ITEMS = 100;

/**
 * Queue payloads deliberately carry only an opaque batch identifier. Tenant,
 * prompt, credential, and routing data must be reloaded from trusted storage.
 */
export interface BatchDispatchMessage {
	version: 1;
	batch_id: string;
}

export interface BatchRow {
	id: string;
	account_id: string;
	workspace_id: string;
	user_id: string;
	api_key_hash: string;
	endpoint: BatchEndpoint;
	model_id: string;
	route_group: string;
	status: BatchStatus;
	completion_window: typeof BATCH_COMPLETION_WINDOW;
	idempotency_key_hash: string | null;
	input_object_key: string;
	input_sha256: string;
	input_bytes: number;
	result_object_key: string | null;
	result_sha256: string | null;
	request_count: number;
	validation_next_ordinal: number;
	validation_input_offset: number;
	completed_count: number;
	failed_count: number;
	cancelled_count: number;
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	charged_cost_micros: number;
	byok_request_count: number;
	unknown_cost_count: number;
	created_at: string;
	in_progress_at: string | null;
	finalizing_at: string | null;
	finalized_at: string | null;
	expires_at: string;
	retention_expires_at: string;
	lease_owner: string | null;
	lease_expires_at: string | null;
	attempt_count: number;
	revision: number;
	last_error_code: string | null;
	updated_at: string;
}

export interface BatchItemRow {
	id: string;
	batch_id: string;
	ordinal: number;
	custom_id: string;
	status: BatchItemStatus;
	attempt_count: number;
	started_at: string | null;
	dispatch_started_at: string | null;
	completed_at: string | null;
	generation_id: string | null;
	reservation_id: string | null;
	lease_owner: string | null;
	lease_expires_at: string | null;
	request_start_offset: number;
	request_end_offset: number;
	request_sha256: string;
	result_object_key: string | null;
	result_sha256: string | null;
	error_code: string | null;
	error_summary: string | null;
	revision: number;
	created_at: string;
	updated_at: string;
}

export interface CreateBatchParams {
	id: string;
	accountId: string;
	workspaceId: string;
	userId: string;
	apiKeyHash: string;
	endpoint: BatchEndpoint;
	modelId: string;
	routeGroup: string;
	idempotencyKeyHash: string | null;
	inputObjectKey: string;
	inputSha256: string;
	inputBytes: number;
	requestCount: number;
	createdAt: string;
	expiresAt: string;
	retentionExpiresAt: string;
}

export type CreateBatchResult =
	| { status: "created" | "idempotent"; batch: BatchRow }
	| { status: "conflict" };

export interface BatchCursor {
	id: string;
	createdAt: string;
}

export interface ListBatchesParams {
	accountId: string;
	workspaceId: string;
	statuses?: readonly BatchPublicListStatus[];
	createdAfter?: string;
	createdBefore?: string;
	after?: BatchCursor;
	limit?: number;
}

export interface BatchPage {
	batches: BatchRow[];
	hasMore: boolean;
	nextCursor: BatchCursor | null;
}

export interface BatchLeaseParams {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	nowIso: string;
	leaseExpiresAtIso: string;
}

/**
 * Item claims are subordinate to an already-live batch lease. The expected
 * revision therefore refers to the parent batch, not the item row.
 */
export type ClaimNextBatchItemParams = BatchLeaseParams;

export type ClaimNextBatchItemResult =
	| { status: "claimed"; item: BatchItemRow }
	| { status: "empty" }
	| { status: "batch_lease_lost" }
	| { status: "item_lease_contended" }
	| { status: "outcome_unknown"; item: BatchItemRow };

export interface MarkBatchItemDispatchStartedParams {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	itemId: string;
	itemOrdinal: number;
	expectedItemRevision: number;
	generationId: string;
	reservationId: string;
	nowIso: string;
}

export type ReleaseBatchItemBeforeDispatchParams = Omit<
	MarkBatchItemDispatchStartedParams,
	"generationId" | "reservationId"
>;

export const BATCH_EXECUTION_PREFLIGHT_FAILURE_CODES = [
	"batch_key_inactive",
	"batch_authorization_snapshot_mismatch",
] as const;

export type BatchExecutionPreflightFailureCode =
	(typeof BATCH_EXECUTION_PREFLIGHT_FAILURE_CODES)[number];

export interface FailBatchExecutionPreflightParams {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	nowIso: string;
	errorCode: BatchExecutionPreflightFailureCode;
}

/**
 * A dispatch marker always wins over a preflight failure. That outcome must be
 * settled separately and must never be converted into a replayable failure.
 */
export type FailBatchExecutionPreflightResult =
	| { status: "failed"; batch: BatchRow }
	| { status: "empty" }
	| { status: "batch_lease_lost" }
	| { status: "outcome_unknown"; item: BatchItemRow };

/** Body-free item identity committed while validating the private input JSONL. */
export interface BatchValidationItemInput {
	id: string;
	ordinal: number;
	customId: string;
	requestStartOffset: number;
	requestEndOffset: number;
	requestSha256: string;
}

export interface AdvanceBatchValidationParams {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	expectedNextOrdinal: number;
	expectedInputOffset: number;
	nextInputOffset: number;
	items: readonly BatchValidationItemInput[];
	nowIso: string;
}

export type AdvanceBatchValidationResult =
	| { status: "advanced"; batch: BatchRow }
	| { status: "lease_lost" }
	| { status: "conflict" };

export interface CompleteBatchValidationParams {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	nowIso: string;
}

export const BATCH_VALIDATION_FAILURE_CODES = [
	"batch_input_missing",
	"batch_input_integrity",
	"batch_input_invalid",
	"batch_input_count_mismatch",
	"batch_item_conflict",
] as const;

export type BatchValidationFailureCode =
	(typeof BATCH_VALIDATION_FAILURE_CODES)[number];

export interface FailBatchValidationParams extends CompleteBatchValidationParams {
	errorCode: BatchValidationFailureCode;
}

const HEX_SHA256 = /^[0-9a-f]{64}$/u;
const LOOKUP_SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BATCH_ID = /^batch_[A-Za-z0-9_-]{8,122}$/u;
const BATCH_ITEM_ID = /^batch_req_[A-Za-z0-9_-]{8,118}$/u;
const ACCOUNT_ID = /^(?:personal|organization):[^\r\n]+$/u;

function assertBoundedText(
	value: string,
	name: string,
	maxLength: number
): void {
	if (!value || value.length > maxLength) {
		throw new TypeError(`${name} must contain 1-${maxLength} characters`);
	}
}

function instant(value: string, name: string): number {
	const milliseconds = Date.parse(value);
	if (
		!Number.isFinite(milliseconds) ||
		new Date(milliseconds).toISOString() !== value
	) {
		throw new TypeError(`${name} must be a canonical UTC ISO-8601 instant`);
	}
	return milliseconds;
}

export function assertBatchId(value: string): void {
	if (!BATCH_ID.test(value)) {
		throw new TypeError("batch id must use the batch_ prefix and safe characters");
	}
}

export function assertBatchItemId(value: string): void {
	if (!BATCH_ITEM_ID.test(value)) {
		throw new TypeError(
			"batch item id must use the batch_req_ prefix and safe characters"
		);
	}
}

export function isBatchDispatchMessage(
	value: unknown
): value is BatchDispatchMessage {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const candidate = value as Record<string, unknown>;
	const keys = Object.keys(candidate);
	return (
		keys.length === 2 &&
		keys.includes("version") &&
		keys.includes("batch_id") &&
		candidate.version === 1 &&
		typeof candidate.batch_id === "string" &&
		BATCH_ID.test(candidate.batch_id)
	);
}

export function assertBatchTenant(
	accountId: string,
	workspaceId: string
): void {
	assertBoundedText(accountId, "batch account id", 1024);
	if (!ACCOUNT_ID.test(accountId)) {
		throw new TypeError("batch account id must be canonical");
	}
	assertBoundedText(workspaceId, "batch workspace id", 600);
}

export function assertCreateBatchParams(params: CreateBatchParams): void {
	assertBatchId(params.id);
	assertBatchTenant(params.accountId, params.workspaceId);
	assertBoundedText(params.userId, "batch user id", 512);
	if (!LOOKUP_SHA256.test(params.apiKeyHash)) {
		throw new TypeError("batch API key hash must be a sha256 lookup hash");
	}
	if (!(BATCH_ENDPOINTS as readonly string[]).includes(params.endpoint)) {
		throw new TypeError("batch endpoint is unsupported");
	}
	assertBoundedText(params.modelId, "batch model id", 512);
	assertBoundedText(params.routeGroup, "batch route group", 64);
	if (
		params.idempotencyKeyHash !== null &&
		!HEX_SHA256.test(params.idempotencyKeyHash)
	) {
		throw new TypeError("batch idempotency hash must be lowercase SHA-256");
	}
	if (!HEX_SHA256.test(params.inputSha256)) {
		throw new TypeError("batch input hash must be lowercase SHA-256");
	}
	if (
		!Number.isSafeInteger(params.inputBytes) ||
		params.inputBytes < 1 ||
		params.inputBytes > MAX_BATCH_INPUT_BYTES
	) {
		throw new RangeError(
			`batch input bytes must be between 1 and ${MAX_BATCH_INPUT_BYTES}`
		);
	}
	const objectKeySegments = params.inputObjectKey.split("/");
	if (
		params.inputObjectKey.length > 1024 ||
		objectKeySegments.length !== 6 ||
		objectKeySegments[0] !== "v1" ||
		objectKeySegments[1] !== "workspaces" ||
		!HEX_SHA256.test(objectKeySegments[2] ?? "") ||
		objectKeySegments[3] !== "batches" ||
		objectKeySegments[4] !== params.id ||
		objectKeySegments[5] !== "input.jsonl"
	) {
		throw new TypeError("batch input object key is outside the private namespace");
	}
	if (
		!Number.isSafeInteger(params.requestCount) ||
		params.requestCount < 1 ||
		params.requestCount > MAX_BATCH_REQUEST_COUNT
	) {
		throw new RangeError(
			`batch request count must be between 1 and ${MAX_BATCH_REQUEST_COUNT}`
		);
	}
	const createdAt = instant(params.createdAt, "batch createdAt");
	const expiresAt = instant(params.expiresAt, "batch expiresAt");
	const retentionExpiresAt = instant(
		params.retentionExpiresAt,
		"batch retentionExpiresAt"
	);
	if (expiresAt - createdAt !== 24 * 60 * 60 * 1000) {
		throw new RangeError("batch completion window must be exactly 24 hours");
	}
	if (retentionExpiresAt - createdAt !== 30 * 24 * 60 * 60 * 1000) {
		throw new RangeError("batch retention window must be exactly 30 days");
	}
}

export function normalizeBatchListLimit(limit: number | undefined): number {
	if (limit === undefined) return DEFAULT_BATCH_LIST_LIMIT;
	if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_LIST_LIMIT) {
		throw new RangeError(`batch list limit must be between 1 and ${MAX_BATCH_LIST_LIMIT}`);
	}
	return limit;
}

export function normalizeBatchListStatuses(
	statuses: readonly BatchPublicListStatus[] | undefined
): BatchPublicListStatus[] {
	if (statuses === undefined) return [];
	const unique = [...new Set(statuses)];
	if (
		unique.length === 0 ||
		unique.some(
			(status) =>
				!(BATCH_PUBLIC_LIST_STATUSES as readonly string[]).includes(status)
		)
	) {
		throw new TypeError("batch status filter contains an unsupported status");
	}
	return unique;
}

export function assertListBatchesParams(params: ListBatchesParams): void {
	assertBatchTenant(params.accountId, params.workspaceId);
	normalizeBatchListLimit(params.limit);
	normalizeBatchListStatuses(params.statuses);
	const createdAfter = params.createdAfter
		? instant(params.createdAfter, "batch createdAfter")
		: null;
	const createdBefore = params.createdBefore
		? instant(params.createdBefore, "batch createdBefore")
		: null;
	if (
		createdAfter !== null &&
		createdBefore !== null &&
		createdAfter >= createdBefore
	) {
		throw new RangeError("batch createdAfter must be earlier than createdBefore");
	}
	if (params.after) {
		assertBatchId(params.after.id);
		instant(params.after.createdAt, "batch cursor createdAt");
	}
}

export function assertBatchLeaseParams(params: BatchLeaseParams): void {
	assertBatchId(params.id);
	assertBatchTenant(params.accountId, params.workspaceId);
	assertBoundedText(params.owner, "batch lease owner", 128);
	if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
		throw new RangeError("batch expected revision must be a non-negative integer");
	}
	const now = instant(params.nowIso, "batch lease now");
	const expiresAt = instant(
		params.leaseExpiresAtIso,
		"batch lease expiration"
	);
	if (
		expiresAt <= now ||
		expiresAt - now > MAX_BATCH_LEASE_MILLISECONDS
	) {
		throw new RangeError("batch lease must be positive and no longer than five minutes");
	}
}

export function assertClaimNextBatchItemParams(
	params: ClaimNextBatchItemParams
): void {
	assertBatchLeaseParams(params);
}

function assertBatchWorkerIdentity(params: {
	id: string;
	accountId: string;
	workspaceId: string;
	owner: string;
	expectedRevision: number;
	nowIso: string;
}): void {
	assertBatchId(params.id);
	assertBatchTenant(params.accountId, params.workspaceId);
	assertBoundedText(params.owner, "batch lease owner", 128);
	if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
		throw new RangeError("batch expected revision must be a non-negative integer");
	}
	instant(params.nowIso, "batch worker now");
}

export function assertMarkBatchItemDispatchStartedParams(
	params: MarkBatchItemDispatchStartedParams
): void {
	assertBatchWorkerIdentity(params);
	assertBatchItemId(params.itemId);
	if (
		!Number.isSafeInteger(params.itemOrdinal) ||
		params.itemOrdinal < 0 ||
		params.itemOrdinal >= MAX_BATCH_REQUEST_COUNT
	) {
		throw new RangeError("batch item ordinal is outside the supported range");
	}
	if (
		!Number.isSafeInteger(params.expectedItemRevision) ||
		params.expectedItemRevision < 0
	) {
		throw new RangeError(
			"batch expected item revision must be a non-negative integer"
		);
	}
	for (const [value, name] of [
		[params.generationId, "batch generation id"],
		[params.reservationId, "batch reservation id"],
	] as const) {
		assertBoundedText(value, name, 512);
		if (/[\u0000-\u001f\u007f]/u.test(value)) {
			throw new TypeError(`${name} must not contain control characters`);
		}
	}
}

export function assertReleaseBatchItemBeforeDispatchParams(
	params: ReleaseBatchItemBeforeDispatchParams
): void {
	assertBatchWorkerIdentity(params);
	assertBatchItemId(params.itemId);
	if (
		!Number.isSafeInteger(params.itemOrdinal) ||
		params.itemOrdinal < 0 ||
		params.itemOrdinal >= MAX_BATCH_REQUEST_COUNT
	) {
		throw new RangeError("batch item ordinal is outside the supported range");
	}
	if (
		!Number.isSafeInteger(params.expectedItemRevision) ||
		params.expectedItemRevision < 0
	) {
		throw new RangeError(
			"batch expected item revision must be a non-negative integer"
		);
	}
}

export function assertFailBatchExecutionPreflightParams(
	params: FailBatchExecutionPreflightParams
): void {
	assertBatchWorkerIdentity(params);
	if (
		!(BATCH_EXECUTION_PREFLIGHT_FAILURE_CODES as readonly string[]).includes(
			params.errorCode
		)
	) {
		throw new TypeError("batch execution preflight failure code is unsupported");
	}
}

export function assertAdvanceBatchValidationParams(
	params: AdvanceBatchValidationParams
): void {
	assertBatchWorkerIdentity(params);
	if (
		!Number.isSafeInteger(params.expectedNextOrdinal) ||
		params.expectedNextOrdinal < 0 ||
		params.expectedNextOrdinal >= MAX_BATCH_REQUEST_COUNT
	) {
		throw new RangeError("batch validation ordinal is outside the supported range");
	}
	if (
		!Number.isSafeInteger(params.expectedInputOffset) ||
		params.expectedInputOffset < 0 ||
		params.expectedInputOffset >= MAX_BATCH_INPUT_BYTES ||
		!Number.isSafeInteger(params.nextInputOffset) ||
		params.nextInputOffset <= params.expectedInputOffset ||
		params.nextInputOffset > MAX_BATCH_INPUT_BYTES
	) {
		throw new RangeError("batch validation byte checkpoint is invalid");
	}
	if (
		params.items.length < 1 ||
		params.items.length > MAX_BATCH_VALIDATION_CHUNK_ITEMS
	) {
		throw new RangeError(
			`batch validation chunks must contain 1-${MAX_BATCH_VALIDATION_CHUNK_ITEMS} items`
		);
	}
	const ids = new Set<string>();
	const customIds = new Set<string>();
	let expectedStartOffset = params.expectedInputOffset;
	for (const [index, item] of params.items.entries()) {
		if (!BATCH_ITEM_ID.test(item.id)) {
			throw new TypeError("batch item id must use the batch_req_ prefix and safe characters");
		}
		if (item.ordinal !== params.expectedNextOrdinal + index) {
			throw new RangeError("batch validation item ordinals must be contiguous");
		}
		assertBoundedText(item.customId, "batch custom id", 256);
		if (/[\u0000-\u001f\u007f]/u.test(item.customId)) {
			throw new TypeError("batch custom id must not contain control characters");
		}
		if (
			!Number.isSafeInteger(item.requestStartOffset) ||
			!Number.isSafeInteger(item.requestEndOffset) ||
			item.requestStartOffset !== expectedStartOffset ||
			item.requestEndOffset <= item.requestStartOffset ||
			item.requestEndOffset > params.nextInputOffset ||
			item.requestEndOffset - item.requestStartOffset > MAX_BATCH_ITEM_RANGE_BYTES
		) {
			throw new RangeError(
				"batch validation item byte ranges must be contiguous and bounded"
			);
		}
		expectedStartOffset = item.requestEndOffset;
		if (!HEX_SHA256.test(item.requestSha256)) {
			throw new TypeError("batch item request hash must be lowercase SHA-256");
		}
		if (ids.has(item.id) || customIds.has(item.customId)) {
			throw new TypeError("batch validation chunk contains a duplicate item identity");
		}
		ids.add(item.id);
		customIds.add(item.customId);
	}
	if (expectedStartOffset !== params.nextInputOffset) {
		throw new RangeError(
			"batch validation item byte ranges must end at the checkpoint"
		);
	}
}

export function assertCompleteBatchValidationParams(
	params: CompleteBatchValidationParams
): void {
	assertBatchWorkerIdentity(params);
}

export function assertFailBatchValidationParams(
	params: FailBatchValidationParams
): void {
	assertBatchWorkerIdentity(params);
	if (!(BATCH_VALIDATION_FAILURE_CODES as readonly string[]).includes(params.errorCode)) {
		throw new TypeError("batch validation failure code is unsupported");
	}
}

export function isExactBatchCreateReplay(
	row: BatchRow,
	params: CreateBatchParams
): boolean {
	return (
		row.account_id === params.accountId &&
		row.workspace_id === params.workspaceId &&
		row.user_id === params.userId &&
		row.api_key_hash === params.apiKeyHash &&
		row.endpoint === params.endpoint &&
		row.model_id === params.modelId &&
		row.route_group === params.routeGroup &&
		row.idempotency_key_hash === params.idempotencyKeyHash &&
		row.input_object_key === params.inputObjectKey &&
		row.input_sha256 === params.inputSha256 &&
		Number(row.input_bytes) === params.inputBytes &&
		Number(row.request_count) === params.requestCount
	);
}

export function batchPage(rows: BatchRow[], limit: number): BatchPage {
	const hasMore = rows.length > limit;
	const batches = hasMore ? rows.slice(0, limit) : rows;
	const last = batches.at(-1);
	return {
		batches,
		hasMore,
		nextCursor: last ? { id: last.id, createdAt: last.created_at } : null,
	};
}
