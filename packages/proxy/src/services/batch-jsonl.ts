import { createHash } from "node:crypto";
import {
	MAX_BATCH_REQUEST_COUNT,
	MAX_BATCH_VALIDATION_CHUNK_ITEMS,
} from "@octafuse/core";

export const DEFAULT_BATCH_INPUT_MAX_BYTES = 50 * 1024 * 1024;
export const DEFAULT_BATCH_LINE_MAX_BYTES = 1024 * 1024;
export const DEFAULT_BATCH_CUSTOM_ID_MAX_LENGTH = 256;
export const DEFAULT_BATCH_JSON_MAX_DEPTH = 32;
export const DEFAULT_BATCH_JSON_MAX_NODES = 20_000;

export type BatchJsonlErrorCode =
	| "empty_input"
	| "input_too_large"
	| "input_truncated"
	| "line_too_large"
	| "invalid_utf8"
	| "invalid_json"
	| "invalid_envelope"
	| "invalid_custom_id"
	| "invalid_body"
	| "model_mismatch"
	| "unsupported_media"
	| "json_too_complex"
	| "too_many_requests";

export class BatchJsonlError extends Error {
	readonly code: BatchJsonlErrorCode;
	readonly line: number | null;

	constructor(code: BatchJsonlErrorCode, message: string, line: number | null) {
		super(message);
		this.name = "BatchJsonlError";
		this.code = code;
		this.line = line;
	}
}

export interface BatchJsonlItem {
	custom_id: string;
	body: Record<string, unknown>;
}

export interface ConsumeBatchJsonlOptions {
	expectedModel: string;
	maxBytes?: number;
	maxLineBytes?: number;
	maxRequests?: number;
	maxCustomIdLength?: number;
	maxJsonDepth?: number;
	maxJsonNodes?: number;
	onItem: (item: BatchJsonlItem, ordinal: number) => void | Promise<void>;
}

export interface BatchJsonlSummary {
	requestCount: number;
	totalBytes: number;
	sha256: string;
}

export interface BatchJsonlItemCursor {
	ordinal: number;
	startOffset: number;
	nextOffset: number;
	requestSha256: string;
}

export interface ConsumeBatchJsonlChunkOptions {
	expectedModel: string;
	totalInputBytes: number;
	initialOrdinal: number;
	initialOffset: number;
	maxItems?: number;
	maxLineBytes?: number;
	maxRequests?: number;
	maxCustomIdLength?: number;
	maxJsonDepth?: number;
	maxJsonNodes?: number;
	onItem: (
		item: BatchJsonlItem,
		cursor: BatchJsonlItemCursor
	) => void | Promise<void>;
}

export interface BatchJsonlChunkSummary {
	itemsProcessed: number;
	nextOrdinal: number;
	nextOffset: number;
	reachedEnd: boolean;
}

const MEDIA_KEYS = new Set([
	"audio",
	"audio_url",
	"file",
	"file_id",
	"image",
	"image_url",
	"input_audio",
	"input_file",
	"input_image",
	"input_video",
	"video",
	"video_url",
]);

const MEDIA_TYPES = new Set([
	"audio",
	"audio_url",
	"file",
	"image",
	"image_url",
	"input_audio",
	"input_file",
	"input_image",
	"input_video",
	"video",
	"video_url",
]);

function positiveLimit(value: number | undefined, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new RangeError(`${label} must be a positive safe integer`);
	}
	return resolved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function inspectBody(
	body: Record<string, unknown>,
	line: number,
	maxDepth: number,
	maxNodes: number
): void {
	const stack: Array<{ value: unknown; depth: number; key: string | null }> = [
		{ value: body, depth: 1, key: null },
	];
	let nodes = 0;
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) break;
		nodes += 1;
		if (nodes > maxNodes || current.depth > maxDepth) {
			throw new BatchJsonlError(
				"json_too_complex",
				"batch item JSON exceeds the configured complexity limit",
				line
			);
		}
		if (current.key && MEDIA_KEYS.has(current.key.toLowerCase())) {
			throw new BatchJsonlError(
				"unsupported_media",
				"batch item contains an unsupported media or file field",
				line
			);
		}
		if (Array.isArray(current.value)) {
			for (const value of current.value) {
				stack.push({ value, depth: current.depth + 1, key: null });
			}
			continue;
		}
		if (!isRecord(current.value)) continue;
		const mediaType = current.value.type;
		if (typeof mediaType === "string" && MEDIA_TYPES.has(mediaType.toLowerCase())) {
			throw new BatchJsonlError(
				"unsupported_media",
				"batch item contains an unsupported media or file content part",
				line
			);
		}
		for (const [key, value] of Object.entries(current.value)) {
			stack.push({ value, depth: current.depth + 1, key });
		}
	}
}

