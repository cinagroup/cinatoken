import assert from "node:assert/strict";
import test from "node:test";
import {
	assertAdvanceBatchValidationParams,
	assertBatchLeaseParams,
	assertClaimNextBatchItemParams,
	assertCompleteBatchValidationParams,
	assertCreateBatchParams,
	assertFailBatchExecutionPreflightParams,
	assertFailBatchValidationParams,
	isBatchDispatchMessage,
	assertListBatchesParams,
	assertMarkBatchItemDispatchStartedParams,
	assertReleaseBatchItemBeforeDispatchParams,
	batchPage,
	normalizeBatchListLimit,
	type BatchRow,
	type CreateBatchParams,
} from "./batch-types";
import {
	normalizeBatchItemRow,
	normalizeBatchRow,
	type BatchDatabaseRow,
	type BatchItemDatabaseRow,
} from "./batch-repository-utils";

const SHA = "a".repeat(64);
const CREATED_AT = "2026-09-04T00:00:00.000Z";

test("batch dispatch messages contain only a version and opaque batch id", () => {
	assert.equal(
		isBatchDispatchMessage({ version: 1, batch_id: "batch_12345678" }),
		true
	);
	for (const invalid of [
		null,
		[],
		{ version: 2, batch_id: "batch_12345678" },
		{ version: 1, batch_id: "wrong_12345678" },
		{ version: 1, batch_id: "batch_12345678", workspace_id: "secret" },
	]) {
		assert.equal(isBatchDispatchMessage(invalid), false);
	}
});

function validCreateParams(): CreateBatchParams {
	return {
		id: "batch_12345678",
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		userId: "user-1",
		apiKeyHash: `sha256:${SHA}`,
		endpoint: "/v1/chat/completions",
		modelId: "deepseek/deepseek-chat",
		routeGroup: "default",
		idempotencyKeyHash: "b".repeat(64),
		inputObjectKey: `v1/workspaces/${SHA}/batches/batch_12345678/input.jsonl`,
		inputSha256: "c".repeat(64),
		inputBytes: 256,
		requestCount: 2,
		createdAt: CREATED_AT,
		expiresAt: "2026-09-05T00:00:00.000Z",
		retentionExpiresAt: "2026-10-04T00:00:00.000Z",
	};
}

test("batch create validation pins private storage and retention contracts", () => {
	assert.doesNotThrow(() => assertCreateBatchParams(validCreateParams()));
	assert.throws(
		() =>
			assertCreateBatchParams({
				...validCreateParams(),
				inputObjectKey: "public/batch_12345678/input.jsonl",
			}),
		/private namespace/u
	);
	assert.throws(
		() =>
			assertCreateBatchParams({
				...validCreateParams(),
				inputObjectKey: `v1/workspaces/${SHA}/batches/extra/batches/batch_12345678/input.jsonl`,
			}),
		/private namespace/u
	);
	assert.throws(
		() =>
			assertCreateBatchParams({
				...validCreateParams(),
				expiresAt: "2026-09-05T00:00:00.001Z",
			}),
		/exactly 24 hours/u
	);
	assert.throws(
		() =>
			assertCreateBatchParams({
				...validCreateParams(),
				retentionExpiresAt: "2026-10-04T00:00:00.001Z",
			}),
		/exactly 30 days/u
	);
});

test("batch list and lease validation stays bounded", () => {
	assert.equal(normalizeBatchListLimit(undefined), 20);
	assert.throws(() => normalizeBatchListLimit(101), /between 1 and 100/u);
	assert.throws(
		() =>
			assertListBatchesParams({
				accountId: "personal:user-1",
				workspaceId: "workspace-1",
				createdAfter: "2026-09-05T00:00:00.000Z",
				createdBefore: CREATED_AT,
			}),
		/earlier/u
	);
	assert.throws(
		() =>
			assertListBatchesParams({
				accountId: "personal:user-1",
				workspaceId: "workspace-1",
				createdAfter: "2026-09-04T00:00:00Z",
			}),
		/canonical UTC/u
	);
	assert.throws(
		() =>
			assertBatchLeaseParams({
				id: "batch_12345678",
				accountId: "personal:user-1",
				workspaceId: "workspace-1",
				owner: "consumer-1",
				expectedRevision: 0,
				nowIso: CREATED_AT,
				leaseExpiresAtIso: "2026-09-04T00:05:00.001Z",
			}),
		/no longer than five minutes/u
	);
});

