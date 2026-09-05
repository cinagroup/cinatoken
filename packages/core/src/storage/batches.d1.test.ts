import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import type {
	D1Database,
	D1PreparedStatement,
	D1Result,
} from "@cloudflare/workers-types";
import type { BatchRow, CreateBatchParams } from "../db/batch-types";
import { createD1BatchesRepository } from "../db/d1/batches.impl";
import { createD1DatabaseClient } from "./database-client";
import type { BatchesRepository } from "./gateway-repository-interfaces";

const WORKSPACE_HASH = "a".repeat(64);
const INPUT_HASH = "b".repeat(64);
const IDEMPOTENCY_HASH = "c".repeat(64);
const ACCOUNT_ID = "personal:user-1";
const WORKSPACE_ID = "workspace-1";

class SqliteD1Statement {
	constructor(
		private readonly database: DatabaseSync,
		private readonly sql: string,
		private readonly values: SQLInputValue[] = []
	) {}

	bind(...values: SQLInputValue[]): D1PreparedStatement {
		return new SqliteD1Statement(
			this.database,
			this.sql,
			values
		) as unknown as D1PreparedStatement;
	}

	run(): D1Result {
		const result = this.database.prepare(this.sql).run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result;
	}

	execute<T = Record<string, unknown>>(): D1Result<T> {
		const statement = this.database.prepare(this.sql);
		if (/\bRETURNING\b|^\s*(?:SELECT|PRAGMA|WITH)\b/iu.test(this.sql)) {
			return {
				success: true,
				results: statement.all(...this.values) as T[],
				meta: {},
			} as D1Result<T>;
		}
		const result = statement.run(...this.values);
		return {
			success: true,
			results: [],
			meta: { changes: Number(result.changes) },
		} as unknown as D1Result<T>;
	}

	first<T>(): T | null {
		return (this.database.prepare(this.sql).get(...this.values) ?? null) as T | null;
	}

	all<T>(): D1Result<T> {
		return {
			success: true,
			results: this.database.prepare(this.sql).all(...this.values) as T[],
			meta: {},
		} as D1Result<T>;
	}
}

function createParams(
	id = "batch_12345678",
	createdAt = "2026-09-04T00:00:00.000Z"
): CreateBatchParams {
	const created = new Date(createdAt);
	return {
		id,
		accountId: ACCOUNT_ID,
		workspaceId: WORKSPACE_ID,
		userId: "user-1",
		apiKeyHash: `sha256:${"d".repeat(64)}`,
		endpoint: "/v1/chat/completions",
		modelId: "deepseek/deepseek-chat",
		routeGroup: "default",
		idempotencyKeyHash: IDEMPOTENCY_HASH,
		inputObjectKey: `v1/workspaces/${WORKSPACE_HASH}/batches/${id}/input.jsonl`,
		inputSha256: INPUT_HASH,
		inputBytes: 256,
		requestCount: 2,
		createdAt: created.toISOString(),
		expiresAt: new Date(created.getTime() + 24 * 60 * 60 * 1000).toISOString(),
		retentionExpiresAt: new Date(
			created.getTime() + 30 * 24 * 60 * 60 * 1000
		).toISOString(),
	};
}

function fixture() {
	const database = new DatabaseSync(":memory:");
	database.exec(`
		PRAGMA foreign_keys = ON;
		CREATE TABLE users (id TEXT PRIMARY KEY);
		CREATE TABLE workspaces (id TEXT PRIMARY KEY);
		INSERT INTO users VALUES ('user-1'), ('user-2');
		INSERT INTO workspaces VALUES ('workspace-1'), ('workspace-2');
	`);
	database.exec(
		readFileSync(
			new URL("../../migrations-d1/0068_batch_jobs.sql", import.meta.url),
			"utf8"
		)
	);
	const raw = {
		prepare(sql: string): D1PreparedStatement {
			return new SqliteD1Statement(database, sql) as unknown as D1PreparedStatement;
		},
		async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			database.exec("BEGIN IMMEDIATE");
			try {
				const results = statements.map((statement) => {
					if (!(statement instanceof SqliteD1Statement)) {
						throw new TypeError("unexpected D1 statement fixture");
					}
					return statement.execute<T>();
				});
				database.exec("COMMIT");
				return results;
			} catch (error) {
				database.exec("ROLLBACK");
				throw error;
			}
		},
	} as unknown as D1Database;
	return {
		database,
		repository: createD1BatchesRepository(createD1DatabaseClient(raw)),
	};
}

