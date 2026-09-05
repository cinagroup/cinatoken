import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	BatchObjectConflictError,
	BatchObjectIntegrityError,
	CloudflareBatchObjectStore,
	batchObjectKey,
	type BatchR2Binding,
} from "./batch-object-storage";

function checksum(value: string): ArrayBuffer {
	const bytes = createHash("sha256").update(value).digest();
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function checksums(value: string): R2Checksums {
	const sha256 = checksum(value);
	return {
		sha256,
		toJSON: () => ({ sha256: createHash("sha256").update(value).digest("base64") }),
	};
}

function memoryBucket(): BatchR2Binding & { objects: Map<string, StoredFixture> } {
	type PutOptions = Parameters<BatchR2Binding["put"]>[2];
	const objects = new Map<string, StoredFixture>();
	return {
		objects,
		async put(key, value, options: PutOptions) {
			if (objects.has(key)) return null;
			if (typeof value !== "string") throw new Error("fixture accepts strings only");
			assert.equal(
				Buffer.from(options.sha256).toString("hex"),
				createHash("sha256").update(value).digest("hex")
			);
			assert.equal(options.httpMetadata.contentType, "application/x-ndjson");
			assert.equal(options.onlyIf.get("If-None-Match"), "*");
			const object: StoredFixture = {
				key,
				size: Buffer.byteLength(value),
				value,
				body: new Blob([value]).stream(),
				checksums: checksums(value),
				customMetadata: options.customMetadata,
			};
			objects.set(key, object);
			return object;
		},
		async get(key, options) {
			const object = objects.get(key);
			if (!object) return null;
			const offset = options?.range.offset ?? 0;
			const length = options?.range.length ?? object.size - offset;
			return {
				...object,
				body: new Blob([
					new TextEncoder().encode(object.value).slice(offset, offset + length),
				]).stream(),
				range: options ? { offset, length } : undefined,
			};
		},
		async delete(key) {
			objects.delete(key);
		},
	};
}

interface StoredFixture {
	key: string;
	size: number;
	value: string;
	body: ReadableStream;
	range?: R2Range;
	checksums: R2Checksums;
	customMetadata?: Record<string, string>;
}

test("private Batch object keys hash the workspace and never expose its id", async () => {
	const key = await batchObjectKey("workspace-sensitive", "batch_12345678", "input");
	assert.match(
		key,
		/^v1\/workspaces\/[0-9a-f]{64}\/batches\/batch_12345678\/input\.jsonl$/u
	);
	assert.equal(key.includes("workspace-sensitive"), false);
});

test("R2 Batch writes are create-only and exact replays are idempotent", async () => {
	const bucket = memoryBucket();
	const store = new CloudflareBatchObjectStore(bucket);
	const value = '{"custom_id":"a","body":{}}\n';
	const sha256 = createHash("sha256").update(value).digest("hex");
	assert.equal(
		(await store.put("workspace-1", "batch_12345678", "input", value, sha256, Buffer.byteLength(value))).status,
		"created"
	);
	assert.equal(
		(await store.put("workspace-1", "batch_12345678", "input", value, sha256, Buffer.byteLength(value))).status,
		"idempotent"
	);
	await assert.rejects(
		store.put(
			"workspace-1",
			"batch_12345678",
			"input",
			"different",
			createHash("sha256").update("different").digest("hex"),
			Buffer.byteLength("different")
		),
		BatchObjectConflictError
	);
});

test("R2 Batch reads fail closed when the platform checksum drifts", async () => {
	const bucket = memoryBucket();
	const store = new CloudflareBatchObjectStore(bucket);
	const value = '{"custom_id":"a","body":{}}\n';
	const sha256 = createHash("sha256").update(value).digest("hex");
	const { key } = await store.put(
		"workspace-1",
		"batch_12345678",
		"input",
		value,
		sha256,
		Buffer.byteLength(value)
	);
	assert.ok(await store.getVerified("workspace-1", "batch_12345678", "input", sha256));
	const object = bucket.objects.get(key);
	assert.ok(object);
	object.checksums = checksums("tampered");
	await assert.rejects(
		store.getVerified("workspace-1", "batch_12345678", "input", sha256),
		BatchObjectIntegrityError
	);
});

test("R2 Batch ranged reads verify the full object identity and exact offset", async () => {
	const bucket = memoryBucket();
	const store = new CloudflareBatchObjectStore(bucket);
	const value = '{"custom_id":"a","body":{}}\n{"custom_id":"b","body":{}}';
	const sha256 = createHash("sha256").update(value).digest("hex");
	await store.put(
		"workspace-1",
		"batch_12345678",
		"input",
		value,
		sha256,
		Buffer.byteLength(value)
	);
	const offset = value.indexOf("\n") + 1;
	const object = await store.getVerifiedRange(
		"workspace-1",
		"batch_12345678",
		"input",
		sha256,
		Buffer.byteLength(value),
		offset
	);
	assert.ok(object);
	assert.equal(await new Response(object.body).text(), value.slice(offset));
	assert.deepEqual(object.range, { offset, length: Buffer.byteLength(value) - offset });
	await assert.rejects(
		store.getVerifiedRange(
			"workspace-1",
			"batch_12345678",
			"input",
			sha256,
			Buffer.byteLength(value) - 1,
			offset
		),
		BatchObjectIntegrityError
	);
});

test("R2 Batch exact ranged reads return only one persisted item range", async () => {
	const bucket = memoryBucket();
	const store = new CloudflareBatchObjectStore(bucket);
	const first = '{"custom_id":"a","body":{}}\r\n';
	const second = '{"custom_id":"b","body":{}}';
	const value = first + second;
	const sha256 = createHash("sha256").update(value).digest("hex");
	await store.put(
		"workspace-1",
		"batch_12345678",
		"input",
		value,
		sha256,
		Buffer.byteLength(value)
	);
	const object = await store.getVerifiedExactRange(
		"workspace-1",
		"batch_12345678",
		"input",
		sha256,
		Buffer.byteLength(value),
		0,
		Buffer.byteLength(first)
	);
	assert.ok(object);
	assert.equal(await new Response(object.body).text(), first);
	assert.deepEqual(object.range, { offset: 0, length: Buffer.byteLength(first) });
	await assert.rejects(
		store.getVerifiedExactRange(
			"workspace-1",
			"batch_12345678",
			"input",
			sha256,
			Buffer.byteLength(value),
			Buffer.byteLength(value) - 1,
			2
		),
		RangeError
	);
});
