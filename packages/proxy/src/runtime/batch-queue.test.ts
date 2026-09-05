import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Queue } from "@cloudflare/workers-types";
import type {
	AdvanceBatchValidationParams,
	BatchDispatchMessage,
	BatchRow,
	BatchesRepository,
	CompleteBatchValidationParams,
	FailBatchValidationParams,
} from "@octafuse/core";
import { batchValidationItemId, handleWorkerBatchQueue } from "./batch-queue";

function fixtureMessage(body: unknown, id = "message-1") {
	let action: "acked" | "retried" | null = null;
	let delaySeconds: number | undefined;
	return {
		message: {
			id,
			timestamp: new Date("2026-09-04T00:00:00.000Z"),
			body,
			attempts: 1,
			ack() {
				action = "acked";
			},
			retry(options?: QueueRetryOptions) {
				action = "retried";
				delaySeconds = options?.delaySeconds;
			},
		},
		result: () => ({ action, delaySeconds }),
	};
}

function fixtureBatch(queue: string, messages: Message<unknown>[]): MessageBatch<unknown> {
	return {
		queue,
		messages,
		metadata: {},
		retryAll() {},
		ackAll() {},
	};
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

function fixtureRow(input: Uint8Array, requestCount: number): BatchRow {
	return {
		id: "batch_12345678",
		account_id: "personal:user-1",
		workspace_id: "workspace-1",
		user_id: "user-1",
		api_key_hash: `sha256:${"a".repeat(64)}`,
		endpoint: "/v1/chat/completions",
		model_id: "deepseek-chat",
		route_group: "default",
		status: "validating",
		completion_window: "24h",
		idempotency_key_hash: null,
		input_object_key: "v1/workspaces/hash/batches/batch_12345678/input.jsonl",
		input_sha256: createHash("sha256").update(input).digest("hex"),
		input_bytes: input.byteLength,
		result_object_key: null,
		result_sha256: null,
		request_count: requestCount,
		validation_next_ordinal: 0,
		validation_input_offset: 0,
		completed_count: 0,
		failed_count: 0,
		cancelled_count: 0,
		prompt_tokens: 0,
		completion_tokens: 0,
		total_tokens: 0,
		charged_cost_micros: 0,
		byok_request_count: 0,
		unknown_cost_count: 0,
		created_at: "2026-09-04T00:00:00.000Z",
		in_progress_at: null,
		finalizing_at: null,
		finalized_at: null,
		expires_at: "2026-09-05T00:00:00.000Z",
		retention_expires_at: "2026-10-04T00:00:00.000Z",
		lease_owner: null,
		lease_expires_at: null,
		attempt_count: 0,
		revision: 0,
		last_error_code: null,
		updated_at: "2026-09-04T00:00:00.000Z",
	};
}

async function unavailable(): Promise<never> {
	throw new Error("unexpected repository call");
}

function fixtureRepository(
	overrides: Partial<BatchesRepository>
): BatchesRepository {
	return {
		create: unavailable,
		getByIdInWorkspace: unavailable,
		getByIdForDispatch: unavailable,
		listByWorkspace: unavailable,
		listDispatchCandidates: unavailable,
		claimLease: unavailable,
		renewLease: unavailable,
		advanceValidation: unavailable,
		completeValidation: unavailable,
		failValidation: unavailable,
		claimNextItem: unavailable,
		markItemDispatchStarted: unavailable,
		releaseItemBeforeDispatch: unavailable,
		...overrides,
	};
}

function validLine(customId: string): string {
	return JSON.stringify({ custom_id: customId, body: { input: "hello" } });
}

test("staged Batch consumer retries valid minimal messages", async () => {
	const fixture = fixtureMessage({ version: 1, batch_id: "batch_12345678" });
	await handleWorkerBatchQueue(fixtureBatch("batch-jobs", [fixture.message]), {
		BATCH_API_ENABLED: "false",
		BATCH_QUEUE_DLQ: "batch-jobs-dlq",
	});
	assert.deepEqual(fixture.result(), { action: "retried", delaySeconds: 300 });
});

test("staged Batch consumer acknowledges malformed messages", async () => {
	const fixture = fixtureMessage({ batch_id: "batch_12345678", prompt: "must not travel" });
	await handleWorkerBatchQueue(fixtureBatch("batch-jobs", [fixture.message]), {
		BATCH_QUEUE_DLQ: "batch-jobs-dlq",
	});
	assert.deepEqual(fixture.result(), { action: "acked", delaySeconds: undefined });
});

test("production Batch consumer rejects malformed messages before storage resolution", async () => {
	let storageResolutions = 0;
	const fixture = fixtureMessage({ batch_id: "batch_12345678", body: "must not travel" });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{},
		{
			async resolveBatchesRepository() {
				storageResolutions += 1;
				throw new Error("must not resolve");
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "acked", delaySeconds: undefined });
	assert.equal(storageResolutions, 0);
});

test("production Batch consumer retries a valid message when storage is unavailable", async () => {
	const fixture = fixtureMessage({ version: 1, batch_id: "batch_12345678" });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{},
		{
			async resolveBatchesRepository() {
				throw new TypeError("database unavailable");
			},
			objectStore: {
				async getVerifiedRange() {
					throw new Error("must not read");
				},
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "retried", delaySeconds: 30 });
});

test("Batch DLQ emits terminal triage and acknowledges messages", async () => {
	const fixture = fixtureMessage({ version: 1, batch_id: "batch_12345678" });
	await handleWorkerBatchQueue(fixtureBatch("batch-jobs-dlq", [fixture.message]), {
		BATCH_QUEUE_DLQ: "batch-jobs-dlq",
	});
	assert.deepEqual(fixture.result(), { action: "acked", delaySeconds: undefined });
});

test("Batch consumer validates a final chunk into a body-free item ledger", async () => {
	const bytes = new TextEncoder().encode(validLine("request-1"));
	const current = fixtureRow(bytes, 1);
	let advanced: AdvanceBatchValidationParams | null = null;
	let completed: CompleteBatchValidationParams | null = null;
	const repository = fixtureRepository({
		async getByIdForDispatch() {
			return current;
		},
		async claimLease(params) {
			return {
				...current,
				lease_owner: params.owner,
				lease_expires_at: params.leaseExpiresAtIso,
				revision: 1,
			};
		},
		async advanceValidation(params) {
			advanced = params;
			return {
				status: "advanced",
				batch: {
					...current,
					lease_owner: params.owner,
					lease_expires_at: "2026-09-04T00:05:00.000Z",
					validation_next_ordinal: 1,
					validation_input_offset: params.nextInputOffset,
					revision: 2,
				},
			};
		},
		async completeValidation(params) {
			completed = params;
			return { ...current, status: "in_progress", revision: 3 };
		},
	});
	const fixture = fixtureMessage({ version: 1, batch_id: current.id });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{},
		{
			resolveBatchesRepository: async () => repository,
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			objectStore: {
				async getVerifiedRange(
					workspaceId,
					batchId,
					kind,
					expectedSha256,
					expectedSize,
					offset
				) {
					assert.deepEqual(
						{ workspaceId, batchId, kind, expectedSha256, expectedSize, offset },
						{
							workspaceId: current.workspace_id,
							batchId: current.id,
							kind: "input",
							expectedSha256: current.input_sha256,
							expectedSize: bytes.byteLength,
							offset: 0,
						}
					);
					return { body: stream(bytes) };
				},
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "retried", delaySeconds: 300 });
	assert.equal(advanced?.items.length, 1);
	assert.deepEqual(advanced?.items[0], {
		id: batchValidationItemId(current.id, 0),
		ordinal: 0,
		customId: "request-1",
		requestStartOffset: 0,
		requestEndOffset: bytes.byteLength,
		requestSha256: createHash("sha256").update(bytes).digest("hex"),
	});
	assert.equal("body" in (advanced?.items[0] ?? {}), false);
	assert.equal(advanced?.nextInputOffset, bytes.byteLength);
	assert.equal(completed?.expectedRevision, 2);
});

test("Batch consumer creates a fresh continuation after a 100-item chunk", async () => {
	const source = Array.from({ length: 101 }, (_, index) => validLine(`request-${index}`)).join("\n");
	const bytes = new TextEncoder().encode(source);
	const current = fixtureRow(bytes, 101);
	let advanced: AdvanceBatchValidationParams | null = null;
	let continuation: { body: BatchDispatchMessage; delaySeconds: number | undefined } | null = null;
	const repository = fixtureRepository({
		async getByIdForDispatch() {
			return current;
		},
		async claimLease(params) {
			return {
				...current,
				lease_owner: params.owner,
				lease_expires_at: params.leaseExpiresAtIso,
				revision: 1,
			};
		},
		async advanceValidation(params) {
			advanced = params;
			return {
				status: "advanced",
				batch: {
					...current,
					lease_owner: params.owner,
					lease_expires_at: "2026-09-04T00:05:00.000Z",
					validation_next_ordinal: 100,
					validation_input_offset: params.nextInputOffset,
					revision: 2,
				},
			};
		},
	});
	const queue = {
		async send(body: BatchDispatchMessage, options?: { delaySeconds?: number }) {
			continuation = { body, delaySeconds: options?.delaySeconds };
		},
	} as Queue<BatchDispatchMessage>;
	const fixture = fixtureMessage({ version: 1, batch_id: current.id });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{ BATCH_QUEUE: queue },
		{
			resolveBatchesRepository: async () => repository,
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			objectStore: {
				async getVerifiedRange() {
					return { body: stream(bytes) };
				},
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "acked", delaySeconds: undefined });
	assert.equal(advanced?.items.length, 100);
	assert.ok((advanced?.nextInputOffset ?? bytes.byteLength) < bytes.byteLength);
	assert.deepEqual(continuation, {
		body: { version: 1, batch_id: current.id },
		delaySeconds: 1,
	});
});

test("Batch consumer fails closed on invalid JSONL without writing items", async () => {
	const bytes = new TextEncoder().encode("not-json");
	const current = fixtureRow(bytes, 1);
	let failed: FailBatchValidationParams | null = null;
	const repository = fixtureRepository({
		async getByIdForDispatch() {
			return current;
		},
		async claimLease(params) {
			return {
				...current,
				lease_owner: params.owner,
				lease_expires_at: params.leaseExpiresAtIso,
				revision: 1,
			};
		},
		async failValidation(params) {
			failed = params;
			return { ...current, status: "failed", last_error_code: params.errorCode };
		},
	});
	const fixture = fixtureMessage({ version: 1, batch_id: current.id });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{},
		{
			resolveBatchesRepository: async () => repository,
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			objectStore: {
				async getVerifiedRange() {
					return { body: stream(bytes) };
				},
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "acked", delaySeconds: undefined });
	assert.equal(failed?.errorCode, "batch_input_invalid");
});

test("Batch consumer retries lease contention before reading private input", async () => {
	const bytes = new TextEncoder().encode(validLine("request-1"));
	const current = fixtureRow(bytes, 1);
	let objectReads = 0;
	const repository = fixtureRepository({
		async getByIdForDispatch() {
			return current;
		},
		async claimLease() {
			return null;
		},
	});
	const fixture = fixtureMessage({ version: 1, batch_id: current.id });
	await handleWorkerBatchQueue(
		fixtureBatch("batch-jobs", [fixture.message]),
		{},
		{
			resolveBatchesRepository: async () => repository,
			now: () => new Date("2026-09-04T00:00:00.000Z"),
			objectStore: {
				async getVerifiedRange() {
					objectReads += 1;
					return { body: stream(bytes) };
				},
			},
		}
	);
	assert.deepEqual(fixture.result(), { action: "retried", delaySeconds: 30 });
	assert.equal(objectReads, 0);
});