test("batch validation chunks require a live-safe contiguous body-free cursor", () => {
	const valid = {
		id: "batch_12345678",
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		owner: "consumer-1",
		expectedRevision: 1,
		expectedNextOrdinal: 4,
		expectedInputOffset: 128,
		nextInputOffset: 256,
		items: [
			{
				id: "batch_req_00000004",
				ordinal: 4,
				customId: "request-4",
				requestStartOffset: 128,
				requestEndOffset: 192,
				requestSha256: "d".repeat(64),
			},
			{
				id: "batch_req_00000005",
				ordinal: 5,
				customId: "request-5",
				requestStartOffset: 192,
				requestEndOffset: 256,
				requestSha256: "e".repeat(64),
			},
		],
		nowIso: "2026-09-04T00:01:00.000Z",
	};
	assert.doesNotThrow(() => assertAdvanceBatchValidationParams(valid));
	assert.throws(
		() =>
			assertAdvanceBatchValidationParams({
				...valid,
				items: [{ ...valid.items[0]!, ordinal: 5 }],
			}),
		/contiguous/u
	);
	assert.throws(
		() =>
			assertAdvanceBatchValidationParams({
				...valid,
				nextInputOffset: valid.expectedInputOffset,
			}),
		/byte checkpoint/u
	);
	assert.throws(
		() =>
			assertAdvanceBatchValidationParams({
				...valid,
				items: [
					valid.items[0]!,
					{ ...valid.items[1]!, requestStartOffset: 193 },
				],
			}),
		/byte ranges/u
	);
	assert.throws(
		() =>
			assertAdvanceBatchValidationParams({
				...valid,
				items: [valid.items[0]!, { ...valid.items[1]!, customId: "request-4" }],
			}),
		/duplicate item identity/u
	);
	assert.doesNotThrow(() =>
		assertCompleteBatchValidationParams({
			id: valid.id,
			accountId: valid.accountId,
			workspaceId: valid.workspaceId,
			owner: valid.owner,
			expectedRevision: valid.expectedRevision,
			nowIso: valid.nowIso,
		})
	);
	assert.throws(
		() =>
			assertFailBatchValidationParams({
				id: valid.id,
				accountId: valid.accountId,
				workspaceId: valid.workspaceId,
				owner: valid.owner,
				expectedRevision: valid.expectedRevision,
				nowIso: valid.nowIso,
				errorCode: "raw_database_error" as "batch_input_invalid",
			}),
		/unsupported/u
	);
});

test("batch item claim and dispatch markers require live bounded identities", () => {
	const claim = {
		id: "batch_12345678",
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		owner: "executor-1",
		expectedRevision: 3,
		nowIso: "2026-09-04T00:04:00.000Z",
		leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
	};
	assert.doesNotThrow(() => assertClaimNextBatchItemParams(claim));
	const mark = {
		id: claim.id,
		accountId: claim.accountId,
		workspaceId: claim.workspaceId,
		owner: claim.owner,
		expectedRevision: claim.expectedRevision,
		itemId: "batch_req_execute01",
		itemOrdinal: 0,
		expectedItemRevision: 1,
		generationId: "gen_batch_request_1",
		reservationId: "gen_batch_request_1",
		nowIso: "2026-09-04T00:05:00.000Z",
	};
	assert.doesNotThrow(() => assertMarkBatchItemDispatchStartedParams(mark));
	assert.doesNotThrow(() =>
		assertReleaseBatchItemBeforeDispatchParams({
			id: mark.id,
			accountId: mark.accountId,
			workspaceId: mark.workspaceId,
			owner: mark.owner,
			expectedRevision: mark.expectedRevision,
			itemId: mark.itemId,
			itemOrdinal: mark.itemOrdinal,
			expectedItemRevision: mark.expectedItemRevision,
			nowIso: mark.nowIso,
		})
	);
	assert.throws(
		() =>
			assertMarkBatchItemDispatchStartedParams({
				...mark,
				expectedItemRevision: -1,
			}),
		/non-negative/u
	);
	assert.throws(
		() =>
			assertMarkBatchItemDispatchStartedParams({
				...mark,
				generationId: "generation\nsecret",
			}),
		/control characters/u
	);
	assert.doesNotThrow(() =>
		assertFailBatchExecutionPreflightParams({
			id: claim.id,
			accountId: claim.accountId,
			workspaceId: claim.workspaceId,
			owner: claim.owner,
			expectedRevision: claim.expectedRevision,
			nowIso: mark.nowIso,
			errorCode: "batch_key_inactive",
		})
	);
	assert.throws(
		() =>
			assertFailBatchExecutionPreflightParams({
				id: claim.id,
				accountId: claim.accountId,
				workspaceId: claim.workspaceId,
				owner: claim.owner,
				expectedRevision: claim.expectedRevision,
				nowIso: mark.nowIso,
				errorCode: "raw_database_error" as "batch_key_inactive",
			}),
		/unsupported/u
	);
});

