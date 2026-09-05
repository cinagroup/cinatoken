import assert from "node:assert/strict";
import test from "node:test";
import type { CreateBatchParams } from "../db/batch-types";
import type { BatchItemDatabaseRow } from "../db/batch-repository-utils";
import { createMySqlBatchesRepository } from "../db/mysql/batches.impl";
import { createPostgresBatchesRepository } from "../db/postgres/batches.impl";
import type {
	MySqlDatabaseClient,
	PostgresDatabaseClient,
} from "./database-client";

const SHA = "a".repeat(64);

function params(): CreateBatchParams {
	return {
		id: "batch_12345678",
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		userId: "user-1",
		apiKeyHash: `sha256:${"b".repeat(64)}`,
		endpoint: "/v1/responses",
		modelId: "deepseek/deepseek-chat",
		routeGroup: "default",
		idempotencyKeyHash: "c".repeat(64),
		inputObjectKey: `v1/workspaces/${SHA}/batches/batch_12345678/input.jsonl`,
		inputSha256: "d".repeat(64),
		inputBytes: 256,
		requestCount: 3,
		createdAt: "2026-09-04T00:00:00.000Z",
		expiresAt: "2026-09-05T00:00:00.000Z",
		retentionExpiresAt: "2026-10-04T00:00:00.000Z",
	};
}

function row() {
	const input = params();
	return {
		id: input.id,
		account_id: input.accountId,
		workspace_id: input.workspaceId,
		user_id: input.userId,
		api_key_hash: input.apiKeyHash,
		endpoint: input.endpoint,
		model_id: input.modelId,
		route_group: input.routeGroup,
		status: "validating" as const,
		completion_window: "24h" as const,
		idempotency_key_hash: input.idempotencyKeyHash,
		input_object_key: input.inputObjectKey,
		input_sha256: input.inputSha256,
		input_bytes: input.inputBytes,
		result_object_key: null,
		result_sha256: null,
		request_count: input.requestCount,
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
		created_at: input.createdAt,
		in_progress_at: null,
		finalizing_at: null,
		finalized_at: null,
		expires_at: input.expiresAt,
		retention_expires_at: input.retentionExpiresAt,
		lease_owner: null,
		lease_expires_at: null,
		attempt_count: 0,
		revision: 0,
		last_error_code: null,
		updated_at: input.createdAt,
	};
}

function itemRow() {
	return {
		id: "batch_req_execute01",
		batch_id: params().id,
		ordinal: 0,
		custom_id: "request-1",
		status: "pending" as const,
		attempt_count: 0,
		started_at: null,
		dispatch_started_at: null,
		completed_at: null,
		generation_id: null,
		reservation_id: null,
		lease_owner: null,
		lease_expires_at: null,
		request_start_offset: 0,
		request_end_offset: 128,
		request_sha256: "1".repeat(64),
		result_object_key: null,
		result_sha256: null,
		error_code: null,
		error_summary: null,
		revision: 0,
		created_at: "2026-09-04T00:02:00.000Z",
		updated_at: "2026-09-04T00:02:00.000Z",
	};
}

test("PostgreSQL Batch replay and list queries remain workspace scoped", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const transaction = {
		unsafe: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (/^INSERT INTO batches/u.test(sql)) return [];
			if (/idempotency_key_hash = \$3 FOR SHARE/u.test(sql)) return [row()];
			return [];
		},
	};
	const raw = {
		begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
			callback(transaction),
		unsafe: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			return [];
		},
	};
	const repository = createPostgresBatchesRepository({
		driver: "postgres",
		raw,
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	assert.equal((await repository.create(params())).status, "idempotent");
	assert.match(calls[1]?.sql ?? "", /workspace_id = \$1 AND api_key_hash = \$2/u);

	await repository.listByWorkspace({
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		statuses: ["validating", "completed"],
		after: {
			id: "batch_abcdefgh",
			createdAt: "2026-09-03T00:00:00.000Z",
		},
		limit: 25,
	});
	const list = calls.at(-1)!;
	assert.match(list.sql, /account_id = \$1/u);
	assert.match(list.sql, /workspace_id = \$2/u);
	assert.match(list.sql, /\(created_at, id\) < \(\$5::timestamptz, \$6\)/u);
	assert.match(list.sql, /LIMIT \$7/u);
	assert.deepEqual(list.values.slice(0, 4), [
		"personal:user-1",
		"workspace-1",
		"validating",
		"completed",
	]);
	assert.equal(list.values.at(-1), 26);
});

