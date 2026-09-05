import type { PostgresDatabaseClient } from "../../storage/database-client";
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
	classifyBatchCreateReplay,
	normalizeBatchItemRow,
	normalizeBatchInternalLimit,
	normalizeBatchRow,
	ownsLiveBatchExecutionLease,
	type BatchDatabaseRow,
	type BatchItemDatabaseRow,
} from "../batch-repository-utils";

const SELECT_COLUMNS = `id, account_id, workspace_id, user_id, api_key_hash,
	endpoint, model_id, route_group, status, completion_window,
	idempotency_key_hash, input_object_key, input_sha256,
	input_bytes, result_object_key, result_sha256, request_count,
	validation_next_ordinal, validation_input_offset, completed_count,
	failed_count, cancelled_count, prompt_tokens, completion_tokens,
	total_tokens, charged_cost_micros, byok_request_count, unknown_cost_count,
	created_at::text AS created_at, in_progress_at::text AS in_progress_at,
	finalizing_at::text AS finalizing_at, finalized_at::text AS finalized_at,
	expires_at::text AS expires_at,
	retention_expires_at::text AS retention_expires_at,
	lease_owner, lease_expires_at::text AS lease_expires_at,
	attempt_count, revision, last_error_code, updated_at::text AS updated_at`;

const ITEM_SELECT_COLUMNS = `id, batch_id, ordinal, custom_id, status,
	attempt_count, started_at::text AS started_at,
	dispatch_started_at::text AS dispatch_started_at,
	completed_at::text AS completed_at, generation_id, reservation_id,
	lease_owner, lease_expires_at::text AS lease_expires_at,
	request_start_offset, request_end_offset, request_sha256,
	result_object_key, result_sha256, error_code, error_summary, revision,
	created_at::text AS created_at, updated_at::text AS updated_at`;

const CREATE_SQL = `INSERT INTO batches (
	id, account_id, workspace_id, user_id, api_key_hash, endpoint, model_id,
	route_group, status, completion_window, idempotency_key_hash,
	input_object_key, input_sha256, input_bytes, request_count, created_at, expires_at,
	retention_expires_at, updated_at
) VALUES (
	$1, $2, $3, $4, $5, $6, $7, $8, 'validating', '24h', $9,
	$10, $11, $12, $13, $14::timestamptz, $15::timestamptz,
	$16::timestamptz, $14::timestamptz
) ON CONFLICT DO NOTHING RETURNING ${SELECT_COLUMNS}`;

function createValues(params: CreateBatchParams): unknown[] {
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
		params.createdAt,
		params.expiresAt,
		params.retentionExpiresAt,
	];
}

function postgresErrorCode(error: unknown): string | null {
	return typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof error.code === "string"
		? error.code
		: null;
}

