import type { BatchItemRow, BatchRow } from "@octafuse/core";
import {
	BatchJsonlError,
	consumeBatchJsonlChunk,
	type BatchJsonlItem,
} from "./batch-jsonl";
import { BatchObjectIntegrityError } from "./batch-object-storage";

export type BatchItemInputErrorCode =
	| "batch_input_missing"
	| "batch_input_integrity"
	| "batch_item_integrity";

export class BatchItemInputError extends Error {
	readonly code: BatchItemInputErrorCode;

	constructor(code: BatchItemInputErrorCode, message: string) {
		super(message);
		this.name = "BatchItemInputError";
		this.code = code;
	}
}

type BatchInputIdentity = Pick<
	BatchRow,
	"id" | "workspace_id" | "model_id" | "input_sha256" | "input_bytes" | "request_count"
>;

type BatchItemInputIdentity = Pick<
	BatchItemRow,
	| "batch_id"
	| "ordinal"
	| "custom_id"
	| "request_start_offset"
	| "request_end_offset"
	| "request_sha256"
>;

interface ExactRangeObject {
	body: ReadableStream<Uint8Array>;
}

export interface BatchItemInputObjectStore {
	getVerifiedExactRange(
		workspaceId: string,
		batchId: string,
		kind: "input",
		expectedSha256: string,
		expectedSize: number,
		offset: number,
		length: number
	): Promise<ExactRangeObject | null>;
}

/**
 * Reload one validated request directly from its private R2 byte range. The
 * database keeps only identity/range/hash evidence; request content never
 * crosses the repository or Queue boundary.
 */
export async function loadVerifiedBatchItemInput(options: {
	batch: BatchInputIdentity;
	item: BatchItemInputIdentity;
	objectStore: BatchItemInputObjectStore;
}): Promise<BatchJsonlItem> {
	const { batch, item, objectStore } = options;
	if (
		item.batch_id !== batch.id ||
		!Number.isSafeInteger(item.ordinal) ||
		item.ordinal < 0 ||
		item.ordinal >= batch.request_count ||
		!Number.isSafeInteger(item.request_start_offset) ||
		!Number.isSafeInteger(item.request_end_offset) ||
		item.request_start_offset < 0 ||
		item.request_end_offset <= item.request_start_offset ||
		item.request_end_offset > batch.input_bytes
	) {
		throw new BatchItemInputError(
			"batch_item_integrity",
			"batch item input identity is outside its batch"
		);
	}

	let object: ExactRangeObject | null;
	try {
		object = await objectStore.getVerifiedExactRange(
			batch.workspace_id,
			batch.id,
			"input",
			batch.input_sha256,
			batch.input_bytes,
			item.request_start_offset,
			item.request_end_offset - item.request_start_offset
		);
	} catch (error) {
		if (error instanceof BatchObjectIntegrityError) {
			throw new BatchItemInputError(
				"batch_input_integrity",
				"batch input object failed integrity verification"
			);
		}
		throw error;
	}
	if (!object) {
		throw new BatchItemInputError(
			"batch_input_missing",
			"batch input object is missing"
		);
	}

	let parsed: BatchJsonlItem | null = null;
	try {
		const summary = await consumeBatchJsonlChunk(object.body, {
			expectedModel: batch.model_id,
			totalInputBytes: batch.input_bytes,
			initialOrdinal: item.ordinal,
			initialOffset: item.request_start_offset,
			maxItems: 1,
			maxRequests: batch.request_count,
			onItem(value, cursor) {
				if (
					cursor.ordinal !== item.ordinal ||
					cursor.startOffset !== item.request_start_offset ||
					cursor.nextOffset !== item.request_end_offset ||
					cursor.requestSha256 !== item.request_sha256 ||
					value.custom_id !== item.custom_id
				) {
					throw new BatchItemInputError(
						"batch_item_integrity",
						"batch item input does not match its ledger identity"
					);
				}
				parsed = value;
			},
		});
		if (
			summary.itemsProcessed !== 1 ||
			summary.nextOrdinal !== item.ordinal + 1 ||
			summary.nextOffset !== item.request_end_offset ||
			parsed === null
		) {
			throw new BatchItemInputError(
				"batch_item_integrity",
				"batch item range does not contain exactly one ledger request"
			);
		}
	} catch (error) {
		if (error instanceof BatchItemInputError) throw error;
		if (error instanceof BatchJsonlError) {
			throw new BatchItemInputError(
				"batch_item_integrity",
				"batch item input is no longer valid JSONL"
			);
		}
		throw error;
	}
	return parsed;
}