test("PostgreSQL Batch lease is a tenant-scoped revision CAS", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const repository = createPostgresBatchesRepository({
		driver: "postgres",
		raw: {
			unsafe: async (sql: string, values: unknown[] = []) => {
				calls.push({ sql, values });
				return [];
			},
		},
		drizzle: {},
	} as unknown as PostgresDatabaseClient);
	await repository.claimLease({
		id: params().id,
		accountId: params().accountId,
		workspaceId: params().workspaceId,
		owner: "consumer-1",
		expectedRevision: 7,
		nowIso: "2026-09-04T00:01:00.000Z",
		leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
	});
	assert.match(calls[0]!.sql, /account_id = \$5 AND workspace_id = \$6/u);
	assert.match(calls[0]!.sql, /revision = \$7::bigint/u);
	assert.match(calls[0]!.sql, /lease_expires_at IS NULL OR lease_expires_at <= \$3/u);
	assert.match(calls[0]!.sql, /RETURNING/u);
});

test("PostgreSQL Batch validation locks the tenant row and commits body-free items with its cursor", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const locked = {
		...row(),
		lease_owner: "consumer-1",
		lease_expires_at: "2026-09-04T00:05:00.000Z",
		revision: 7,
	};
	const transaction = {
		unsafe: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			if (/FOR UPDATE/u.test(sql)) return [locked];
			if (/^INSERT INTO batch_items/u.test(sql)) return [];
			if (/^UPDATE batches/u.test(sql)) {
				return [{
					...locked,
					validation_next_ordinal: 2,
					validation_input_offset: 256,
				}];
			}
			return [];
		},
	};
	const raw = {
		begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
			callback(transaction),
	};
	const repository = createPostgresBatchesRepository({
		driver: "postgres",
		raw,
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	const result = await repository.advanceValidation({
		id: params().id,
		accountId: params().accountId,
		workspaceId: params().workspaceId,
		owner: "consumer-1",
		expectedRevision: 7,
		expectedNextOrdinal: 0,
		expectedInputOffset: 0,
		nextInputOffset: 256,
		items: [
			{
				id: "batch_req_00000001",
				ordinal: 0,
				customId: "request-1",
				requestStartOffset: 0,
				requestEndOffset: 128,
				requestSha256: "1".repeat(64),
			},
			{
				id: "batch_req_00000002",
				ordinal: 1,
				customId: "request-2",
				requestStartOffset: 128,
				requestEndOffset: 256,
				requestSha256: "2".repeat(64),
			},
		],
		nowIso: "2026-09-04T00:02:00.000Z",
	});
	assert.equal(result.status, "advanced");
	assert.equal(calls.length, 3);
	assert.match(calls[0]!.sql, /account_id = \$2 AND workspace_id = \$3/u);
	assert.match(calls[0]!.sql, /FOR UPDATE/u);
	assert.match(calls[1]!.sql, /INSERT INTO batch_items/u);
	assert.match(
		calls[1]!.sql,
		/request_start_offset, request_end_offset, request_sha256/u
	);
	assert.doesNotMatch(calls[1]!.sql, /request_body|response_body/u);
	assert.deepEqual(calls[1]!.values.slice(4, 7), [0, 128, "1".repeat(64)]);
	assert.deepEqual(calls[1]!.values.slice(13, 16), [128, 256, "2".repeat(64)]);
	assert.match(calls[2]!.sql, /validation_next_ordinal = \$9/u);
	assert.match(calls[2]!.sql, /lease_owner = \$8/u);
});