export function createPostgresBatchesRepository(
	db: PostgresDatabaseClient
): BatchesRepository {
	const pg = db.raw;

	return {
		async create(params) {
			assertCreateBatchParams(params);
			return await pg.begin(async (tx) => {
				const inserted = await tx.unsafe<BatchDatabaseRow[]>(
					CREATE_SQL,
					createValues(params) as never[]
				);
				if (inserted[0]) {
					return {
						status: "created" as const,
						batch: normalizeBatchRow(inserted[0]),
					};
				}

				let existing: BatchDatabaseRow | undefined;
				if (params.idempotencyKeyHash !== null) {
					const scoped = await tx.unsafe<BatchDatabaseRow[]>(
						`SELECT ${SELECT_COLUMNS} FROM batches
						 WHERE workspace_id = $1 AND api_key_hash = $2
						   AND idempotency_key_hash = $3 FOR SHARE`,
						[
							params.workspaceId,
							params.apiKeyHash,
							params.idempotencyKeyHash,
						]
					);
					existing = scoped[0];
				}
				if (!existing) {
					const byId = await tx.unsafe<BatchDatabaseRow[]>(
						`SELECT ${SELECT_COLUMNS} FROM batches
						 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
						 FOR SHARE`,
						[params.id, params.accountId, params.workspaceId]
					);
					existing = byId[0];
				}
				return classifyBatchCreateReplay(existing ?? null, params);
			});
		},

		async getByIdInWorkspace(id, accountId, workspaceId) {
			assertBatchId(id);
			assertBatchTenant(accountId, workspaceId);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`SELECT ${SELECT_COLUMNS} FROM batches
				 WHERE id = $1 AND account_id = $2 AND workspace_id = $3`,
				[id, accountId, workspaceId]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async getByIdForDispatch(id) {
			assertBatchId(id);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`SELECT ${SELECT_COLUMNS} FROM batches WHERE id = $1`,
				[id]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async listByWorkspace(params) {
			assertListBatchesParams(params);
			const conditions = ["account_id = $1", "workspace_id = $2"];
			const values: unknown[] = [params.accountId, params.workspaceId];
			const bind = (value: unknown) => {
				values.push(value);
				return `$${values.length}`;
			};
			const statuses = normalizeBatchListStatuses(params.statuses);
			if (statuses.length > 0) {
				conditions.push(
					`status IN (${statuses.map((status) => bind(status)).join(", ")})`
				);
			}
			if (params.createdAfter) {
				conditions.push(`created_at > ${bind(params.createdAfter)}::timestamptz`);
			}
			if (params.createdBefore) {
				conditions.push(`created_at < ${bind(params.createdBefore)}::timestamptz`);
			}
			if (params.after) {
				const cursorTime = bind(params.after.createdAt);
				const cursorId = bind(params.after.id);
				conditions.push(
					`(created_at, id) < (${cursorTime}::timestamptz, ${cursorId})`
				);
			}
			const limit = normalizeBatchListLimit(params.limit);
			const limitPlaceholder = bind(limit + 1);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`SELECT ${SELECT_COLUMNS} FROM batches
				 WHERE ${conditions.join(" AND ")}
				 ORDER BY created_at DESC, id DESC LIMIT ${limitPlaceholder}`,
				values as never[]
			);
			return batchPage(rows.map(normalizeBatchRow), limit);
		},

		async listDispatchCandidates(nowIso, limit) {
			assertBatchInstant(nowIso, "batch dispatch scan time");
			const bounded = normalizeBatchInternalLimit(limit);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`SELECT ${SELECT_COLUMNS} FROM batches
				 WHERE status IN ('validating', 'in_progress')
				   AND (lease_expires_at IS NULL OR lease_expires_at <= $1::timestamptz)
				 ORDER BY created_at, id LIMIT $2`,
				[nowIso, bounded]
			);
			return rows.map(normalizeBatchRow);
		},

		async claimLease(params) {
			assertBatchLeaseParams(params);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`UPDATE batches
				 SET lease_owner = $1, lease_expires_at = $2::timestamptz,
				     attempt_count = attempt_count + 1,
				     revision = revision + 1, updated_at = $3::timestamptz
				 WHERE id = $4 AND account_id = $5 AND workspace_id = $6
				   AND revision = $7::bigint
				   AND status IN ('validating', 'in_progress')
				   AND (lease_expires_at IS NULL OR lease_expires_at <= $3::timestamptz)
				 RETURNING ${SELECT_COLUMNS}`,
				[
					params.owner,
					params.leaseExpiresAtIso,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
				]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async renewLease(params) {
			assertBatchLeaseParams(params);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`UPDATE batches
				 SET lease_expires_at = $1::timestamptz,
				     revision = revision + 1, updated_at = $2::timestamptz
				 WHERE id = $3 AND account_id = $4 AND workspace_id = $5
				   AND revision = $6::bigint AND lease_owner = $7
				   AND lease_expires_at > $2::timestamptz
				   AND status IN ('validating', 'in_progress')
				 RETURNING ${SELECT_COLUMNS}`,
				[
					params.leaseExpiresAtIso,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
				]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async advanceValidation(params) {
			assertAdvanceBatchValidationParams(params);
			try {
				return await pg.begin(async (tx) => {
					const lockedRows = await tx.unsafe<BatchDatabaseRow[]>(
						`SELECT ${SELECT_COLUMNS} FROM batches
						 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
						 FOR UPDATE`,
						[params.id, params.accountId, params.workspaceId]
					);
					const locked = lockedRows[0]
						? normalizeBatchRow(lockedRows[0])
						: null;
					if (!locked || !canAdvanceBatchValidation(locked, params)) {
						return { status: "lease_lost" as const };
					}

					const values: unknown[] = [];
					const bind = (value: unknown) => {
						values.push(value);
						return `$${values.length}`;
					};
					const tuples = params.items.map(
						(item) =>
							`(${bind(item.id)}, ${bind(params.id)}, ${bind(item.ordinal)}, ${bind(item.customId)}, ${bind(item.requestStartOffset)}, ${bind(item.requestEndOffset)}, ${bind(item.requestSha256)}, ${bind(params.nowIso)}::timestamptz, ${bind(params.nowIso)}::timestamptz)`
					);
					await tx.unsafe(
						`INSERT INTO batch_items (
							id, batch_id, ordinal, custom_id,
							request_start_offset, request_end_offset, request_sha256,
							created_at, updated_at
						) VALUES ${tuples.join(", ")}`,
						values as never[]
					);

					const updated = await tx.unsafe<BatchDatabaseRow[]>(
						`UPDATE batches
						 SET validation_next_ordinal = $1,
						     validation_input_offset = $2,
						     updated_at = $3::timestamptz
						 WHERE id = $4 AND account_id = $5 AND workspace_id = $6
						   AND revision = $7::bigint AND status = 'validating'
						   AND lease_owner = $8 AND lease_expires_at > $3::timestamptz
						   AND validation_next_ordinal = $9
						   AND validation_input_offset = $10
						   AND $1 <= request_count AND $2 <= input_bytes
						 RETURNING ${SELECT_COLUMNS}`,
						[
							params.expectedNextOrdinal + params.items.length,
							params.nextInputOffset,
							params.nowIso,
							params.id,
							params.accountId,
							params.workspaceId,
							params.expectedRevision,
							params.owner,
							params.expectedNextOrdinal,
							params.expectedInputOffset,
						]
					);
					if (!updated[0]) {
						throw new Error("batch validation checkpoint raced after row lock");
					}
					return {
						status: "advanced" as const,
						batch: normalizeBatchRow(updated[0]),
					};
				});
			} catch (error) {
				if (postgresErrorCode(error) === "23505") return { status: "conflict" };
				throw error;
			}
		},

		async completeValidation(params) {
			assertCompleteBatchValidationParams(params);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`UPDATE batches
				 SET status = 'in_progress',
				     in_progress_at = COALESCE(in_progress_at, $1::timestamptz),
				     lease_owner = NULL, lease_expires_at = NULL,
				     revision = revision + 1, updated_at = $1::timestamptz
				 WHERE id = $2 AND account_id = $3 AND workspace_id = $4
				   AND revision = $5::bigint AND status = 'validating'
				   AND lease_owner = $6 AND lease_expires_at > $1::timestamptz
				   AND validation_next_ordinal = request_count
				   AND validation_input_offset = input_bytes
				 RETURNING ${SELECT_COLUMNS}`,
				[
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
				]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async failValidation(params) {
			assertFailBatchValidationParams(params);
			const rows = await pg.unsafe<BatchDatabaseRow[]>(
				`UPDATE batches
				 SET status = 'failed', finalized_at = $1::timestamptz,
				     last_error_code = $2, lease_owner = NULL,
				     lease_expires_at = NULL, revision = revision + 1,
				     updated_at = $1::timestamptz
				 WHERE id = $3 AND account_id = $4 AND workspace_id = $5
				   AND revision = $6::bigint AND status = 'validating'
				   AND lease_owner = $7 AND lease_expires_at > $1::timestamptz
				 RETURNING ${SELECT_COLUMNS}`,
				[
					params.nowIso,
					params.errorCode,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
				]
			);
			return rows[0] ? normalizeBatchRow(rows[0]) : null;
		},

		async claimNextItem(params) {
			assertClaimNextBatchItemParams(params);
			return await pg.begin(async (tx) => {
				const batchRows = await tx.unsafe<BatchDatabaseRow[]>(
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
					 FOR UPDATE`,
					[params.id, params.accountId, params.workspaceId]
				);
				const currentBatch = batchRows[0]
					? normalizeBatchRow(batchRows[0])
					: null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return { status: "batch_lease_lost" as const };
				}

				const itemRows = await tx.unsafe<BatchItemDatabaseRow[]>(
					`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
					 WHERE batch_id = $1 AND status IN ('pending', 'in_progress')
					 ORDER BY ordinal LIMIT 1 FOR UPDATE`,
					[params.id]
				);
				if (!itemRows[0]) return { status: "empty" as const };
				const item = normalizeBatchItemRow(itemRows[0]);
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

				const updated = await tx.unsafe<BatchItemDatabaseRow[]>(
					`UPDATE batch_items
					 SET status = 'in_progress', lease_owner = $1,
					     lease_expires_at = $2::timestamptz,
					     attempt_count = attempt_count + CASE
					       WHEN status = 'pending' OR lease_owner IS NULL
					         OR lease_expires_at <= $3::timestamptz THEN 1 ELSE 0 END,
					     started_at = COALESCE(started_at, $3::timestamptz),
					     revision = revision + 1, updated_at = $3::timestamptz
					 WHERE id = $4 AND batch_id = $5 AND ordinal = $6
					   AND revision = $7::bigint
					   AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NULL
					   AND (status = 'pending' OR lease_owner = $1
					     OR lease_expires_at IS NULL OR lease_expires_at <= $3::timestamptz)
					 RETURNING ${ITEM_SELECT_COLUMNS}`,
					[
						params.owner,
						params.leaseExpiresAtIso,
						params.nowIso,
						item.id,
						params.id,
						item.ordinal,
						item.revision,
					]
				);
				if (!updated[0]) return { status: "item_lease_contended" as const };
				return {
					status: "claimed" as const,
					item: normalizeBatchItemRow(updated[0]),
				};
			});
		},

		async markItemDispatchStarted(params) {
			assertMarkBatchItemDispatchStartedParams(params);
			return await pg.begin(async (tx) => {
				const batchRows = await tx.unsafe<BatchDatabaseRow[]>(
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
					 FOR UPDATE`,
					[params.id, params.accountId, params.workspaceId]
				);
				const currentBatch = batchRows[0]
					? normalizeBatchRow(batchRows[0])
					: null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return null;
				}
				const rows = await tx.unsafe<BatchItemDatabaseRow[]>(
					`UPDATE batch_items
					 SET dispatch_started_at = $1::timestamptz,
					     generation_id = $2, reservation_id = $3,
					     revision = revision + 1, updated_at = $1::timestamptz
					 WHERE id = $4 AND batch_id = $5 AND ordinal = $6
					   AND revision = $7::bigint AND status = 'in_progress'
					   AND dispatch_started_at IS NULL AND lease_owner = $8
					   AND lease_expires_at > $1::timestamptz
					 RETURNING ${ITEM_SELECT_COLUMNS}`,
					[
						params.nowIso,
						params.generationId,
						params.reservationId,
						params.itemId,
						params.id,
						params.itemOrdinal,
						params.expectedItemRevision,
						params.owner,
					]
				);
				return rows[0] ? normalizeBatchItemRow(rows[0]) : null;
			});
		},

		async releaseItemBeforeDispatch(params) {
			assertReleaseBatchItemBeforeDispatchParams(params);
			return await pg.begin(async (tx) => {
				const batchRows = await tx.unsafe<BatchDatabaseRow[]>(
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
					 FOR UPDATE`,
					[params.id, params.accountId, params.workspaceId]
				);
				const currentBatch = batchRows[0]
					? normalizeBatchRow(batchRows[0])
					: null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return null;
				}
				const rows = await tx.unsafe<BatchItemDatabaseRow[]>(
					`UPDATE batch_items
					 SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = $1::timestamptz
					 WHERE id = $2 AND batch_id = $3 AND ordinal = $4
					   AND revision = $5::bigint AND status = 'in_progress'
					   AND dispatch_started_at IS NULL AND lease_owner = $6
					   AND lease_expires_at > $1::timestamptz
					 RETURNING ${ITEM_SELECT_COLUMNS}`,
					[
						params.nowIso,
						params.itemId,
						params.id,
						params.itemOrdinal,
						params.expectedItemRevision,
						params.owner,
					]
				);
				return rows[0] ? normalizeBatchItemRow(rows[0]) : null;
			});
		},

		async failExecutionPreflight(params) {
			assertFailBatchExecutionPreflightParams(params);
			return await pg.begin(async (tx) => {
				const batchRows = await tx.unsafe<BatchDatabaseRow[]>(
					`SELECT ${SELECT_COLUMNS} FROM batches
					 WHERE id = $1 AND account_id = $2 AND workspace_id = $3
					 FOR UPDATE`,
					[params.id, params.accountId, params.workspaceId]
				);
				const currentBatch = batchRows[0]
					? normalizeBatchRow(batchRows[0])
					: null;
				if (!currentBatch || !ownsLiveBatchExecutionLease(currentBatch, params)) {
					return { status: "batch_lease_lost" as const };
				}

				const openRows = await tx.unsafe<BatchItemDatabaseRow[]>(
					`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
					 WHERE batch_id = $1 AND status IN ('pending', 'in_progress')
					 ORDER BY ordinal LIMIT 1 FOR UPDATE`,
					[params.id]
				);
				if (openRows.length === 0) return { status: "empty" as const };
				const dispatchedRows = await tx.unsafe<BatchItemDatabaseRow[]>(
					`SELECT ${ITEM_SELECT_COLUMNS} FROM batch_items
					 WHERE batch_id = $1 AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NOT NULL
					 ORDER BY ordinal LIMIT 1 FOR UPDATE`,
					[params.id]
				);
				const dispatched = dispatchedRows[0];
				if (dispatched) {
					return {
						status: "outcome_unknown" as const,
						item: normalizeBatchItemRow(dispatched),
					};
				}

				await tx.unsafe(
					`UPDATE batch_items
					 SET status = 'failed', completed_at = COALESCE(completed_at, $1::timestamptz),
					     error_code = $2, error_summary = NULL,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = $1::timestamptz
					 WHERE batch_id = $3 AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NULL`,
					[params.nowIso, params.errorCode, params.id]
				);
				const failedRows = await tx.unsafe<BatchDatabaseRow[]>(
					`UPDATE batches
					 SET status = 'failed',
					     failed_count = request_count - completed_count - cancelled_count,
					     finalized_at = $1::timestamptz, last_error_code = $2,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = $1::timestamptz
					 WHERE id = $3 AND revision = $4::bigint AND status = 'in_progress'
					   AND lease_owner = $5 AND lease_expires_at > $1::timestamptz
					 RETURNING ${SELECT_COLUMNS}`,
					[
						params.nowIso,
						params.errorCode,
						params.id,
						params.expectedRevision,
						params.owner,
					]
				);
				if (!failedRows[0]) {
					throw new Error("batch execution preflight failure raced after row lock");
				}
				return {
					status: "failed" as const,
					batch: normalizeBatchRow(failedRows[0]),
				};
			});
		},
	};
}