async function createInProgressBatch(
	repository: BatchesRepository,
	params = createParams()
): Promise<BatchRow> {
	const created = await repository.create(params);
	assert.equal(created.status, "created");
	const leased = await repository.claimLease({
		id: params.id,
		accountId: params.accountId,
		workspaceId: params.workspaceId,
		owner: "validator",
		expectedRevision: created.batch.revision,
		nowIso: "2026-09-04T00:01:00.000Z",
		leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
	});
	assert.ok(leased);
	const advanced = await repository.advanceValidation({
		id: params.id,
		accountId: params.accountId,
		workspaceId: params.workspaceId,
		owner: "validator",
		expectedRevision: leased.revision,
		expectedNextOrdinal: 0,
		expectedInputOffset: 0,
		nextInputOffset: params.inputBytes,
		items: [
			{
				id: "batch_req_execute01",
				ordinal: 0,
				customId: "request-1",
				requestStartOffset: 0,
				requestEndOffset: 128,
				requestSha256: "1".repeat(64),
			},
			{
				id: "batch_req_execute02",
				ordinal: 1,
				customId: "request-2",
				requestStartOffset: 128,
				requestEndOffset: params.inputBytes,
				requestSha256: "2".repeat(64),
			},
		],
		nowIso: "2026-09-04T00:02:00.000Z",
	});
	assert.equal(advanced.status, "advanced");
	if (advanced.status !== "advanced") throw new Error("expected validation advance");
	const completed = await repository.completeValidation({
		id: params.id,
		accountId: params.accountId,
		workspaceId: params.workspaceId,
		owner: "validator",
		expectedRevision: advanced.batch.revision,
		nowIso: "2026-09-04T00:03:00.000Z",
	});
	assert.ok(completed);
	return completed;
}

test("D1 batches repository enforces exact idempotent replay and tenant isolation", async () => {
	const { database, repository } = fixture();
	try {
		const params = createParams();
		const created = await repository.create(params);
		assert.equal(created.status, "created");

		const replay = await repository.create(params);
		assert.equal(replay.status, "idempotent");

		const conflict = await repository.create({
			...params,
			id: "batch_abcdefgh",
			inputObjectKey: `v1/workspaces/${WORKSPACE_HASH}/batches/batch_abcdefgh/input.jsonl`,
			inputSha256: "e".repeat(64),
		});
		assert.equal(conflict.status, "conflict");

		assert.equal(
			await repository.getByIdInWorkspace(
				params.id,
				"personal:user-2",
				WORKSPACE_ID
			),
			null
		);
		assert.equal(
			await repository.getByIdInWorkspace(
				params.id,
				ACCOUNT_ID,
				"workspace-2"
			),
			null
		);
	} finally {
		database.close();
	}
});

test("D1 batches repository uses newest-first keyset pagination", async () => {
	const { database, repository } = fixture();
	try {
		const older = createParams("batch_older000", "2026-09-04T00:00:00.000Z");
		await repository.create({ ...older, idempotencyKeyHash: null });
		const newer = createParams("batch_newer000", "2026-09-04T01:00:00.000Z");
		await repository.create({ ...newer, idempotencyKeyHash: null });

		const firstPage = await repository.listByWorkspace({
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			statuses: ["validating"],
			limit: 1,
		});
		assert.deepEqual(firstPage.batches.map((batch) => batch.id), [newer.id]);
		assert.equal(firstPage.hasMore, true);
		assert.ok(firstPage.nextCursor);

		const secondPage = await repository.listByWorkspace({
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			after: firstPage.nextCursor,
			limit: 1,
		});
		assert.deepEqual(secondPage.batches.map((batch) => batch.id), [older.id]);
		assert.equal(secondPage.hasMore, false);
	} finally {
		database.close();
	}
});