test("PostgreSQL Batch validation classifies uniqueness failures as conflicts", async () => {
	const locked = {
		...row(),
		lease_owner: "consumer-1",
		lease_expires_at: "2026-09-04T00:05:00.000Z",
		revision: 7,
	};
	const transaction = {
		unsafe: async (sql: string) => {
			if (/FOR UPDATE/u.test(sql)) return [locked];
			throw Object.assign(new Error("duplicate"), { code: "23505" });
		},
	};
	const repository = createPostgresBatchesRepository({
		driver: "postgres",
		raw: {
			begin: async <T>(callback: (tx: typeof transaction) => Promise<T>) =>
				callback(transaction),
		},
		drizzle: {},
	} as unknown as PostgresDatabaseClient);
	const result = await repository.advanceValidation({
		id: params().id,
		accountId: params().accountId,
		workspaceId: params().workspaceId,
		owner: "consumer-1",
		expectedRevision: 7,
		expectedNextOrdinal: 0,
		expectedInputOffset: 0,
		nextInputOffset: 128,
		items: [{
			id: "batch_req_00000001",
			ordinal: 0,
			customId: "request-1",
			requestStartOffset: 0,
			requestEndOffset: 128,
			requestSha256: "1".repeat(64),
		}],
		nowIso: "2026-09-04T00:02:00.000Z",
	});
	assert.equal(result.status, "conflict");
});

test("PostgreSQL Batch item claim and dispatch marker are lease-fenced CAS writes", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	let inTransaction = false;
	const liveBatch = {
		...row(),
		status: "in_progress" as const,
		lease_owner: "executor-1",
		lease_expires_at: "2026-09-04T00:08:00.000Z",
		revision: 7,
	};
	const pendingItem = itemRow();
	const unsafe = async (sql: string, values: unknown[] = []) => {
			assert.ok(inTransaction, "parent lock and item writes share one transaction");
			calls.push({ sql, values });
			if (/FROM batches[\s\S]+FOR UPDATE/u.test(sql)) return [liveBatch];
			if (/SELECT[\s\S]+FROM batch_items/u.test(sql)) return [pendingItem];
			if (/UPDATE batch_items[\s\S]+SET status = 'in_progress'/u.test(sql)) {
				return [{
					...pendingItem,
					status: "in_progress",
					attempt_count: 1,
					started_at: "2026-09-04T00:04:00.000Z",
					lease_owner: "executor-1",
					lease_expires_at: "2026-09-04T00:08:00.000Z",
					revision: 1,
					updated_at: "2026-09-04T00:04:00.000Z",
				}];
			}
			if (/SET dispatch_started_at/u.test(sql)) {
				return [{
					...pendingItem,
					status: "in_progress",
					attempt_count: 1,
					started_at: "2026-09-04T00:04:00.000Z",
					dispatch_started_at: "2026-09-04T00:05:00.000Z",
					generation_id: "gen_batch_request_1",
					reservation_id: "gen_batch_request_1",
					lease_owner: "executor-1",
					lease_expires_at: "2026-09-04T00:08:00.000Z",
					revision: 2,
					updated_at: "2026-09-04T00:05:00.000Z",
				}];
			}
			return [];
	};
	const raw = {
		unsafe,
		begin: async <T>(callback: (tx: { unsafe: typeof unsafe }) => Promise<T>) => {
			inTransaction = true;
			try { return await callback(raw); } finally { inTransaction = false; }
		},
	};
	const repository = createPostgresBatchesRepository({
		driver: "postgres",
		raw,
		drizzle: {},
	} as unknown as PostgresDatabaseClient);

	const claimed = await repository.claimNextItem({
		id: liveBatch.id,
		accountId: liveBatch.account_id,
		workspaceId: liveBatch.workspace_id,
		owner: "executor-1",
		expectedRevision: liveBatch.revision,
		nowIso: "2026-09-04T00:04:00.000Z",
		leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
	});
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") throw new Error("expected item claim");
	assert.equal(claimed.item.revision, 1);
	const claimSelect = calls.find((call) => /FROM batch_items/u.test(call.sql));
	assert.match(claimSelect?.sql ?? "", /ORDER BY ordinal LIMIT 1 FOR UPDATE/u);
	const claimUpdate = calls.find((call) => /SET status = 'in_progress'/u.test(call.sql));
	assert.match(claimUpdate?.sql ?? "", /dispatch_started_at IS NULL/u);
	assert.match(claimUpdate?.sql ?? "", /revision = \$7::bigint/u);

	calls.length = 0;
	const dispatchParams = {
		id: liveBatch.id,
		accountId: liveBatch.account_id,
		workspaceId: liveBatch.workspace_id,
		owner: "executor-1",
		expectedRevision: liveBatch.revision,
		itemId: claimed.item.id,
		itemOrdinal: claimed.item.ordinal,
		expectedItemRevision: claimed.item.revision,
		generationId: "gen_batch_request_1",
		reservationId: "gen_batch_request_1",
		nowIso: "2026-09-04T00:05:00.000Z",
	};
	const marked = await repository.markItemDispatchStarted(dispatchParams);
	assert.equal(marked?.dispatch_started_at, "2026-09-04T00:05:00.000Z");
	assert.match(calls[0]!.sql, /FROM batches[\s\S]+account_id = \$2 AND workspace_id = \$3[\s\S]+FOR UPDATE/u);
	assert.deepEqual(calls[0]!.values, [liveBatch.id, liveBatch.account_id, liveBatch.workspace_id]);
	const dispatch = calls.find((call) => /SET dispatch_started_at/u.test(call.sql));
	assert.match(dispatch?.sql ?? "", /revision = \$7::bigint/u);
	assert.match(dispatch?.sql ?? "", /dispatch_started_at IS NULL AND lease_owner = \$8/u);
	assert.match(dispatch?.sql ?? "", /lease_expires_at > \$1::timestamptz/u);
	assert.deepEqual(dispatch?.values.slice(3), [claimed.item.id, liveBatch.id, claimed.item.ordinal, claimed.item.revision, "executor-1"]);

	for (const invalidParent of [
		{ revision: 8 }, { lease_owner: "other-executor" },
		{ lease_expires_at: "2026-09-04T00:04:59.000Z" },
	]) {
		const original = { ...liveBatch };
		Object.assign(liveBatch, invalidParent);
		calls.length = 0;
		assert.equal(await repository.markItemDispatchStarted(dispatchParams), null);
		assert.equal(calls.length, 1, "invalid parent lease must prevent all item writes");
		Object.assign(liveBatch, original);
	}
});

