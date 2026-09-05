import type { RowDataPacket } from "mysql2/promise";
import type { MySqlDatabaseClient } from "../../storage/database-client";
import type { BatchesRepository } from "../../storage/gateway-repository-interfaces";
import {
	assertAdvanceBatchValidationParams,
	assertBatchId,
	assertBatchLeaseParams,
	assertBatchTenant,
	assertClaimNextBatchItemParams,
	assertCompleteBatchValidationParams,
	assertCreateBatchParams,
	assertFailBatchExecutionPreflightParams,
	assertFailBatchValidationParams,
	assertListBatchesParams,
	assertMarkBatchItemDispatchStartedParams,
	assertReleaseBatchItemBeforeDispatchParams,
	batchPage,
	normalizeBatchListLimit,
	normalizeBatchListStatuses,
	type CreateBatchParams,
} from "../batch-types";
import {
	assertBatchInstant,
	canAdvanceBatchValidation,
	canCompleteBatchValidation,
	classifyBatchCreateReplay,
	normalizeBatchItemRow,
	normalizeBatchInternalLimit,
	normalizeBatchRow,
	type BatchDatabaseRow,
	type BatchItemDatabaseRow,
	ownsLiveBatchExecutionLease,
	ownsLiveBatchValidationLease,
} from "../batch-repository-utils";
import {
	asMySqlPool,
	fromMySqlDateTime,
	mysqlExecute,
	mysqlQueryRows,
	toMySqlDateTime,
	type MySqlConnectionLike,
	type MySqlPoolLike,
} from "./mysql2-compat";

type MySqlBatchRow = BatchDatabaseRow & RowDataPacket;
type MySqlBatchItemRow = BatchItemDatabaseRow & RowDataPacket;

const SELECT_COLUMNS = `id, account_id, workspace_id, user_id, api_key_hash,
	endpoint, model_id, route_group, status, completion_window,
	idempotency_key_hash, input_object_key, input_sha256,
	input_bytes, result_object_key, result_sha256, request_count,
	validation_next_ordinal, validation_input_offset, completed_count,
	failed_count, cancelled_count, prompt_tokens, completion_tokens,
	total_tokens, charged_cost_micros, byok_request_count, unknown_cost_count,
	DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
	DATE_FORMAT(in_progress_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS in_progress_at,
	DATE_FORMAT(finalizing_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS finalizing_at,
	DATE_FORMAT(finalized_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS finalized_at,
	DATE_FORMAT(expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS expires_at,
	DATE_FORMAT(retention_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS retention_expires_at,
	lease_owner,
	DATE_FORMAT(lease_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lease_expires_at,
	attempt_count, revision, last_error_code,
	DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at`;

const ITEM_SELECT_COLUMNS = `id, batch_id, ordinal, custom_id, status,
	attempt_count,
	DATE_FORMAT(started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS started_at,
	DATE_FORMAT(dispatch_started_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS dispatch_started_at,
	DATE_FORMAT(completed_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS completed_at,
	generation_id, reservation_id, lease_owner,
	DATE_FORMAT(lease_expires_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS lease_expires_at,
	request_start_offset, request_end_offset, request_sha256,
	result_object_key, result_sha256, error_code, error_summary, revision,
	DATE_FORMAT(created_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS created_at,
	DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') AS updated_at`;

