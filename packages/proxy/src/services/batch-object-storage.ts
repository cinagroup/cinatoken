import type { R2Bucket, R2Object, R2ObjectBody } from "@cloudflare/workers-types";
import { assertBatchId } from "@octafuse/core";

export const MAX_BATCH_OBJECT_BYTES = 50 * 1024 * 1024;

export type BatchObjectKind = "input" | "result";
export type BatchObjectPutValue =
	| ReadableStream
	| ArrayBuffer
	| ArrayBufferView
	| string
	| Blob;

type StoredBatchObject = Pick<
	R2Object,
	"checksums" | "customMetadata" | "key" | "size"
>;
type StoredBatchObjectBody = Pick<
	R2ObjectBody,
	"body" | "checksums" | "customMetadata" | "key" | "range" | "size"
>;

export interface BatchR2Binding {
	put(
		key: string,
		value: BatchObjectPutValue,
		options: {
			onlyIf: Headers;
			httpMetadata: { contentType: string };
			customMetadata: Record<string, string>;
			sha256: ArrayBuffer;
		}
	): Promise<StoredBatchObject | null>;
	get(
		key: string,
		options?: { range: { offset: number; length?: number } }
	): Promise<StoredBatchObjectBody | null>;
	delete(key: string): Promise<void>;
}

export class BatchObjectConflictError extends Error {
	constructor() {
		super("batch object already exists with different metadata");
		this.name = "BatchObjectConflictError";
	}
}

export class BatchObjectIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BatchObjectIntegrityError";
	}
}

function assertSha256(value: string): void {
	if (!/^[0-9a-f]{64}$/u.test(value)) {
		throw new TypeError("batch object SHA-256 must be lowercase hexadecimal");
	}
}

function assertContentLength(value: number): void {
	if (
		!Number.isSafeInteger(value) ||
		value < 1 ||
		value > MAX_BATCH_OBJECT_BYTES
	) {
		throw new RangeError(
			`batch object content length must be between 1 and ${MAX_BATCH_OBJECT_BYTES}`
		);
	}
}