test("MySQL Batch replay hashes the workspace scope and commits exact replay", async () => {
	const calls: Array<{ kind: "query" | "execute"; sql: string; values: unknown[] }> = [];
	let commits = 0;
	let rollbacks = 0;
	const connection = {
		beginTransaction: async () => undefined,
		commit: async () => {
			commits += 1;
		},
		rollback: async () => {
			rollbacks += 1;
		},
		release: () => undefined,
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "query" as const, sql, values });
			if (/idempotency_key_hash = \? FOR UPDATE/u.test(sql)) return [[row()], {}];
			return [[], {}];
		},
		execute: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "execute" as const, sql, values });
			throw Object.assign(new Error("duplicate"), { errno: 1062 });
		},
	};
	const repository = createMySqlBatchesRepository({
		driver: "mysql",
		raw: { getConnection: async () => connection },
		drizzle: {},
	} as unknown as MySqlDatabaseClient);

	assert.equal((await repository.create(params())).status, "idempotent");
	assert.deepEqual({ commits, rollbacks }, { commits: 1, rollbacks: 0 });
	const replay = calls.find((call) => /idempotency_key_hash = \? FOR UPDATE/u.test(call.sql));
	assert.match(replay?.sql ?? "", /account_id = \?/u);
	assert.match(replay?.sql ?? "", /workspace_key = SHA2\(\?, 256\)/u);
	assert.deepEqual(replay?.values.slice(0, 3), [
		"personal:user-1",
		"workspace-1",
		"workspace-1",
	]);
});