function parseItem(
	rawLine: string,
	line: number,
	expectedModel: string,
	maxCustomIdLength: number,
	maxDepth: number,
	maxNodes: number
): BatchJsonlItem {
	if (!rawLine.trim()) {
		throw new BatchJsonlError("invalid_json", "batch JSONL contains a blank line", line);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawLine);
	} catch {
		throw new BatchJsonlError("invalid_json", "batch JSONL line is not valid JSON", line);
	}
	if (!isRecord(parsed)) {
		throw new BatchJsonlError("invalid_envelope", "batch item must be a JSON object", line);
	}
	const keys = Object.keys(parsed);
	if (
		keys.length !== 2 ||
		!keys.includes("custom_id") ||
		!keys.includes("body")
	) {
		throw new BatchJsonlError(
			"invalid_envelope",
			"batch item must contain only custom_id and body",
			line
		);
	}
	if (
		typeof parsed.custom_id !== "string" ||
		parsed.custom_id.length < 1 ||
		parsed.custom_id.length > maxCustomIdLength ||
		/[\u0000-\u001f\u007f]/u.test(parsed.custom_id)
	) {
		throw new BatchJsonlError(
			"invalid_custom_id",
			"batch custom_id is empty, too long, or contains control characters",
			line
		);
	}
	if (!isRecord(parsed.body)) {
		throw new BatchJsonlError("invalid_body", "batch item body must be a JSON object", line);
	}
	if (
		Object.prototype.hasOwnProperty.call(parsed.body, "model") &&
		parsed.body.model !== expectedModel
	) {
		throw new BatchJsonlError(
			"model_mismatch",
			"batch item model does not match the batch model",
			line
		);
	}
	inspectBody(parsed.body, line, maxDepth, maxNodes);
	return { custom_id: parsed.custom_id, body: parsed.body };
}

/**
 * Consume normalized internal JSONL without materializing the full Batch in
 * memory. Uniqueness and endpoint-specific schema checks belong in the
 * transactional item-ledger callback used by the later consumer phase.
 */