function arrayBufferHex(value: ArrayBuffer): string {
	return Array.from(new Uint8Array(value), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

function sha256ArrayBuffer(value: string): ArrayBuffer {
	const bytes = new Uint8Array(32);
	for (let index = 0; index < bytes.length; index += 1) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes.buffer;
}

export async function batchWorkspaceHash(workspaceId: string): Promise<string> {
	if (!workspaceId || workspaceId.length > 600 || /[\r\n]/u.test(workspaceId)) {
		throw new TypeError("batch workspace id must contain 1-600 safe characters");
	}
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(workspaceId)
	);
	return arrayBufferHex(digest);
}

export async function batchObjectKey(
	workspaceId: string,
	batchId: string,
	kind: BatchObjectKind
): Promise<string> {
	assertBatchId(batchId);
	const workspaceHash = await batchWorkspaceHash(workspaceId);
	return `v1/workspaces/${workspaceHash}/batches/${batchId}/${kind}.jsonl`;
}

function metadataMatches(
	object: StoredBatchObject,
	kind: BatchObjectKind,
	sha256: string,
	contentLength: number
): boolean {
	return (
		object.customMetadata?.schema === "v1" &&
		object.customMetadata?.kind === kind &&
		object.customMetadata?.sha256 === sha256 &&
		object.customMetadata?.bytes === String(contentLength) &&
		object.size === contentLength
	);
}

function checksumMatches(object: StoredBatchObject, sha256: string): boolean {
	const storedChecksum = object.checksums.sha256;
	return Boolean(storedChecksum && arrayBufferHex(storedChecksum) === sha256);
}

export class CloudflareBatchObjectStore {
	readonly #bucket: BatchR2Binding;

	constructor(bucket: R2Bucket | BatchR2Binding) {
		this.#bucket = bucket;
	}

	async put(
		workspaceId: string,
		batchId: string,
		kind: BatchObjectKind,
		value: BatchObjectPutValue,
		sha256: string,
		contentLength: number
	): Promise<{ key: string; status: "created" | "idempotent" }> {
		assertSha256(sha256);
		assertContentLength(contentLength);
		const key = await batchObjectKey(workspaceId, batchId, kind);
		const object = await this.#bucket.put(key, value, {
			onlyIf: new Headers({ "If-None-Match": "*" }),
			httpMetadata: { contentType: "application/x-ndjson" },
			customMetadata: {
				schema: "v1",
				kind,
				sha256,
				bytes: String(contentLength),
			},
			sha256: sha256ArrayBuffer(sha256),
		});
		if (object) {
			if (
				!metadataMatches(object, kind, sha256, contentLength) ||
				!checksumMatches(object, sha256)
			) {
				await this.#bucket.delete(key);
				throw new BatchObjectIntegrityError(
					"new Batch object failed post-write integrity verification"
				);
			}
			return { key, status: "created" };
		}

		const existing = await this.#bucket.get(key);
		if (
			existing &&
			metadataMatches(existing, kind, sha256, contentLength) &&
			checksumMatches(existing, sha256)
		) {
			return { key, status: "idempotent" };
		}
		throw new BatchObjectConflictError();
	}

	async getVerified(
		workspaceId: string,
		batchId: string,
		kind: BatchObjectKind,
		expectedSha256: string
	): Promise<StoredBatchObjectBody | null> {
		assertSha256(expectedSha256);
		const key = await batchObjectKey(workspaceId, batchId, kind);
		const object = await this.#bucket.get(key);
		if (!object) return null;
		if (
			object.size < 1 ||
			object.size > MAX_BATCH_OBJECT_BYTES ||
			!metadataMatches(object, kind, expectedSha256, object.size)
		) {
			throw new BatchObjectIntegrityError("batch object metadata or size mismatch");
		}
		if (!checksumMatches(object, expectedSha256)) {
			throw new BatchObjectIntegrityError("batch object checksum mismatch");
		}
		return object;
	}

	async getVerifiedRange(
		workspaceId: string,
		batchId: string,
		kind: BatchObjectKind,
		expectedSha256: string,
		expectedSize: number,
		offset: number
	): Promise<StoredBatchObjectBody | null> {
		assertSha256(expectedSha256);
		assertContentLength(expectedSize);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= expectedSize) {
			throw new RangeError("batch object range offset is invalid");
		}
		const key = await batchObjectKey(workspaceId, batchId, kind);
		const object = await this.#bucket.get(key, { range: { offset } });
		if (!object) return null;
		if (
			object.size !== expectedSize ||
			!metadataMatches(object, kind, expectedSha256, expectedSize) ||
			!checksumMatches(object, expectedSha256)
		) {
			throw new BatchObjectIntegrityError(
				"batch ranged object metadata, size, or checksum mismatch"
			);
		}
		if (
			offset > 0 &&
			(!object.range ||
				!("offset" in object.range) ||
				object.range.offset !== offset)
		) {
			throw new BatchObjectIntegrityError("batch object range offset mismatch");
		}
		return object;
	}

	async getVerifiedExactRange(
		workspaceId: string,
		batchId: string,
		kind: BatchObjectKind,
		expectedSha256: string,
		expectedSize: number,
		offset: number,
		length: number
	): Promise<StoredBatchObjectBody | null> {
		assertSha256(expectedSha256);
		assertContentLength(expectedSize);
		if (
			!Number.isSafeInteger(offset) ||
			offset < 0 ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			offset + length > expectedSize
		) {
			throw new RangeError("batch object exact range is invalid");
		}
		const key = await batchObjectKey(workspaceId, batchId, kind);
		const object = await this.#bucket.get(key, {
			range: { offset, length },
		});
		if (!object) return null;
		if (
			object.size !== expectedSize ||
			!metadataMatches(object, kind, expectedSha256, expectedSize) ||
			!checksumMatches(object, expectedSha256)
		) {
			throw new BatchObjectIntegrityError(
				"batch exact-range object metadata, size, or checksum mismatch"
			);
		}
		if (
			!object.range ||
			!("offset" in object.range) ||
			object.range.offset !== offset ||
			!("length" in object.range) ||
			object.range.length !== length
		) {
			throw new BatchObjectIntegrityError("batch object exact range mismatch");
		}
		return object;
	}

	async delete(
		workspaceId: string,
		batchId: string,
		kind: BatchObjectKind
	): Promise<void> {
		await this.#bucket.delete(await batchObjectKey(workspaceId, batchId, kind));
	}
}