test("MySQL Batch list keeps collision-safe workspace equality and bounded pagination", async () => {
	const calls: Array<{ sql: string; values: unknown[] }> = [];
	const raw = {
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ sql, values });
			return [[], {}];
		},
	};
	const repository = createMySqlBatchesRepository({
		driver: "mysql",
		raw,
		drizzle: {},
	} as unknown as MySqlDatabaseClient);
	await repository.listByWorkspace({
		accountId: "personal:user-1",
		workspaceId: "workspace-1",
		createdAfter: "2026-09-01T00:00:00.000Z",
		limit: 100,
	});
	assert.match(calls[0]!.sql, /workspace_key = SHA2\(\?, 256\)/u);
	assert.match(calls[0]!.sql, /workspace_id = \?/u);
	assert.match(calls[0]!.sql, /ORDER BY created_at DESC, id DESC LIMIT \?/u);
	assert.deepEqual(calls[0]!.values.slice(0, 3), [
		"personal:user-1",
		"workspace-1",
		"workspace-1",
	]);
	assert.equal(calls[0]!.values.at(-1), 101);
});

test("MySQL Batch validation commits item rows and checkpoint in one locked transaction", async () => {
	const calls: Array<{ kind: "query" | "execute"; sql: string; values: unknown[] }> = [];
	let checkpointAdvanced = false;
	let commits = 0;
	const locked = {
		...row(),
		lease_owner: "consumer-1",
		lease_expires_at: "2026-09-04T00:05:00.000Z",
		revision: 7,
	};
	const connection = {
		beginTransaction: async () => undefined,
		commit: async () => {
			commits += 1;
		},
		rollback: async () => undefined,
		release: () => undefined,
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "query", sql, values });
			if (/SELECT[\s\S]+FROM batches/u.test(sql)) {
				return [[{
					...locked,
					validation_next_ordinal: checkpointAdvanced ? 2 : 0,
					validation_input_offset: checkpointAdvanced ? 256 : 0,
				}], {}];
			}
			return [[], {}];
		},
		execute: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "execute", sql, values });
			if (/SET validation_next_ordinal/u.test(sql)) checkpointAdvanced = true;
			return [{ affectedRows: 1 }, {}];
		},
	};
	const repository = createMySqlBatchesRepository({
		driver: "mysql",
		raw: { getConnection: async () => connection },
		drizzle: {},
	} as unknown as MySqlDatabaseClient);
	const result = await repository.advanceValidation({
		id: params().id,
		accountId: params().accountId,
		workspaceId: params().workspaceId,
		owner: "consumer-1",
		expectedRevision: 7,
		expectedNextOrdinal: 0,
		expectedInputOffset: 0,
		nextInputOffset: 256,
		items: [
			{
				id: "batch_req_00000001",
				ordinal: 0,
				customId: "request-1",
				requestStartOffset: 0,
				requestEndOffset: 128,
				requestSha256: "1".repeat(64),
			},
			{
				id: "batch_req_00000002",
				ordinal: 1,
				customId: "request-2",
				requestStartOffset: 128,
				requestEndOffset: 256,
				requestSha256: "2".repeat(64),
			},
		],
		nowIso: "2026-09-04T00:02:00.000Z",
	});
	assert.equal(result.status, "advanced");
	assert.equal(commits, 1);
	const insert = calls.find((call) => /INSERT INTO batch_items/u.test(call.sql));
	assert.ok(insert);
	assert.match(
		insert.sql,
		/request_start_offset, request_end_offset, request_sha256/u
	);
	assert.doesNotMatch(insert.sql, /request_body|response_body/u);
	assert.deepEqual(insert.values.slice(4, 7), [0, 128, "1".repeat(64)]);
	assert.deepEqual(insert.values.slice(13, 16), [128, 256, "2".repeat(64)]);
	const checkpoint = calls.find((call) => /SET validation_next_ordinal/u.test(call.sql));
	assert.match(checkpoint?.sql ?? "", /workspace_key = SHA2\(\?, 256\)/u);
	assert.match(checkpoint?.sql ?? "", /lease_owner = \?/u);
});