const CREATE_SQL = `INSERT INTO batches (
	id, account_id, workspace_id, user_id, api_key_hash, endpoint, model_id,
	route_group, status, completion_window, idempotency_key_hash,
	input_object_key, input_sha256, input_bytes, request_count, created_at, expires_at,
	retention_expires_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validating', '24h', ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function createValues(params: CreateBatchParams): unknown[] {
	const createdAt = toMySqlDateTime(params.createdAt);
	return [
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
		createdAt,
		toMySqlDateTime(params.expiresAt),
		toMySqlDateTime(params.retentionExpiresAt),
		createdAt,
	];
}

function errorNumber(error: unknown): number | null {
	return typeof error === "object" &&
		error !== null &&
		"errno" in error &&
		typeof error.errno === "number"
		? error.errno
		: null;
}

async function withDeadlockRetry<T>(operation: () => Promise<T>): Promise<T> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			return await operation();
		} catch (error) {
			if (
				(errorNumber(error) !== 1205 && errorNumber(error) !== 1213) ||
				attempt >= 2
			) {
				throw error;
			}
			await new Promise<void>((resolve) =>
				setTimeout(resolve, 5 * (attempt + 1))
			);
		}
	}
}

async function inTransaction<T>(
	pool: MySqlPoolLike,
	operation: (connection: MySqlConnectionLike) => Promise<T>
): Promise<T> {
	return await withDeadlockRetry(async () => {
		const connection = await pool.getConnection();
		try {
			await connection.query(`SET time_zone = '+00:00'`);
			await connection.beginTransaction();
			const result = await operation(connection);
			await connection.commit();
			return result;
		} catch (error) {
			await connection.rollback().catch(() => undefined);
			throw error;
		} finally {
			connection.release();
		}
	});
}

function normalized(row: MySqlBatchRow): BatchDatabaseRow {
	for (const column of [
		"created_at",
		"in_progress_at",
		"finalizing_at",
		"finalized_at",
		"expires_at",
		"retention_expires_at",
		"lease_expires_at",
		"updated_at",
	] as const) {
		const value = row[column];
		if (value !== null) row[column] = fromMySqlDateTime(value);
	}
	return row;
}

function normalizedItem(row: MySqlBatchItemRow): BatchItemDatabaseRow {
	for (const column of [
		"started_at",
		"dispatch_started_at",
		"completed_at",
		"lease_expires_at",
		"created_at",
		"updated_at",
	] as const) {
		const value = row[column];
		if (value !== null) row[column] = fromMySqlDateTime(value);
	}
	return row;
}

async function getById(
	connection: MySqlPoolLike | MySqlConnectionLike,
	id: string,
	accountId: string,
	workspaceId: string,
	forUpdate = false
): Promise<BatchDatabaseRow | null> {
	const rows = await mysqlQueryRows<MySqlBatchRow>(
		connection,
		`SELECT ${SELECT_COLUMNS} FROM batches
		 WHERE id = ? AND account_id = ? AND workspace_key = SHA2(?, 256)
		   AND workspace_id = ?${forUpdate ? " FOR UPDATE" : ""}`,
		[id, accountId, workspaceId, workspaceId]
	);
	return rows[0] ? normalized(rows[0]) : null;
}

async function getByOpaqueId(
	connection: MySqlPoolLike | MySqlConnectionLike,
	id: string,
	forUpdate = false
): Promise<BatchDatabaseRow | null> {
	const rows = await mysqlQueryRows<MySqlBatchRow>(
		connection,
		`SELECT ${SELECT_COLUMNS} FROM batches
		 WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`,
		[id]
	);
	return rows[0] ? normalized(rows[0]) : null;
}

async function getNextOpenItem(
	connection: MySqlPoolLike | MySqlConnectionLike,
	batchId: string,
	forUpdate = false
): Promise<BatchItemDatabaseRow | null> {
	const rows = await mysqlQueryRows<MySqlBatchItemRow>(
		connection,
		`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
		 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
		 ORDER BY ordinal LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
		[batchId]
	);
	return rows[0] ? normalizedItem(rows[0]) : null;
}

