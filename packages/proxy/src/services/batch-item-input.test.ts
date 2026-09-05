import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	BatchItemInputError,
	loadVerifiedBatchItemInput,
	type BatchItemInputObjectStore,
} from "./batch-item-input";

const encoder = new TextEncoder();

function fixture() {
	const first = `${JSON.stringify({
		custom_id: "request-1",
		body: { input: "hello" },
	})}\r\n`;
	const second = JSON.stringify({
		custom_id: "request-2",
		body: { input: "world" },
	});
	const bytes = encoder.encode(first + second);
	const firstBytes = encoder.encode(first);
	const normalizedFirst = encoder.encode(first.slice(0, -2));
	return {
		bytes,
		batch: {
			id: "batch_12345678",
			workspace_id: "workspace-1",
			model_id: "deepseek-chat",
			input_sha256: createHash("sha256").update(bytes).digest("hex"),
			input_bytes: bytes.byteLength,
			request_count: 2,
		},
		item: {
			batch_id: "batch_12345678",
			ordinal: 0,
			custom_id: "request-1",
			request_start_offset: 0,
			request_end_offset: firstBytes.byteLength,
			request_sha256: createHash("sha256").update(normalizedFirst).digest("hex"),
		},
	};
}

function rangeStore(bytes: Uint8Array): BatchItemInputObjectStore {
	return {
		async getVerifiedExactRange(
			_workspaceId,
			_batchId,
			_kind,
			_expectedSha256,
			_expectedSize,
			offset,
			length
		) {
			return {
				body: new Blob([bytes.slice(offset, offset + length)]).stream(),
			};
		},
	};
}

test("Batch item input reloads exactly one CRLF-delimited R2 range", async () => {
	const { bytes, batch, item } = fixture();
	const parsed = await loadVerifiedBatchItemInput({
		batch,
		item,
		objectStore: rangeStore(bytes),
	});
	assert.deepEqual(parsed, {
		custom_id: "request-1",
		body: { input: "hello" },
	});
});

test("Batch item input fails closed on ledger hash and range drift", async () => {
	const { bytes, batch, item } = fixture();
	await assert.rejects(
		loadVerifiedBatchItemInput({
			batch,
			item: { ...item, request_sha256: "f".repeat(64) },
			objectStore: rangeStore(bytes),
		}),
		(error: unknown) =>
			error instanceof BatchItemInputError &&
			error.code === "batch_item_integrity"
	);
	await assert.rejects(
		loadVerifiedBatchItemInput({
			batch,
			item: { ...item, request_end_offset: bytes.byteLength },
			objectStore: rangeStore(bytes),
		}),
		(error: unknown) =>
			error instanceof BatchItemInputError &&
			error.code === "batch_item_integrity"
	);
});

test("Batch item input distinguishes a missing object from corrupt metadata", async () => {
	const { batch, item } = fixture();
	await assert.rejects(
		loadVerifiedBatchItemInput({
			batch,
			item,
			objectStore: {
				async getVerifiedExactRange() {
					return null;
				},
			},
		}),
		(error: unknown) =>
			error instanceof BatchItemInputError &&
			error.code === "batch_input_missing"
	);
});