export async function consumeBatchJsonl(
	stream: ReadableStream<Uint8Array>,
	options: ConsumeBatchJsonlOptions
): Promise<BatchJsonlSummary> {
	if (!options.expectedModel || options.expectedModel.length > 512) {
		throw new TypeError("expectedModel must contain 1-512 characters");
	}
	const maxBytes = positiveLimit(
		options.maxBytes,
		DEFAULT_BATCH_INPUT_MAX_BYTES,
		"maxBytes"
	);
	const maxLineBytes = positiveLimit(
		options.maxLineBytes,
		DEFAULT_BATCH_LINE_MAX_BYTES,
		"maxLineBytes"
	);
	const maxRequests = positiveLimit(
		options.maxRequests,
		MAX_BATCH_REQUEST_COUNT,
		"maxRequests"
	);
	if (maxRequests > MAX_BATCH_REQUEST_COUNT) {
		throw new RangeError(`maxRequests cannot exceed ${MAX_BATCH_REQUEST_COUNT}`);
	}
	const maxCustomIdLength = positiveLimit(
		options.maxCustomIdLength,
		DEFAULT_BATCH_CUSTOM_ID_MAX_LENGTH,
		"maxCustomIdLength"
	);
	const maxDepth = positiveLimit(
		options.maxJsonDepth,
		DEFAULT_BATCH_JSON_MAX_DEPTH,
		"maxJsonDepth"
	);
	const maxNodes = positiveLimit(
		options.maxJsonNodes,
		DEFAULT_BATCH_JSON_MAX_NODES,
		"maxJsonNodes"
	);

	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	const encoder = new TextEncoder();
	const digest = createHash("sha256");
	let pending = "";
	let totalBytes = 0;
	let requestCount = 0;
	let lineNumber = 0;

	const consumeLine = async (line: string): Promise<void> => {
		lineNumber += 1;
		const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (encoder.encode(normalized).byteLength > maxLineBytes) {
			throw new BatchJsonlError(
				"line_too_large",
				"batch JSONL line exceeds the configured byte limit",
				lineNumber
			);
		}
		if (requestCount >= maxRequests) {
			throw new BatchJsonlError(
				"too_many_requests",
				"batch contains too many requests",
				lineNumber
			);
		}
		const item = parseItem(
			normalized,
			lineNumber,
			options.expectedModel,
			maxCustomIdLength,
			maxDepth,
			maxNodes
		);
		await options.onItem(item, requestCount);
		requestCount += 1;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			totalBytes += value.byteLength;
			if (totalBytes > maxBytes) {
				throw new BatchJsonlError(
					"input_too_large",
					"batch JSONL exceeds the configured byte limit",
					null
				);
			}
			digest.update(value);
			try {
				pending += decoder.decode(value, { stream: true });
			} catch {
				throw new BatchJsonlError("invalid_utf8", "batch JSONL is not valid UTF-8", null);
			}
			let newlineIndex = pending.indexOf("\n");
			while (newlineIndex >= 0) {
				await consumeLine(pending.slice(0, newlineIndex));
				pending = pending.slice(newlineIndex + 1);
				newlineIndex = pending.indexOf("\n");
			}
			if (encoder.encode(pending).byteLength > maxLineBytes) {
				throw new BatchJsonlError(
					"line_too_large",
					"batch JSONL line exceeds the configured byte limit",
					lineNumber + 1
				);
			}
		}
		try {
			pending += decoder.decode();
		} catch {
			throw new BatchJsonlError("invalid_utf8", "batch JSONL is not valid UTF-8", null);
		}
		if (pending.length > 0) await consumeLine(pending);
		if (requestCount === 0) {
			throw new BatchJsonlError("empty_input", "batch JSONL contains no requests", null);
		}
		return {
			requestCount,
			totalBytes,
			sha256: digest.digest("hex"),
		};
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}

function concatenateBytes(
	parts: readonly Uint8Array[],
	totalBytes: number
): Uint8Array {
	if (parts.length === 1) return parts[0]!;
	const combined = new Uint8Array(totalBytes);
	let offset = 0;
	for (const part of parts) {
		combined.set(part, offset);
		offset += part.byteLength;
	}
	return combined;
}

/**
 * Consume one bounded validation chunk from an R2 Range stream. Checkpoints are
 * raw byte offsets immediately after a JSONL line delimiter (or exact EOF), so
 * a committed cursor can be used directly as the next R2 range offset.
 */