test("MySQL Batch item claim and dispatch marker lock both execution ledgers", async () => {
	const calls: Array<{ kind: "query" | "execute"; sql: string; values: unknown[] }> = [];
	let commits = 0;
	const liveBatch = {
		...row(),
		status: "in_progress" as const,
		lease_owner: "executor-1",
		lease_expires_at: "2026-09-04T00:08:00.000Z",
		revision: 7,
	};
	let currentItem: BatchItemDatabaseRow = itemRow();
	const connection = {
		beginTransaction: async () => undefined,
		commit: async () => {
			commits += 1;
		},
		rollback: async () => undefined,
		release: () => undefined,
		query: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "query", sql, values });
			if (/FROM batches/u.test(sql)) return [[liveBatch], {}];
			if (/FROM batch_items/u.test(sql)) return [[currentItem], {}];
			return [[], {}];
		},
		execute: async (sql: string, values: unknown[] = []) => {
			calls.push({ kind: "execute", sql, values });
			if (/SET status = 'in_progress'/u.test(sql)) {
				currentItem = {
					...currentItem,
					status: "in_progress",
					attempt_count: 1,
					started_at: "2026-09-04T00:04:00.000Z",
					lease_owner: "executor-1",
					lease_expires_at: "2026-09-04T00:08:00.000Z",
					revision: 1,
					updated_at: "2026-09-04T00:04:00.000Z",
				};
			}
			if (/SET dispatch_started_at/u.test(sql)) {
				currentItem = {
					...currentItem,
					dispatch_started_at: "2026-09-04T00:05:00.000Z",
					generation_id: "gen_batch_request_1",
					reservation_id: "gen_batch_request_1",
					revision: 2,
					updated_at: "2026-09-04T00:05:00.000Z",
				};
			}
			return [{ affectedRows: 1 }, {}];
		},
	};
	const repository = createMySqlBatchesRepository({
		driver: "mysql",
		raw: { getConnection: async () => connection },
		drizzle: {},
	} as unknown as MySqlDatabaseClient);

	const claimed = await repository.claimNextItem({
		id: liveBatch.id,
		accountId: liveBatch.account_id,
		workspaceId: liveBatch.workspace_id,
		owner: "executor-1",
		expectedRevision: liveBatch.revision,
		nowIso: "2026-09-04T00:04:00.000Z",
		leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
	});
	assert.equal(claimed.status, "claimed");
	if (claimed.status !== "claimed") throw new Error("expected item claim");
	assert.equal(claimed.item.attempt_count, 1);
	const candidate = calls.find(
		(call) => call.kind === "query" && /ORDER BY ordinal LIMIT 1/u.test(call.sql)
	);
	assert.match(candidate?.sql ?? "", /FOR UPDATE/u);
	const claimUpdate = calls.find((call) => /SET status = 'in_progress'/u.test(call.sql));
	assert.match(claimUpdate?.sql ?? "", /dispatch_started_at IS NULL/u);
	assert.match(claimUpdate?.sql ?? "", /revision = \?/u);

	const marked = await repository.markItemDispatchStarted({
		id: liveBatch.id,
		accountId: liveBatch.account_id,
		workspaceId: liveBatch.workspace_id,
		owner: "executor-1",
		expectedRevision: liveBatch.revision,
		itemId: claimed.item.id,
		itemOrdinal: claimed.item.ordinal,
		expectedItemRevision: claimed.item.revision,
		generationId: "gen_batch_request_1",
		reservationId: "gen_batch_request_1",
		nowIso: "2026-09-04T00:05:00.000Z",
	});
	assert.equal(marked?.dispatch_started_at, "2026-09-04T00:05:00.000Z");
	assert.equal(commits, 2);
	const dispatch = calls.find((call) => /SET dispatch_started_at/u.test(call.sql));
	assert.match(dispatch?.sql ?? "", /lease_owner = \? AND lease_expires_at > \?/u);
	assert.match(dispatch?.sql ?? "", /revision = revision \+ 1/u);
});
