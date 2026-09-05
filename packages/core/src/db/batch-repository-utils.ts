import type {
	AdvanceBatchValidationParams,
	BatchItemRow,
	BatchRow,
	CompleteBatchValidationParams,
	CreateBatchParams,
} from "./batch-types";
import { isExactBatchCreateReplay } from "./batch-types";

const SAFE_INTEGER_COLUMNS = [
	"request_count",
	"input_bytes",
	"validation_next_ordinal",
	"validation_input_offset",
	"completed_count",
	"failed_count",
	"cancelled_count",
	"prompt_tokens",
	"completion_tokens",
	"total_tokens",
	"charged_cost_micros",
	"byok_request_count",
	"unknown_cost_count",
	"attempt_count",
	"revision",
] as const;

const TIMESTAMP_COLUMNS = [
	"created_at",
	"in_progress_at",
	"finalizing_at",
	"finalized_at",
	"expires_at",
	"retention_expires_at",
	"lease_expires_at",
	"updated_at",
] as const;

export type BatchDatabaseRow = Omit<
	BatchRow,
	(typeof SAFE_INTEGER_COLUMNS)[number] | (typeof TIMESTAMP_COLUMNS)[number]
> &
	Record<(typeof SAFE_INTEGER_COLUMNS)[number], number | string> &
	Record<(typeof TIMESTAMP_COLUMNS)[number], string | Date | null>;

const ITEM_SAFE_INTEGER_COLUMNS = [
	"ordinal",
	"attempt_count",
	"request_start_offset",
	"request_end_offset",
	"revision",
] as const;

const ITEM_TIMESTAMP_COLUMNS = [
	"started_at",
	"dispatch_started_at",
	"completed_at",
	"lease_expires_at",
	"created_at",
	"updated_at",
] as const;

export type BatchItemDatabaseRow = Omit<
	BatchItemRow,
	| (typeof ITEM_SAFE_INTEGER_COLUMNS)[number]
	| (typeof ITEM_TIMESTAMP_COLUMNS)[number]
> &
	Record<(typeof ITEM_SAFE_INTEGER_COLUMNS)[number], number | string> &
	Record<(typeof ITEM_TIMESTAMP_COLUMNS)[number], string | Date | null>;

function safeInteger(value: number | string, column: string): number {
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number < 0) {
		throw new Error(`invalid batch integer column: ${column}`);
	}
	return number;
}

function isoTimestamp(
	value: string | Date | null,
	column: string
): string | null {
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	const milliseconds = Date.parse(value);
	if (!Number.isFinite(milliseconds)) {
		throw new Error(`invalid batch timestamp column: ${column}`);
	}
	return new Date(milliseconds).toISOString();
}

function requiredIsoTimestamp(
	value: string | Date | null,
	column: string
): string {
	const normalized = isoTimestamp(value, column);
	if (normalized === null) {
		throw new Error(`invalid null batch timestamp column: ${column}`);
	}
	return normalized;
}

export function normalizeBatchRow(row: BatchDatabaseRow): BatchRow {
	return {
		...row,
		request_count: safeInteger(row.request_count, "request_count"),
		input_bytes: safeInteger(row.input_bytes, "input_bytes"),
		validation_next_ordinal: safeInteger(
			row.validation_next_ordinal,
			"validation_next_ordinal"
		),
		validation_input_offset: safeInteger(
			row.validation_input_offset,
			"validation_input_offset"
		),
		completed_count: safeInteger(row.completed_count, "completed_count"),
		failed_count: safeInteger(row.failed_count, "failed_count"),
		cancelled_count: safeInteger(row.cancelled_count, "cancelled_count"),
		prompt_tokens: safeInteger(row.prompt_tokens, "prompt_tokens"),
		completion_tokens: safeInteger(row.completion_tokens, "completion_tokens"),
		total_tokens: safeInteger(row.total_tokens, "total_tokens"),
		charged_cost_micros: safeInteger(
			row.charged_cost_micros,
			"charged_cost_micros"
		),
		byok_request_count: safeInteger(
			row.byok_request_count,
			"byok_request_count"
		),
		unknown_cost_count: safeInteger(
			row.unknown_cost_count,
			"unknown_cost_count"
		),
		attempt_count: safeInteger(row.attempt_count, "attempt_count"),
		revision: safeInteger(row.revision, "revision"),
		created_at: requiredIsoTimestamp(row.created_at, "created_at"),
		in_progress_at: isoTimestamp(row.in_progress_at, "in_progress_at"),
		finalizing_at: isoTimestamp(row.finalizing_at, "finalizing_at"),
		finalized_at: isoTimestamp(row.finalized_at, "finalized_at"),
		expires_at: requiredIsoTimestamp(row.expires_at, "expires_at"),
		retention_expires_at: requiredIsoTimestamp(
			row.retention_expires_at,
			"retention_expires_at"
		),
		lease_expires_at: isoTimestamp(row.lease_expires_at, "lease_expires_at"),
		updated_at: requiredIsoTimestamp(row.updated_at, "updated_at"),
	};
}