async function getFirstOpenDispatchedItem(
	connection: MySqlPoolLike | MySqlConnectionLike,
	batchId: string,
	forUpdate = false
): Promise<BatchItemDatabaseRow | null> {
	const rows = await mysqlQueryRows<MySqlBatchItemRow>(
		connection,
		`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
		 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
		   AND dispatch_started_at IS NOT NULL
		 ORDER BY ordinal LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
		[batchId]
	);
	return rows[0] ? normalizedItem(rows[0]) : null;
}

async function getItemByIdentity(
	connection: MySqlPoolLike | MySqlConnectionLike,
	batchId: string,
	itemId: string,
	ordinal: number,
	forUpdate = false
): Promise<BatchItemDatabaseRow | null> {
	const rows = await mysqlQueryRows<MySqlBatchItemRow>(
		connection,
		`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
		 WHERE batch_id = ? AND id = ? AND ordinal = ?${forUpdate ? " FOR UPDATE" : ""}`,
		[batchId, itemId, ordinal]
	);
	return rows[0] ? normalizedItem(rows[0]) : null;
}

async function findReplay(
	connection: MySqlConnectionLike,
	params: CreateBatchParams
): Promise<BatchDatabaseRow | null> {
	if (params.idempotencyKeyHash !== null) {
		const rows = await mysqlQueryRows<MySqlBatchRow>(
			connection,
			`SELECT ${SELECT_COLUMNS} FROM batches
			 WHERE account_id = ? AND workspace_key = SHA2(?, 256)
			   AND workspace_id = ? AND api_key_hash = ?
			   AND idempotency_key_hash = ? FOR UPDATE`,
			[
				params.accountId,
				params.workspaceId,
				params.workspaceId,
				params.apiKeyHash,
				params.idempotencyKeyHash,
			]
		);
		if (rows[0]) return normalized(rows[0]);
	}
	return await getById(
		connection,
		params.id,
		params.accountId,
		params.workspaceId,
		true
	);
}

export function createMySqlBatchesRepository(
	db: MySqlDatabaseClient
): BatchesRepository {
	const pool = asMySqlPool(db.raw);

	return {
		async create(params) {
			assertCreateBatchParams(params);
			return await inTransaction(pool, async (connection) => {
				try {
					await mysqlExecute(connection, CREATE_SQL, createValues(params));
					const created = await getById(
						connection,
						params.id,
						params.accountId,
						params.workspaceId,
						true
					);
					if (!created) throw new Error("created batch could not be read back");
					return {
						status: "created" as const,
						batch: normalizeBatchRow(created),
					};
				} catch (error) {
					if (errorNumber(error) !== 1062) throw error;
					return classifyBatchCreateReplay(
						await findReplay(connection, params),
						params
					);
				}
			});
		},

		async getByIdInWorkspace(id, accountId, workspaceId) {
			assertBatchId(id);
			assertBatchTenant(accountId, workspaceId);
			const row = await getById(pool, id, accountId, workspaceId);
			return row ? normalizeBatchRow(row) : null;
		},

		async getByIdForDispatch(id) {
			assertBatchId(id);
			const row = await getByOpaqueId(pool, id);
			return row ? normalizeBatchRow(row) : null;
		},

		async listByWorkspace(params) {
			assertListBatchesParams(params);
			const conditions = [
				"account_id = ?",
				"workspace_key = SHA2(?, 256)",
				"workspace_id = ?",
			];
			const values: unknown[] = [
				params.accountId,
				params.workspaceId,
				params.workspaceId,
			];
			const statuses = normalizeBatchListStatuses(params.statuses);
			if (statuses.length > 0) {
				conditions.push(
					`status IN (${statuses.map(() => "?").join(", ")})`
				);
				values.push(...statuses);
			}
			if (params.createdAfter) {
				conditions.push("created_at > ?");
				values.push(toMySqlDateTime(params.createdAfter));
			}
			if (params.createdBefore) {
				conditions.push("created_at < ?");
				values.push(toMySqlDateTime(params.createdBefore));
			}
			if (params.after) {
				const cursorTime = toMySqlDateTime(params.after.createdAt);
				conditions.push(
					"(created_at < ? OR (created_at = ? AND id < ?))"
				);
				values.push(cursorTime, cursorTime, params.after.id);
			}
			const limit = normalizeBatchListLimit(params.limit);
			values.push(limit + 1);
			const rows = await mysqlQueryRows<MySqlBatchRow>(
				pool,
				`SELECT ${SELECT_COLUMNS} FROM batches
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY created_at DESC, id DESC LIMIT ?`,
				values
			);
			return batchPage(
				rows.map((row) => normalizeBatchRow(normalized(row))),
				limit
			);
		},

		async listDispatchCandidates(nowIso, limit) {
			assertBatchInstant(nowIso, "batch dispatch scan time");
			const rows = await mysqlQueryRows<MySqlBatchRow>(
				pool,
				`SELECT ${SELECT_COLUMNS} FROM batches
				 WHERE status IN ('validating', 'in_progress')
				   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
				 ORDER BY created_at, id LIMIT ?`,
				[toMySqlDateTime(nowIso), normalizeBatchInternalLimit(limit)]
			);
			return rows.map((row) => normalizeBatchRow(normalized(row)));
		},

		async claimLease(params) {
			assertBatchLeaseParams(params);
			return await inTransaction(pool, async (connection) => {
				const now = toMySqlDateTime(params.nowIso);
				const rows = await mysqlQueryRows<MySqlBatchRow>(
					connection,
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = ? AND account_id = ? AND workspace_key = SHA2(?, 256)
					   AND workspace_id = ? AND revision = ?
					   AND status IN ('validating', 'in_progress')
					   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
					 FOR UPDATE`,
					[
						params.id,
						params.accountId,
						params.workspaceId,
						params.workspaceId,
						params.expectedRevision,
						now,
					]
				);
				if (!rows[0]) return null;
				const updated = await mysqlExecute(
					connection,
					`UPDATE batches
					 SET lease_owner = ?, lease_expires_at = ?,
					     attempt_count = attempt_count + 1,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND revision = ?`,
					[
						params.owner,
						toMySqlDateTime(params.leaseExpiresAtIso),
						now,
						params.id,
						params.expectedRevision,
					]
				);
				if (updated.affectedRows !== 1) {
					throw new Error("batch lease claim raced after row lock");
				}
				const claimed = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				return claimed ? normalizeBatchRow(claimed) : null;
			});
		},

		async renewLease(params) {
			assertBatchLeaseParams(params);
			return await inTransaction(pool, async (connection) => {
				const now = toMySqlDateTime(params.nowIso);
				const rows = await mysqlQueryRows<MySqlBatchRow>(
					connection,
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = ? AND account_id = ? AND workspace_key = SHA2(?, 256)
					   AND workspace_id = ? AND revision = ? AND lease_owner = ?
					   AND lease_expires_at > ?
					   AND status IN ('validating', 'in_progress')
					 FOR UPDATE`,
					[
						params.id,
						params.accountId,
						params.workspaceId,
						params.workspaceId,
						params.expectedRevision,
						params.owner,
						now,
					]
				);
				if (!rows[0]) return null;
				const updated = await mysqlExecute(
					connection,
					`UPDATE batches
					 SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
					 WHERE id = ? AND revision = ? AND lease_owner = ?`,
					[
						toMySqlDateTime(params.leaseExpiresAtIso),
						now,
						params.id,
						params.expectedRevision,
						params.owner,
					]
				);
				if (updated.affectedRows !== 1) {
					throw new Error("batch lease renewal raced after row lock");
				}
				const renewed = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				return renewed ? normalizeBatchRow(renewed) : null;
			});
		},

		async advanceValidation(params) {
			assertAdvanceBatchValidationParams(params);
			try {
				return await inTransaction(pool, async (connection) => {
					const lockedRow = await getById(
						connection,
						params.id,
						params.accountId,
						params.workspaceId,
						true
					);
					const locked = lockedRow ? normalizeBatchRow(lockedRow) : null;
					if (!locked || !canAdvanceBatchValidation(locked, params)) {
						return { status: "lease_lost" as const };
					}

					const values: unknown[] = [];
					const tuples = params.items.map((item) => {
						values.push(
							item.id,
							params.id,
							item.ordinal,
							item.customId,
							item.requestStartOffset,
							item.requestEndOffset,
							item.requestSha256,
							toMySqlDateTime(params.nowIso),
							toMySqlDateTime(params.nowIso)
						);
						return "(?, ?, ?, ?, ?, ?, ?, ?, ?)";
					});
					await mysqlExecute(
						connection,
						`INSERT INTO batch_items (
							id, batch_id, ordinal, custom_id,
							request_start_offset, request_end_offset, request_sha256,
							created_at, updated_at
						) VALUES ${tuples.join(", ")}`,
						values
					);

					const updated = await mysqlExecute(
						connection,
						`UPDATE batches
						 SET validation_next_ordinal = ?, validation_input_offset = ?,
						     updated_at = ?
						 WHERE id = ? AND account_id = ? AND workspace_key = SHA2(?, 256)
						   AND workspace_id = ? AND revision = ? AND status = 'validating'
						   AND lease_owner = ? AND lease_expires_at > ?
						   AND validation_next_ordinal = ? AND validation_input_offset = ?
						   AND ? <= request_count AND ? <= input_bytes`,
						[
							params.expectedNextOrdinal + params.items.length,
							params.nextInputOffset,
							toMySqlDateTime(params.nowIso),
							params.id,
							params.accountId,
							params.workspaceId,
							params.workspaceId,
							params.expectedRevision,
							params.owner,
							toMySqlDateTime(params.nowIso),
							params.expectedNextOrdinal,
							params.expectedInputOffset,
							params.expectedNextOrdinal + params.items.length,
							params.nextInputOffset,
						]
					);
					if (updated.affectedRows !== 1) {
						throw new Error("batch validation checkpoint raced after row lock");
					}
					const advanced = await getById(
						connection,
						params.id,
						params.accountId,
						params.workspaceId,
						true
					);
					if (!advanced) throw new Error("advanced batch could not be read back");
					return {
						status: "advanced" as const,
						batch: normalizeBatchRow(advanced),
					};
				});
			} catch (error) {
				if (errorNumber(error) === 1062) return { status: "conflict" };
				throw error;
			}
		},

		async completeValidation(params) {
			assertCompleteBatchValidationParams(params);
			return await inTransaction(pool, async (connection) => {
				const lockedRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const locked = lockedRow ? normalizeBatchRow(lockedRow) : null;
				if (!locked || !canCompleteBatchValidation(locked, params)) return null;
				const now = toMySqlDateTime(params.nowIso);
				const updated = await mysqlExecute(
					connection,
					`UPDATE batches
					 SET status = 'in_progress', in_progress_at = COALESCE(in_progress_at, ?),
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND revision = ? AND lease_owner = ?
					   AND status = 'validating'
					   AND validation_next_ordinal = request_count
					   AND validation_input_offset = input_bytes`,
					[
						now,
						now,
						params.id,
						params.expectedRevision,
						params.owner,
					]
				);
				if (updated.affectedRows !== 1) {
					throw new Error("batch validation completion raced after row lock");
				}
				const completed = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				return completed ? normalizeBatchRow(completed) : null;
			});
		},

		async failValidation(params) {
			assertFailBatchValidationParams(params);
			return await inTransaction(pool, async (connection) => {
				const lockedRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const locked = lockedRow ? normalizeBatchRow(lockedRow) : null;
				if (!locked || !ownsLiveBatchValidationLease(locked, params)) return null;
				const now = toMySqlDateTime(params.nowIso);
				const updated = await mysqlExecute(
					connection,
					`UPDATE batches
					 SET status = 'failed', finalized_at = ?, last_error_code = ?,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND revision = ? AND lease_owner = ?
					   AND status = 'validating' AND lease_expires_at > ?`,
					[
						now,
						params.errorCode,
						now,
						params.id,
						params.expectedRevision,
						params.owner,
						now,
					]
				);
				if (updated.affectedRows !== 1) {
					throw new Error("batch validation failure transition raced after row lock");
				}
				const failed = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				return failed ? normalizeBatchRow(failed) : null;
			});
		},

		async claimNextItem(params) {
			assertClaimNextBatchItemParams(params);
			return await inTransaction(pool, async (connection) => {
				const batchRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const currentBatch = batchRow ? normalizeBatchRow(batchRow) : null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return { status: "batch_lease_lost" as const };
				}

				const itemRow = await getNextOpenItem(connection, params.id, true);
				if (!itemRow) return { status: "empty" as const };
				const item = normalizeBatchItemRow(itemRow);
				if (item.dispatch_started_at !== null) {
					return { status: "outcome_unknown" as const, item };
				}
				if (
					item.status === "in_progress" &&
					item.lease_owner !== params.owner &&
					item.lease_expires_at !== null &&
					Date.parse(item.lease_expires_at) > Date.parse(params.nowIso)
				) {
					return { status: "item_lease_contended" as const };
				}

				const now = toMySqlDateTime(params.nowIso);
				const updated = await mysqlExecute(
					connection,
					`UPDATE batch_items
					 SET status = 'in_progress', lease_owner = ?, lease_expires_at = ?,
					     attempt_count = attempt_count + CASE
					       WHEN status = 'pending' OR lease_owner IS NULL OR lease_expires_at <= ?
					       THEN 1 ELSE 0 END,
					     started_at = COALESCE(started_at, ?),
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND ordinal = ? AND revision = ?
					   AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NULL
					   AND (status = 'pending' OR lease_owner = ?
					     OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
					[
						params.owner,
						toMySqlDateTime(params.leaseExpiresAtIso),
						now,
						now,
						now,
						item.id,
						params.id,
						item.ordinal,
						item.revision,
						params.owner,
						now,
					]
				);
				if (updated.affectedRows !== 1) {
					return { status: "item_lease_contended" as const };
				}
				const claimed = await getItemByIdentity(
					connection,
					params.id,
					item.id,
					item.ordinal,
					true
				);
				if (!claimed) throw new Error("claimed batch item could not be read back");
				return {
					status: "claimed" as const,
					item: normalizeBatchItemRow(claimed),
				};
			});
		},

		async markItemDispatchStarted(params) {
			assertMarkBatchItemDispatchStartedParams(params);
			return await inTransaction(pool, async (connection) => {
				const batchRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const currentBatch = batchRow ? normalizeBatchRow(batchRow) : null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return null;
				}
				const itemRow = await getItemByIdentity(
					connection,
					params.id,
					params.itemId,
					params.itemOrdinal,
					true
				);
				const item = itemRow ? normalizeBatchItemRow(itemRow) : null;
				if (
					!item ||
					item.revision !== params.expectedItemRevision ||
					item.status !== "in_progress" ||
					item.dispatch_started_at !== null ||
					item.lease_owner !== params.owner ||
					item.lease_expires_at === null ||
					Date.parse(item.lease_expires_at) <= Date.parse(params.nowIso)
				) {
					return null;
				}

				const now = toMySqlDateTime(params.nowIso);
				const updated = await mysqlExecute(
					connection,
					`UPDATE batch_items
					 SET dispatch_started_at = ?, generation_id = ?, reservation_id = ?,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND ordinal = ? AND revision = ?
					   AND status = 'in_progress' AND dispatch_started_at IS NULL
					   AND lease_owner = ? AND lease_expires_at > ?`,
					[
						now,
						params.generationId,
						params.reservationId,
						now,
						params.itemId,
						params.id,
						params.itemOrdinal,
						params.expectedItemRevision,
						params.owner,
						now,
					]
				);
				if (updated.affectedRows !== 1) return null;
				const marked = await getItemByIdentity(
					connection,
					params.id,
					params.itemId,
					params.itemOrdinal,
					true
				);
				return marked ? normalizeBatchItemRow(marked) : null;
			});
		},

		async releaseItemBeforeDispatch(params) {
			assertReleaseBatchItemBeforeDispatchParams(params);
			return await inTransaction(pool, async (connection) => {
				const batchRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const currentBatch = batchRow ? normalizeBatchRow(batchRow) : null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return null;
				}
				const itemRow = await getItemByIdentity(
					connection,
					params.id,
					params.itemId,
					params.itemOrdinal,
					true
				);
				const item = itemRow ? normalizeBatchItemRow(itemRow) : null;
				if (
					!item ||
					item.revision !== params.expectedItemRevision ||
					item.status !== "in_progress" ||
					item.dispatch_started_at !== null ||
					item.lease_owner !== params.owner ||
					item.lease_expires_at === null ||
					Date.parse(item.lease_expires_at) <= Date.parse(params.nowIso)
				) {
					return null;
				}

				const now = toMySqlDateTime(params.nowIso);
				const updated = await mysqlExecute(
					connection,
					`UPDATE batch_items
					 SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND ordinal = ? AND revision = ?
					   AND status = 'in_progress' AND dispatch_started_at IS NULL
					   AND lease_owner = ? AND lease_expires_at > ?`,
					[
						now,
						params.itemId,
						params.id,
						params.itemOrdinal,
						params.expectedItemRevision,
						params.owner,
						now,
					]
				);
				if (updated.affectedRows !== 1) return null;
				const released = await getItemByIdentity(
					connection,
					params.id,
					params.itemId,
					params.itemOrdinal,
					true
				);
				return released ? normalizeBatchItemRow(released) : null;
			});
		},

		async failExecutionPreflight(params) {
			assertFailBatchExecutionPreflightParams(params);
			return await inTransaction(pool, async (connection) => {
				const batchRow = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				const currentBatch = batchRow ? normalizeBatchRow(batchRow) : null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return { status: "batch_lease_lost" as const };
				}

				const openItem = await getNextOpenItem(connection, params.id, true);
				if (!openItem) return { status: "empty" as const };
				const dispatched = await getFirstOpenDispatchedItem(
					connection,
					params.id,
					true
				);
				if (dispatched) {
					return {
						status: "outcome_unknown" as const,
						item: normalizeBatchItemRow(dispatched),
					};
				}

				const now = toMySqlDateTime(params.nowIso);
				const failedItems = await mysqlExecute(
					connection,
					`UPDATE batch_items
					 SET status = 'failed', completed_at = COALESCE(completed_at, ?),
					     error_code = ?, error_summary = NULL,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NULL`,
					[now, params.errorCode, now, params.id]
				);
				if (failedItems.affectedRows < 1) {
					throw new Error("batch execution preflight found no items after row lock");
				}
				const updated = await mysqlExecute(
					connection,
					`UPDATE batches
					 SET status = 'failed',
					     failed_count = request_count - completed_count - cancelled_count,
					     finalized_at = ?, last_error_code = ?,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND revision = ? AND status = 'in_progress'
					   AND lease_owner = ? AND lease_expires_at > ?`,
					[
						now,
						params.errorCode,
						now,
						params.id,
						params.expectedRevision,
						params.owner,
						now,
					]
				);
				if (updated.affectedRows !== 1) {
					throw new Error("batch execution preflight failure raced after row lock");
				}
				const failed = await getById(
					connection,
					params.id,
					params.accountId,
					params.workspaceId,
					true
				);
				if (!failed) {
					throw new Error("failed batch execution preflight could not be read back");
				}
				return {
					status: "failed" as const,
					batch: normalizeBatchRow(failed),
				};
			});
		},
	};
}