test("D1 batches repository claims and renews leases with revision CAS", async () => {
	const { database, repository } = fixture();
	try {
		const params = createParams();
		await repository.create(params);
		const claim = await repository.claimLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-1",
			expectedRevision: 0,
			nowIso: "2026-09-04T00:01:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
		});
		assert.equal(claim?.attempt_count, 1);
		assert.equal(claim?.revision, 1);
		assert.equal(claim?.lease_owner, "consumer-1");

		const stale = await repository.claimLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-2",
			expectedRevision: 0,
			nowIso: "2026-09-04T00:02:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:06:00.000Z",
		});
		assert.equal(stale, null);

		const wrongOwner = await repository.renewLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-2",
			expectedRevision: 1,
			nowIso: "2026-09-04T00:02:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:06:00.000Z",
		});
		assert.equal(wrongOwner, null);

		const renewed = await repository.renewLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-1",
			expectedRevision: 1,
			nowIso: "2026-09-04T00:02:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:07:00.000Z",
		});
		assert.equal(renewed?.revision, 2);
		assert.equal(renewed?.attempt_count, 1);

		assert.deepEqual(
			await repository.listDispatchCandidates(
				"2026-09-04T00:03:00.000Z",
				10
			),
			[]
		);
		assert.deepEqual(
			(
				await repository.listDispatchCandidates(
					"2026-09-04T00:08:00.000Z",
					10
				)
			).map((batch) => batch.id),
			[params.id]
		);
	} finally {
		database.close();
	}
});

test("D1 Batch validation advances item rows and byte cursor atomically", async () => {
	const { database, repository } = fixture();
	try {
		const params = createParams();
		await repository.create(params);
		const claimed = await repository.claimLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-validation",
			expectedRevision: 0,
			nowIso: "2026-09-04T00:01:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
		});
		assert.ok(claimed);
		assert.equal((await repository.getByIdForDispatch(params.id))?.id, params.id);

		const advanced = await repository.advanceValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-validation",
			expectedRevision: claimed.revision,
			expectedNextOrdinal: 0,
			expectedInputOffset: 0,
			nextInputOffset: params.inputBytes,
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
					requestEndOffset: params.inputBytes,
					requestSha256: "2".repeat(64),
				},
			],
			nowIso: "2026-09-04T00:02:00.000Z",
		});
		assert.equal(advanced.status, "advanced");
		if (advanced.status !== "advanced") throw new Error("expected validation advance");
		assert.equal(advanced.batch.validation_next_ordinal, 2);
		assert.equal(advanced.batch.validation_input_offset, params.inputBytes);
		assert.equal(
			(database.prepare("SELECT COUNT(*) AS count FROM batch_items").get() as { count: number }).count,
			2
		);
		assert.deepEqual(
			database.prepare(`SELECT ordinal, request_start_offset, request_end_offset
				FROM batch_items ORDER BY ordinal`).all().map((item) => ({
					ordinal: Number(item.ordinal),
					request_start_offset: Number(item.request_start_offset),
					request_end_offset: Number(item.request_end_offset),
				})),
			[
				{ ordinal: 0, request_start_offset: 0, request_end_offset: 128 },
				{
					ordinal: 1,
					request_start_offset: 128,
					request_end_offset: params.inputBytes,
				},
			]
		);

		const stale = await repository.advanceValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-validation",
			expectedRevision: claimed.revision,
			expectedNextOrdinal: 0,
			expectedInputOffset: 0,
			nextInputOffset: params.inputBytes,
			items: [
				{
					id: "batch_req_00000001",
					ordinal: 0,
					customId: "request-1",
					requestStartOffset: 0,
					requestEndOffset: params.inputBytes,
					requestSha256: "1".repeat(64),
				},
			],
			nowIso: "2026-09-04T00:02:30.000Z",
		});
		assert.equal(stale.status, "lease_lost");

		const completed = await repository.completeValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-validation",
			expectedRevision: claimed.revision,
			nowIso: "2026-09-04T00:03:00.000Z",
		});
		assert.equal(completed?.status, "in_progress");
		assert.equal(completed?.revision, claimed.revision + 1);
		assert.equal(completed?.lease_owner, null);
	} finally {
		database.close();
	}
});