test("batch pagination emits a stable keyset cursor", () => {
	const params = validCreateParams();
	const row = {
		id: params.id,
		account_id: params.accountId,
		workspace_id: params.workspaceId,
		user_id: params.userId,
		api_key_hash: params.apiKeyHash,
		endpoint: params.endpoint,
		model_id: params.modelId,
		route_group: params.routeGroup,
		status: "validating",
		completion_window: "24h",
		idempotency_key_hash: params.idempotencyKeyHash,
		input_object_key: params.inputObjectKey,
		input_sha256: params.inputSha256,
		input_bytes: params.inputBytes,
		result_object_key: null,
		result_sha256: null,
		request_count: params.requestCount,
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
		created_at: params.createdAt,
		in_progress_at: null,
		finalizing_at: null,
		finalized_at: null,
		expires_at: params.expiresAt,
		retention_expires_at: params.retentionExpiresAt,
		lease_owner: null,
		lease_expires_at: null,
		attempt_count: 0,
		revision: 0,
		last_error_code: null,
		updated_at: params.createdAt,
	} satisfies BatchRow;
	const page = batchPage([row, { ...row, id: "batch_abcdefgh" }], 1);
	assert.equal(page.hasMore, true);
	assert.deepEqual(page.nextCursor, {
		id: "batch_12345678",
		createdAt: CREATED_AT,
	});
});

test("batch database normalization accepts safe BIGINT strings and rejects null invariants", () => {
	const params = validCreateParams();
	const databaseRow = {
		id: params.id,
		account_id: params.accountId,
		workspace_id: params.workspaceId,
		user_id: params.userId,
		api_key_hash: params.apiKeyHash,
		endpoint: params.endpoint,
		model_id: params.modelId,
		route_group: params.routeGroup,
		status: "validating",
		completion_window: "24h",
		idempotency_key_hash: params.idempotencyKeyHash,
		input_object_key: params.inputObjectKey,
		input_sha256: params.inputSha256,
		input_bytes: "256",
		result_object_key: null,
		result_sha256: null,
		request_count: "2",
		validation_next_ordinal: "0",
		validation_input_offset: "0",
		completed_count: "0",
		failed_count: "0",
		cancelled_count: "0",
		prompt_tokens: "9007199254740991",
		completion_tokens: "0",
		total_tokens: "9007199254740991",
		charged_cost_micros: "0",
		byok_request_count: "0",
		unknown_cost_count: "0",
		created_at: new Date(params.createdAt),
		in_progress_at: null,
		finalizing_at: null,
		finalized_at: null,
		expires_at: params.expiresAt,
		retention_expires_at: params.retentionExpiresAt,
		lease_owner: null,
		lease_expires_at: null,
		attempt_count: "0",
		revision: "0",
		last_error_code: null,
		updated_at: params.createdAt,
	} satisfies BatchDatabaseRow;
	const normalized = normalizeBatchRow(databaseRow);
	assert.equal(normalized.prompt_tokens, Number.MAX_SAFE_INTEGER);
	assert.equal(normalized.created_at, params.createdAt);
	assert.throws(
		() => normalizeBatchRow({ ...databaseRow, expires_at: null }),
		/invalid null batch timestamp/u
	);
	assert.throws(
		() =>
			normalizeBatchRow({
				...databaseRow,
				prompt_tokens: "9007199254740992",
			}),
		/invalid batch integer/u
	);
});

test("batch item normalization preserves the dispatch fence and safe integer limits", () => {
	const row = {
		id: "batch_req_execute01",
		batch_id: "batch_12345678",
		ordinal: "0",
		custom_id: "request-1",
		status: "in_progress",
		attempt_count: "1",
		started_at: new Date("2026-09-04T00:04:00.000Z"),
		dispatch_started_at: "2026-09-04T00:05:00.000Z",
		completed_at: null,
		generation_id: "gen_batch_request_1",
		reservation_id: "gen_batch_request_1",
		lease_owner: "executor-1",
		lease_expires_at: "2026-09-04T00:08:00.000Z",
		request_start_offset: "0",
		request_end_offset: "128",
		request_sha256: "d".repeat(64),
		result_object_key: null,
		result_sha256: null,
		error_code: null,
		error_summary: null,
		revision: "2",
		created_at: "2026-09-04T00:02:00.000Z",
		updated_at: "2026-09-04T00:05:00.000Z",
	} satisfies BatchItemDatabaseRow;
	const normalized = normalizeBatchItemRow(row);
	assert.equal(normalized.ordinal, 0);
	assert.equal(normalized.revision, 2);
	assert.equal(normalized.started_at, "2026-09-04T00:04:00.000Z");
	assert.equal(normalized.dispatch_started_at, "2026-09-04T00:05:00.000Z");
	assert.throws(
		() => normalizeBatchItemRow({ ...row, revision: "9007199254740992" }),
		/invalid batch integer/u
	);
});