export async function consumeBatchJsonlChunk(
	stream: ReadableStream<Uint8Array>,
	options: ConsumeBatchJsonlChunkOptions
): Promise<BatchJsonlChunkSummary> {
	if (!options.expectedModel || options.expectedModel.length > 512) {
		throw new TypeError("expectedModel must contain 1-512 characters");
	}
	if (
		!Number.isSafeInteger(options.totalInputBytes) ||
		options.totalInputBytes < 1 ||
		options.totalInputBytes > DEFAULT_BATCH_INPUT_MAX_BYTES ||
		!Number.isSafeInteger(options.initialOffset) ||
		options.initialOffset < 0 ||
		options.initialOffset >= options.totalInputBytes
	) {
		throw new RangeError("batch JSONL range boundaries are invalid");
	}
	if (
		!Number.isSafeInteger(options.initialOrdinal) ||
		options.initialOrdinal < 0 ||
		options.initialOrdinal >= MAX_BATCH_REQUEST_COUNT
	) {
		throw new RangeError("batch JSONL initial ordinal is invalid");
	}
	const maxItems = positiveLimit(
		options.maxItems,
		MAX_BATCH_VALIDATION_CHUNK_ITEMS,
		"maxItems"
	);
	if (maxItems > MAX_BATCH_VALIDATION_CHUNK_ITEMS) {
		throw new RangeError(
			`maxItems cannot exceed ${MAX_BATCH_VALIDATION_CHUNK_ITEMS}`
		);
	}
	const maxLineBytes = positiveLimit(
		options.maxLineBytes,
		DEFAULT_BATCH_LINE_MAX_BYTES,
		"maxLineBytes"
	);
	const maxRequests = positiveLimit(
		options.maxRequests,
		MAX_BATCH_REQUEST_COUNT,
		"maxRequests"
	);
	if (maxRequests > MAX_BATCH_REQUEST_COUNT) {
		throw new RangeError(`maxRequests cannot exceed ${MAX_BATCH_REQUEST_COUNT}`);
	}
	const maxCustomIdLength = positiveLimit(
		options.maxCustomIdLength,
		DEFAULT_BATCH_CUSTOM_ID_MAX_LENGTH,
		"maxCustomIdLength"
	);
	const maxDepth = positiveLimit(
		options.maxJsonDepth,
		DEFAULT_BATCH_JSON_MAX_DEPTH,
		"maxJsonDepth"
	);
	const maxNodes = positiveLimit(
		options.maxJsonNodes,
		DEFAULT_BATCH_JSON_MAX_NODES,
		"maxJsonNodes"
	);

	const reader = stream.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	let parts: Uint8Array[] = [];
	let pendingBytes = 0;
	let itemsProcessed = 0;
	let nextOrdinal = options.initialOrdinal;
	let nextOffset = options.initialOffset;

	const append = (part: Uint8Array): void => {
		if (part.byteLength === 0) return;
		parts.push(part);
		pendingBytes += part.byteLength;
		if (pendingBytes > maxLineBytes + 1) {
			throw new BatchJsonlError(
				"line_too_large",
				"batch JSONL line exceeds the configured byte limit",
				nextOrdinal + 1
			);
		}
	};

	const consumeLine = async (delimiterBytes: number): Promise<void> => {
		const rawBytes = concatenateBytes(parts, pendingBytes);
		const normalizedBytes =
			rawBytes.at(-1) === 0x0d ? rawBytes.slice(0, -1) : rawBytes;
		if (normalizedBytes.byteLength > maxLineBytes) {
			throw new BatchJsonlError(
				"line_too_large",
				"batch JSONL line exceeds the configured byte limit",
				nextOrdinal + 1
			);
		}
		if (nextOrdinal >= maxRequests) {
			throw new BatchJsonlError(
				"too_many_requests",
				"batch contains too many requests",
				nextOrdinal + 1
			);
		}
		let rawLine: string;
		try {
			rawLine = decoder.decode(normalizedBytes);
		} catch {
			throw new BatchJsonlError(
				"invalid_utf8",
				"batch JSONL is not valid UTF-8",
				nextOrdinal + 1
			);
		}
		const item = parseItem(
			rawLine,
			nextOrdinal + 1,
			options.expectedModel,
			maxCustomIdLength,
			maxDepth,
			maxNodes
		);
		const startOffset = nextOffset;
		const lineEndOffset = startOffset + rawBytes.byteLength + delimiterBytes;
		if (lineEndOffset > options.totalInputBytes) {
			throw new BatchJsonlError(
				"input_truncated",
				"batch JSONL range exceeds the declared object size",
				nextOrdinal + 1
			);
		}
		await options.onItem(item, {
			ordinal: nextOrdinal,
			startOffset,
			nextOffset: lineEndOffset,
			requestSha256: createHash("sha256").update(normalizedBytes).digest("hex"),
		});
		itemsProcessed += 1;
		nextOrdinal += 1;
		nextOffset = lineEndOffset;
		parts = [];
		pendingBytes = 0;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			let segmentStart = 0;
			for (let index = 0; index < value.byteLength; index += 1) {
				if (value[index] !== 0x0a) continue;
				append(value.slice(segmentStart, index));
				await consumeLine(1);
				segmentStart = index + 1;
				if (itemsProcessed >= maxItems) {
					await reader.cancel();
					return {
						itemsProcessed,
						nextOrdinal,
						nextOffset,
						reachedEnd: nextOffset === options.totalInputBytes,
					};
				}
			}
			append(value.slice(segmentStart));
		}
		if (pendingBytes > 0) await consumeLine(0);
		if (nextOffset !== options.totalInputBytes) {
			throw new BatchJsonlError(
				"input_truncated",
				"batch JSONL range ended before the declared object size",
				null
			);
		}
		if (options.initialOrdinal === 0 && itemsProcessed === 0) {
			throw new BatchJsonlError(
				"empty_input",
				"batch JSONL contains no requests",
				null
			);
		}
		return { itemsProcessed, nextOrdinal, nextOffset, reachedEnd: true };
	} catch (error) {
		await reader.cancel(error).catch(() => undefined);
		throw error;
	} finally {
		reader.releaseLock();
	}
}