test("D1 Batch validation rolls back a conflicting custom ID without moving its cursor", async () => {
	const { database, repository } = fixture();
	try {
		const base = createParams("batch_conflict1");
		const params = {
			...base,
			idempotencyKeyHash: null,
			inputObjectKey: `v1/workspaces/${WORKSPACE_HASH}/batches/${base.id}/input.jsonl`,
		};
		await repository.create(params);
		const claimed = await repository.claimLease({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-conflict",
			expectedRevision: 0,
			nowIso: "2026-09-04T00:01:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
		});
		assert.ok(claimed);
		const first = await repository.advanceValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-conflict",
			expectedRevision: claimed.revision,
			expectedNextOrdinal: 0,
			expectedInputOffset: 0,
			nextInputOffset: 128,
			items: [{
				id: "batch_req_conflict1",
				ordinal: 0,
				customId: "duplicate",
				requestStartOffset: 0,
				requestEndOffset: 128,
				requestSha256: "3".repeat(64),
			}],
			nowIso: "2026-09-04T00:02:00.000Z",
		});
		assert.equal(first.status, "advanced");

		const conflict = await repository.advanceValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-conflict",
			expectedRevision: claimed.revision,
			expectedNextOrdinal: 1,
			expectedInputOffset: 128,
			nextInputOffset: params.inputBytes,
			items: [{
				id: "batch_req_conflict2",
				ordinal: 1,
				customId: "duplicate",
				requestStartOffset: 128,
				requestEndOffset: params.inputBytes,
				requestSha256: "4".repeat(64),
			}],
			nowIso: "2026-09-04T00:03:00.000Z",
		});
		assert.equal(conflict.status, "conflict");
		const persisted = await repository.getByIdForDispatch(params.id);
		assert.equal(persisted?.validation_next_ordinal, 1);
		assert.equal(persisted?.validation_input_offset, 128);
		assert.equal(
			(database.prepare("SELECT COUNT(*) AS count FROM batch_items").get() as { count: number }).count,
			1
		);
		assert.equal(
			await repository.completeValidation({
				id: params.id,
				accountId: ACCOUNT_ID,
				workspaceId: WORKSPACE_ID,
				owner: "consumer-conflict",
				expectedRevision: claimed.revision,
				nowIso: "2026-09-04T00:03:30.000Z",
			}),
			null
		);
		const failed = await repository.failValidation({
			id: params.id,
			accountId: ACCOUNT_ID,
			workspaceId: WORKSPACE_ID,
			owner: "consumer-conflict",
			expectedRevision: claimed.revision,
			nowIso: "2026-09-04T00:03:45.000Z",
			errorCode: "batch_item_conflict",
		});
		assert.equal(failed?.status, "failed");
		assert.equal(failed?.last_error_code, "batch_item_conflict");
		assert.equal(failed?.lease_owner, null);
	} finally {
		database.close();
	}
});

test("D1 Batch validation rejects an oversized chunk without partial item inserts", async () => {
	const { database, repository } = fixture();
	try {
		const created = await repository.create(createParams());
		assert.equal(created.status, "created");
		const leased = await repository.claimLease({
			id: created.batch.id,
			accountId: created.batch.account_id,
			workspaceId: created.batch.workspace_id,
			owner: "consumer-1",
			expectedRevision: created.batch.revision,
			nowIso: "2026-09-04T00:01:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:05:00.000Z",
		});
		assert.ok(leased);
		const result = await repository.advanceValidation({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "consumer-1",
			expectedRevision: leased.revision,
			expectedNextOrdinal: 0,
			expectedInputOffset: 0,
			nextInputOffset: 256,
			items: [0, 1, 2].map((ordinal) => ({
				id: `batch_req_0000000${ordinal}`,
				ordinal,
				customId: `request-${ordinal}`,
				requestStartOffset: ordinal === 0 ? 0 : ordinal === 1 ? 85 : 170,
				requestEndOffset: ordinal === 0 ? 85 : ordinal === 1 ? 170 : 256,
				requestSha256: String(ordinal + 1).repeat(64),
			})),
			nowIso: "2026-09-04T00:02:00.000Z",
		});
		assert.equal(result.status, "lease_lost");
		assert.equal(
			database.prepare("SELECT COUNT(*) AS count FROM batch_items").get()?.count,
			0
		);
		const unchanged = await repository.getByIdInWorkspace(
			leased.id,
			leased.account_id,
			leased.workspace_id
		);
		assert.equal(unchanged?.validation_next_ordinal, 0);
		assert.equal(unchanged?.validation_input_offset, 0);
	} finally {
		database.close();
	}
});

