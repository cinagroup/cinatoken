import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
	BatchJsonlError,
	consumeBatchJsonl,
	consumeBatchJsonlChunk,
} from "./batch-jsonl";

function chunkedStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

function textChunks(value: string, splitAt: number[] = []): Uint8Array[] {
	const bytes = new TextEncoder().encode(value);
	const chunks: Uint8Array[] = [];
	let start = 0;
	for (const end of [...splitAt, bytes.byteLength]) {
		chunks.push(bytes.slice(start, end));
		start = end;
	}
	return chunks.filter((chunk) => chunk.byteLength > 0);
}

test("streaming Batch JSONL validates split UTF-8 and returns a raw-byte digest", async () => {
	const source = [
		JSON.stringify({ custom_id: "请求-1", body: { messages: [{ role: "user", content: "你好" }] } }),
		JSON.stringify({ custom_id: "request-2", body: { model: "deepseek-chat", input: "hello" } }),
	].join("\n");
	const seen: string[] = [];
	const summary = await consumeBatchJsonl(chunkedStream(textChunks(source, [5, 17, 31])), {
		expectedModel: "deepseek-chat",
		onItem(item, ordinal) {
			seen.push(`${ordinal}:${item.custom_id}`);
		},
	});
	assert.deepEqual(seen, ["0:请求-1", "1:request-2"]);
	assert.deepEqual(summary, {
		requestCount: 2,
		totalBytes: Buffer.byteLength(source),
		sha256: createHash("sha256").update(source).digest("hex"),
	});
});

test("streaming Batch JSONL rejects schema drift, model drift, and media", async () => {
	const cases: Array<{ value: unknown; code: string }> = [
		{ value: { custom_id: "a", body: {}, tenant: "leak" }, code: "invalid_envelope" },
		{ value: { custom_id: "a", body: { model: "other" } }, code: "model_mismatch" },
		{
			value: { custom_id: "a", body: { messages: [{ content: [{ type: "image_url", image_url: "https://example.com/x.png" }] }] } },
			code: "unsupported_media",
		},
	];
	for (const fixture of cases) {
		await assert.rejects(
			consumeBatchJsonl(chunkedStream(textChunks(JSON.stringify(fixture.value))), {
				expectedModel: "deepseek-chat",
				onItem() {},
			}),
			(error: unknown) => error instanceof BatchJsonlError && error.code === fixture.code
		);
	}
});

test("streaming Batch JSONL enforces independent byte, line, count, and UTF-8 limits", async () => {
	const one = JSON.stringify({ custom_id: "a", body: { input: "hello" } });
	await assert.rejects(
		consumeBatchJsonl(chunkedStream(textChunks(one)), {
			expectedModel: "deepseek-chat",
		maxBytes: 4,
		onItem() {},
		}),
		(error: unknown) => error instanceof BatchJsonlError && error.code === "input_too_large"
	);
	await assert.rejects(
		consumeBatchJsonl(chunkedStream(textChunks(one)), {
			expectedModel: "deepseek-chat",
		maxLineBytes: 4,
		onItem() {},
		}),
		(error: unknown) => error instanceof BatchJsonlError && error.code === "line_too_large"
	);
	await assert.rejects(
		consumeBatchJsonl(chunkedStream(textChunks(`${one}\n${one}`)), {
			expectedModel: "deepseek-chat",
		maxRequests: 1,
		onItem() {},
		}),
		(error: unknown) => error instanceof BatchJsonlError && error.code === "too_many_requests"
	);
	await assert.rejects(
		consumeBatchJsonl(chunkedStream([new Uint8Array([0xc3, 0x28])]), {
			expectedModel: "deepseek-chat",
		onItem() {},
		}),
		(error: unknown) => error instanceof BatchJsonlError && error.code === "invalid_utf8"
	);
});

test("streaming Batch JSONL rejects empty input and propagates ledger callback failure", async () => {
	await assert.rejects(
		consumeBatchJsonl(chunkedStream([]), {
			expectedModel: "deepseek-chat",
			onItem() {},
		}),
		(error: unknown) => error instanceof BatchJsonlError && error.code === "empty_input"
	);
	await assert.rejects(
		consumeBatchJsonl(
			chunkedStream(textChunks(JSON.stringify({ custom_id: "a", body: { input: "hello" } }))),
			{
				expectedModel: "deepseek-chat",
				onItem() {
					throw new Error("duplicate custom_id");
				},
			}
		),
		/duplicate custom_id/u
	);
});

test("streaming Batch JSONL chunks expose exact UTF-8 range checkpoints", async () => {
	const firstLine = JSON.stringify({ custom_id: "请求-1", body: { input: "你好" } });
	const secondLine = JSON.stringify({ custom_id: "request-2", body: { input: "hello" } });
	const source = `${firstLine}\r\n${secondLine}`;
	const bytes = new TextEncoder().encode(source);
	const firstEnd = Buffer.byteLength(`${firstLine}\r\n`);
	const seen: Array<{ customId: string; ordinal: number; start: number; next: number; hash: string }> = [];
	const first = await consumeBatchJsonlChunk(
		chunkedStream(textChunks(source, [4, 13, firstEnd + 5])),
		{
			expectedModel: "deepseek-chat",
			totalInputBytes: bytes.byteLength,
			initialOrdinal: 0,
			initialOffset: 0,
			maxItems: 1,
			onItem(item, cursor) {
				seen.push({
					customId: item.custom_id,
					ordinal: cursor.ordinal,
					start: cursor.startOffset,
					next: cursor.nextOffset,
					hash: cursor.requestSha256,
				});
			},
		}
	);
	assert.deepEqual(first, {
		itemsProcessed: 1,
		nextOrdinal: 1,
		nextOffset: firstEnd,
		reachedEnd: false,
	});
	assert.deepEqual(seen[0], {
		customId: "请求-1",
		ordinal: 0,
		start: 0,
		next: firstEnd,
		hash: createHash("sha256").update(firstLine).digest("hex"),
	});

	const second = await consumeBatchJsonlChunk(
		chunkedStream([bytes.slice(firstEnd)]),
		{
			expectedModel: "deepseek-chat",
			totalInputBytes: bytes.byteLength,
			initialOrdinal: first.nextOrdinal,
			initialOffset: first.nextOffset,
			onItem(item, cursor) {
				seen.push({
					customId: item.custom_id,
					ordinal: cursor.ordinal,
					start: cursor.startOffset,
					next: cursor.nextOffset,
					hash: cursor.requestSha256,
				});
			},
		}
	);
	assert.equal(second.reachedEnd, true);
	assert.equal(second.nextOffset, bytes.byteLength);
	assert.equal(seen[1]?.ordinal, 1);
	assert.equal(seen[1]?.start, firstEnd);
	assert.equal(seen[1]?.hash, createHash("sha256").update(secondLine).digest("hex"));
});

test("streaming Batch JSONL chunks reject truncated range streams", async () => {
	const source = JSON.stringify({ custom_id: "a", body: { input: "hello" } });
	const bytes = new TextEncoder().encode(source);
	await assert.rejects(
		consumeBatchJsonlChunk(chunkedStream([bytes]), {
			expectedModel: "deepseek-chat",
			totalInputBytes: bytes.byteLength + 1,
			initialOrdinal: 0,
			initialOffset: 0,
			onItem() {},
		}),
		(error: unknown) =>
			error instanceof BatchJsonlError && error.code === "input_truncated"
	);
});