export function normalizeBatchItemRow(
	row: BatchItemDatabaseRow
): BatchItemRow {
	return {
		...row,
		ordinal: safeInteger(row.ordinal, "ordinal"),
		attempt_count: safeInteger(row.attempt_count, "attempt_count"),
		request_start_offset: safeInteger(
			row.request_start_offset,
			"request_start_offset"
		),
		request_end_offset: safeInteger(
			row.request_end_offset,
			"request_end_offset"
		),
		revision: safeInteger(row.revision, "revision"),
		started_at: isoTimestamp(row.started_at, "started_at"),
		dispatch_started_at: isoTimestamp(
			row.dispatch_started_at,
			"dispatch_started_at"
		),
		completed_at: isoTimestamp(row.completed_at, "completed_at"),
		lease_expires_at: isoTimestamp(
			row.lease_expires_at,
			"lease_expires_at"
		),
		created_at: requiredIsoTimestamp(row.created_at, "created_at"),
		updated_at: requiredIsoTimestamp(row.updated_at, "updated_at"),
	};
}

export function classifyBatchCreateReplay(
	row: BatchDatabaseRow | null,
	params: CreateBatchParams
): { status: "idempotent"; batch: BatchRow } | { status: "conflict" } {
	if (!row) return { status: "conflict" };
	const batch = normalizeBatchRow(row);
	return isExactBatchCreateReplay(batch, params)
		? { status: "idempotent", batch }
		: { status: "conflict" };
}

export function normalizeBatchInternalLimit(
	limit: number | undefined,
	defaultLimit = 100
): number {
	const value = limit ?? defaultLimit;
	if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
		throw new RangeError("batch internal list limit must be between 1 and 1000");
	}
	return value;
}

export function assertBatchInstant(value: string, name: string): void {
	if (!Number.isFinite(Date.parse(value))) {
		throw new TypeError(`${name} must be an ISO-8601 instant`);
	}
}

export function ownsLiveBatchValidationLease(
	row: BatchRow,
	params: CompleteBatchValidationParams
): boolean {
	return (
		row.id === params.id &&
		row.account_id === params.accountId &&
		row.workspace_id === params.workspaceId &&
		row.status === "validating" &&
		row.revision === params.expectedRevision &&
		row.lease_owner === params.owner &&
		row.lease_expires_at !== null &&
		Date.parse(row.lease_expires_at) > Date.parse(params.nowIso)
	);
}

export function ownsLiveBatchExecutionLease(
	row: BatchRow,
	params: {
		id: string;
		accountId: string;
		workspaceId: string;
		owner: string;
		expectedRevision: number;
		nowIso: string;
	}
): boolean {
	return (
		row.id === params.id &&
		row.account_id === params.accountId &&
		row.workspace_id === params.workspaceId &&
		row.status === "in_progress" &&
		row.revision === params.expectedRevision &&
		row.lease_owner === params.owner &&
		row.lease_expires_at !== null &&
		Date.parse(row.lease_expires_at) > Date.parse(params.nowIso)
	);
}

export function canAdvanceBatchValidation(
	row: BatchRow,
	params: AdvanceBatchValidationParams
): boolean {
	return (
		ownsLiveBatchValidationLease(row, params) &&
		row.validation_next_ordinal === params.expectedNextOrdinal &&
		row.validation_input_offset === params.expectedInputOffset &&
		params.expectedNextOrdinal + params.items.length <= row.request_count &&
		params.nextInputOffset <= row.input_bytes
	);
}

export function canCompleteBatchValidation(
	row: BatchRow,
	params: CompleteBatchValidationParams
): boolean {
	return (
		ownsLiveBatchValidationLease(row, params) &&
		row.validation_next_ordinal === row.request_count &&
		row.validation_input_offset === row.input_bytes
	);
}