test("D1 Batch item claims recover only a pre-dispatch item after lease expiry", async () => {
	const { database, repository } = fixture();
	try {
		const inProgress = await createInProgressBatch(repository);
		const firstBatchLease = await repository.claimLease({
			id: inProgress.id,
			accountId: inProgress.account_id,
			workspaceId: inProgress.workspace_id,
			owner: "executor-1",
			expectedRevision: inProgress.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.ok(firstBatchLease);
		const firstClaim = await repository.claimNextItem({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-1",
			expectedRevision: firstBatchLease.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.equal(firstClaim.status, "claimed");
		if (firstClaim.status !== "claimed") throw new Error("expected item claim");
		assert.equal(firstClaim.item.ordinal, 0);
		assert.equal(firstClaim.item.attempt_count, 1);
		assert.equal(firstClaim.item.dispatch_started_at, null);

		const takeover = await repository.claimLease({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-2",
			expectedRevision: firstBatchLease.revision,
			nowIso: "2026-09-04T00:09:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:13:00.000Z",
		});
		assert.ok(takeover);
		const recovered = await repository.claimNextItem({
			id: takeover.id,
			accountId: takeover.account_id,
			workspaceId: takeover.workspace_id,
			owner: "executor-2",
			expectedRevision: takeover.revision,
			nowIso: "2026-09-04T00:09:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:13:00.000Z",
		});
		assert.equal(recovered.status, "claimed");
		if (recovered.status !== "claimed") throw new Error("expected recovered item");
		assert.equal(recovered.item.ordinal, 0);
		assert.equal(recovered.item.attempt_count, 2);
		assert.equal(recovered.item.started_at, firstClaim.item.started_at);
		assert.equal(
			(database.prepare("SELECT status FROM batch_items WHERE ordinal = 1").get() as {
				status: string;
			}).status,
			"pending"
		);
	} finally {
		database.close();
	}
});

test("D1 Batch item dispatch marker creates a permanent no-replay boundary", async () => {
	const { database, repository } = fixture();
	try {
		const inProgress = await createInProgressBatch(repository);
		const firstBatchLease = await repository.claimLease({
			id: inProgress.id,
			accountId: inProgress.account_id,
			workspaceId: inProgress.workspace_id,
			owner: "executor-1",
			expectedRevision: inProgress.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.ok(firstBatchLease);
		const claim = await repository.claimNextItem({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-1",
			expectedRevision: firstBatchLease.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.equal(claim.status, "claimed");
		if (claim.status !== "claimed") throw new Error("expected item claim");
		const released = await repository.releaseItemBeforeDispatch({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-1",
			expectedRevision: firstBatchLease.revision,
			itemId: claim.item.id,
			itemOrdinal: claim.item.ordinal,
			expectedItemRevision: claim.item.revision,
			nowIso: "2026-09-04T00:04:30.000Z",
		});
		assert.equal(released?.status, "pending");
		assert.equal(released?.lease_owner, null);
		const reclaimed = await repository.claimNextItem({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-1",
			expectedRevision: firstBatchLease.revision,
			nowIso: "2026-09-04T00:04:40.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.equal(reclaimed.status, "claimed");
		if (reclaimed.status !== "claimed") throw new Error("expected reclaimed item");
		assert.equal(reclaimed.item.attempt_count, 2);
		const marked = await repository.markItemDispatchStarted({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-1",
			expectedRevision: firstBatchLease.revision,
			itemId: reclaimed.item.id,
			itemOrdinal: reclaimed.item.ordinal,
			expectedItemRevision: reclaimed.item.revision,
			generationId: "gen_batch_request_1",
			reservationId: "gen_batch_request_1",
			nowIso: "2026-09-04T00:05:00.000Z",
		});
		assert.ok(marked);
		assert.equal(marked.dispatch_started_at, "2026-09-04T00:05:00.000Z");
		assert.equal(marked.generation_id, "gen_batch_request_1");
		assert.equal(
			await repository.releaseItemBeforeDispatch({
				id: firstBatchLease.id,
				accountId: firstBatchLease.account_id,
				workspaceId: firstBatchLease.workspace_id,
				owner: "executor-1",
				expectedRevision: firstBatchLease.revision,
				itemId: marked.id,
				itemOrdinal: marked.ordinal,
				expectedItemRevision: marked.revision,
				nowIso: "2026-09-04T00:05:15.000Z",
			}),
			null
		);
		assert.equal(
			await repository.markItemDispatchStarted({
				id: firstBatchLease.id,
				accountId: firstBatchLease.account_id,
				workspaceId: firstBatchLease.workspace_id,
				owner: "executor-1",
				expectedRevision: firstBatchLease.revision,
				itemId: reclaimed.item.id,
				itemOrdinal: reclaimed.item.ordinal,
				expectedItemRevision: reclaimed.item.revision,
				generationId: "gen_batch_request_1",
				reservationId: "gen_batch_request_1",
				nowIso: "2026-09-04T00:05:30.000Z",
			}),
			null
		);

		const takeover = await repository.claimLease({
			id: firstBatchLease.id,
			accountId: firstBatchLease.account_id,
			workspaceId: firstBatchLease.workspace_id,
			owner: "executor-2",
			expectedRevision: firstBatchLease.revision,
			nowIso: "2026-09-04T00:09:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:13:00.000Z",
		});
		assert.ok(takeover);
		const recovered = await repository.claimNextItem({
			id: takeover.id,
			accountId: takeover.account_id,
			workspaceId: takeover.workspace_id,
			owner: "executor-2",
			expectedRevision: takeover.revision,
			nowIso: "2026-09-04T00:09:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:13:00.000Z",
		});
		assert.equal(recovered.status, "outcome_unknown");
		if (recovered.status !== "outcome_unknown") {
			throw new Error("expected unknown outcome fence");
		}
		assert.equal(recovered.item.id, reclaimed.item.id);
		assert.equal(recovered.item.attempt_count, 2);
		assert.equal(
			(database.prepare("SELECT status FROM batch_items WHERE ordinal = 1").get() as {
				status: string;
			}).status,
			"pending"
		);
	} finally {
		database.close();
	}
});

test("D1 Batch execution preflight failure atomically terminalizes every undispatched item", async () => {
	const { database, repository } = fixture();
	try {
		const inProgress = await createInProgressBatch(repository);
		const leased = await repository.claimLease({
			id: inProgress.id,
			accountId: inProgress.account_id,
			workspaceId: inProgress.workspace_id,
			owner: "executor-preflight",
			expectedRevision: inProgress.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.ok(leased);
		const claimed = await repository.claimNextItem({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "executor-preflight",
			expectedRevision: leased.revision,
			nowIso: "2026-09-04T00:04:10.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.equal(claimed.status, "claimed");

		const failed = await repository.failExecutionPreflight({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "executor-preflight",
			expectedRevision: leased.revision,
			nowIso: "2026-09-04T00:04:30.000Z",
			errorCode: "batch_key_inactive",
		});
		assert.equal(failed.status, "failed");
		if (failed.status !== "failed") throw new Error("expected failed Batch");
		assert.equal(failed.batch.status, "failed");
		assert.equal(failed.batch.failed_count, 2);
		assert.equal(failed.batch.last_error_code, "batch_key_inactive");
		assert.equal(failed.batch.finalized_at, "2026-09-04T00:04:30.000Z");
		assert.equal(failed.batch.lease_owner, null);
		assert.deepEqual(
			database
				.prepare(
					`SELECT ordinal, status, error_code, completed_at, lease_owner
					 FROM batch_items ORDER BY ordinal`
				)
				.all().map((row) => ({ ...row })),
			[
				{
					ordinal: 0,
					status: "failed",
					error_code: "batch_key_inactive",
					completed_at: "2026-09-04T00:04:30.000Z",
					lease_owner: null,
				},
				{
					ordinal: 1,
					status: "failed",
					error_code: "batch_key_inactive",
					completed_at: "2026-09-04T00:04:30.000Z",
					lease_owner: null,
				},
			]
		);
		assert.equal(
			(
				await repository.failExecutionPreflight({
					id: leased.id,
					accountId: leased.account_id,
					workspaceId: leased.workspace_id,
					owner: "executor-preflight",
					expectedRevision: leased.revision,
					nowIso: "2026-09-04T00:04:40.000Z",
					errorCode: "batch_key_inactive",
				})
			).status,
			"batch_lease_lost"
		);
	} finally {
		database.close();
	}
});

test("D1 Batch execution preflight failure yields to an existing dispatch fence", async () => {
	const { database, repository } = fixture();
	try {
		const inProgress = await createInProgressBatch(repository);
		const leased = await repository.claimLease({
			id: inProgress.id,
			accountId: inProgress.account_id,
			workspaceId: inProgress.workspace_id,
			owner: "executor-preflight",
			expectedRevision: inProgress.revision,
			nowIso: "2026-09-04T00:04:00.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.ok(leased);
		const claimed = await repository.claimNextItem({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "executor-preflight",
			expectedRevision: leased.revision,
			nowIso: "2026-09-04T00:04:10.000Z",
			leaseExpiresAtIso: "2026-09-04T00:08:00.000Z",
		});
		assert.equal(claimed.status, "claimed");
		if (claimed.status !== "claimed") throw new Error("expected item claim");
		const marked = await repository.markItemDispatchStarted({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "executor-preflight",
			expectedRevision: leased.revision,
			itemId: claimed.item.id,
			itemOrdinal: claimed.item.ordinal,
			expectedItemRevision: claimed.item.revision,
			generationId: "gen_preflight_fence",
			reservationId: "gen_preflight_fence",
			nowIso: "2026-09-04T00:04:20.000Z",
		});
		assert.ok(marked);

		const refused = await repository.failExecutionPreflight({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner: "executor-preflight",
			expectedRevision: leased.revision,
			nowIso: "2026-09-04T00:04:30.000Z",
			errorCode: "batch_authorization_snapshot_mismatch",
		});
		assert.equal(refused.status, "outcome_unknown");
		if (refused.status !== "outcome_unknown") {
			throw new Error("expected unknown outcome fence");
		}
		assert.equal(refused.item.id, claimed.item.id);
		assert.deepEqual(
			database
				.prepare("SELECT ordinal, status, error_code FROM batch_items ORDER BY ordinal")
				.all().map((row) => ({ ...row })),
			[
				{ ordinal: 0, status: "in_progress", error_code: null },
				{ ordinal: 1, status: "pending", error_code: null },
			]
		);
		const current = await repository.getByIdForDispatch(leased.id);
		assert.equal(current?.status, "in_progress");
		assert.equal(current?.last_error_code, null);
	} finally {
		database.close();
	}
});

test("D1 batch item ledger rejects duplicate custom IDs and stores no bodies", () => {
	const { database } = fixture();
	try {
		const params = createParams();
		const columns = database
			.prepare("PRAGMA table_info(batch_items)")
			.all()
			.map((row) => (row as { name: string }).name);
		assert.equal(columns.includes("request_body"), false);
		assert.equal(columns.includes("response_body"), false);

		database.prepare(`
			INSERT INTO batches (
				id, account_id, workspace_id, user_id, api_key_hash, endpoint,
				model_id, route_group, idempotency_key_hash, input_object_key,
				input_sha256, input_bytes, request_count, created_at, expires_at,
				retention_expires_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`).run(
			params.id,
			params.accountId,
			params.workspaceId,
			params.userId,
			params.apiKeyHash,
			params.endpoint,
			params.modelId,
			params.routeGroup,
			params.idempotencyKeyHash,
			params.inputObjectKey,
			params.inputSha256,
			params.inputBytes,
			params.requestCount,
			params.createdAt,
			params.expiresAt,
			params.retentionExpiresAt,
			params.createdAt
		);
		const insert = database.prepare(`
			INSERT INTO batch_items (
				id, batch_id, ordinal, custom_id, request_start_offset,
				request_end_offset, request_sha256, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		insert.run(
			"batch_req_12345678",
			params.id,
			0,
			"request-1",
			0,
			128,
			"f".repeat(64),
			params.createdAt,
			params.createdAt
		);
		assert.throws(
			() =>
				insert.run(
					"batch_req_abcdefgh",
					params.id,
					1,
					"request-1",
					128,
					256,
					"e".repeat(64),
					params.createdAt,
					params.createdAt
				),
			/UNIQUE constraint failed/u
		);
	} finally {
		database.close();
	}
});
