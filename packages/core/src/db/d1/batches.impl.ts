import type { D1Database } from "@cloudflare/workers-types";
import type { D1DatabaseClient } from "../../storage/database-client";
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
	type ClaimNextBatchItemParams,
	type ClaimNextBatchItemResult,
	type CreateBatchParams,
} from "../batch-types";
import {
	assertBatchInstant,
	classifyBatchCreateReplay,
	normalizeBatchItemRow,
	normalizeBatchInternalLimit,
	normalizeBatchRow,
	ownsLiveBatchExecutionLease,
	type BatchDatabaseRow,
	type BatchItemDatabaseRow,
} from "../batch-repository-utils";

const COLUMNS = `id, account_id, workspace_id, user_id, api_key_hash,
	endpoint, model_id, route_group, status, completion_window,
	idempotency_key_hash, input_object_key, input_sha256,
	input_bytes, result_object_key, result_sha256, request_count,
	validation_next_ordinal, validation_input_offset, completed_count,
	failed_count, cancelled_count, prompt_tokens, completion_tokens,
	total_tokens, charged_cost_micros, byok_request_count, unknown_cost_count,
	created_at, in_progress_at, finalizing_at, finalized_at, expires_at,
	retention_expires_at, lease_owner, lease_expires_at, attempt_count,
	revision, last_error_code, updated_at`;

const ITEM_COLUMNS = `id, batch_id, ordinal, custom_id, status, attempt_count,
	started_at, dispatch_started_at, completed_at, generation_id, reservation_id,
	lease_owner, lease_expires_at, request_start_offset, request_end_offset,
	request_sha256, result_object_key, result_sha256, error_code, error_summary,
	revision, created_at, updated_at`;

const CREATE_SQL = `INSERT INTO batches (
	id, account_id, workspace_id, user_id, api_key_hash, endpoint, model_id,
	route_group, status, completion_window, idempotency_key_hash,
	input_object_key, input_sha256, input_bytes, request_count, created_at, expires_at,
	retention_expires_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'validating', '24h', ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT DO NOTHING`;

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
		params.createdAt,
	];
}

async function getByOpaqueId(
	raw: D1Database,
	id: string
): Promise<BatchDatabaseRow | null> {
	return (
		(await raw
			.prepare(`SELECT ${COLUMNS} FROM batches WHERE id = ?`)
			.bind(id)
			.first<BatchDatabaseRow>()) ?? null
	);
}

function isD1UniqueConstraintError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /UNIQUE constraint failed|constraint failed: UNIQUE/iu.test(message);
}

async function getById(
	raw: D1Database,
	id: string,
	accountId: string,
	workspaceId: string
): Promise<BatchDatabaseRow | null> {
	return (
		(await raw
			.prepare(
				`SELECT ${COLUMNS} FROM batches
				 WHERE id = ? AND account_id = ? AND workspace_id = ?`
			)
			.bind(id, accountId, workspaceId)
			.first<BatchDatabaseRow>()) ?? null
	);
}

async function getNextOpenItem(
	raw: D1Database,
	batchId: string
): Promise<BatchItemDatabaseRow | null> {
	return (
		(await raw
			.prepare(
				`SELECT ${ITEM_COLUMNS} FROM batch_items
				 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
				 ORDER BY ordinal LIMIT 1`
			)
			.bind(batchId)
			.first<BatchItemDatabaseRow>()) ?? null
	);
}

async function getFirstOpenDispatchedItem(
	raw: D1Database,
	batchId: string
): Promise<BatchItemDatabaseRow | null> {
	return (
		(await raw
			.prepare(
				`SELECT ${ITEM_COLUMNS} FROM batch_items
				 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
				   AND dispatch_started_at IS NOT NULL
				 ORDER BY ordinal LIMIT 1`
			)
			.bind(batchId)
			.first<BatchItemDatabaseRow>()) ?? null
	);
}

function classifyUnclaimedItem(
	item: BatchItemDatabaseRow | null,
	params: ClaimNextBatchItemParams
): ClaimNextBatchItemResult {
	if (!item) return { status: "empty" };
	const normalized = normalizeBatchItemRow(item);
	if (normalized.dispatch_started_at !== null) {
		return { status: "outcome_unknown", item: normalized };
	}
	if (
		normalized.status === "in_progress" &&
		normalized.lease_owner !== params.owner &&
		normalized.lease_expires_at !== null &&
		Date.parse(normalized.lease_expires_at) > Date.parse(params.nowIso)
	) {
		return { status: "item_lease_contended" };
	}
	return { status: "item_lease_contended" };
}

async function findReplay(
	raw: D1Database,
	params: CreateBatchParams
): Promise<BatchDatabaseRow | null> {
	if (params.idempotencyKeyHash !== null) {
		const scoped = await raw
			.prepare(
				`SELECT ${COLUMNS} FROM batches
				 WHERE workspace_id = ? AND api_key_hash = ? AND idempotency_key_hash = ?`
			)
			.bind(
				params.workspaceId,
				params.apiKeyHash,
				params.idempotencyKeyHash
			)
			.first<BatchDatabaseRow>();
		if (scoped) return scoped;
	}
	return await getById(raw, params.id, params.accountId, params.workspaceId);
}

export function createD1BatchesRepository(
	db: D1DatabaseClient
): BatchesRepository {
	const raw = db.raw;

	return {
		async create(params) {
			assertCreateBatchParams(params);
			const result = await raw
				.prepare(CREATE_SQL)
				.bind(...createValues(params))
				.run();
			if ((result.meta.changes ?? 0) === 1) {
				const created = await getById(
					raw,
					params.id,
					params.accountId,
					params.workspaceId
				);
				if (!created) throw new Error("created batch could not be read back");
				return { status: "created", batch: normalizeBatchRow(created) };
			}
			return classifyBatchCreateReplay(await findReplay(raw, params), params);
		},

		async getByIdInWorkspace(id, accountId, workspaceId) {
			assertBatchId(id);
			assertBatchTenant(accountId, workspaceId);
			const row = await getById(raw, id, accountId, workspaceId);
			return row ? normalizeBatchRow(row) : null;
		},

		async getByIdForDispatch(id) {
			assertBatchId(id);
			const row = await getByOpaqueId(raw, id);
			return row ? normalizeBatchRow(row) : null;
		},

		async listByWorkspace(params) {
			assertListBatchesParams(params);
			const conditions = ["account_id = ?", "workspace_id = ?"];
			const values: unknown[] = [params.accountId, params.workspaceId];
			const statuses = normalizeBatchListStatuses(params.statuses);
			if (statuses.length > 0) {
				conditions.push(
					`status IN (${statuses.map(() => "?").join(", ")})`
				);
				values.push(...statuses);
			}
			if (params.createdAfter) {
				conditions.push("created_at > ?");
				values.push(params.createdAfter);
			}
			if (params.createdBefore) {
				conditions.push("created_at < ?");
				values.push(params.createdBefore);
			}
			if (params.after) {
				conditions.push(
					"(created_at < ? OR (created_at = ? AND id < ?))"
				);
				values.push(
					params.after.createdAt,
					params.after.createdAt,
					params.after.id
				);
			}
			const limit = normalizeBatchListLimit(params.limit);
			values.push(limit + 1);
			const result = await raw
				.prepare(
					`SELECT ${COLUMNS} FROM batches
					 WHERE ${conditions.join(" AND ")}
					 ORDER BY created_at DESC, id DESC LIMIT ?`
				)
				.bind(...values)
				.all<BatchDatabaseRow>();
			return batchPage((result.results ?? []).map(normalizeBatchRow), limit);
		},

		async listDispatchCandidates(nowIso, limit) {
			assertBatchInstant(nowIso, "batch dispatch scan time");
			const bounded = normalizeBatchInternalLimit(limit);
			const result = await raw
				.prepare(
					`SELECT ${COLUMNS} FROM batches
					 WHERE status IN ('validating', 'in_progress')
					   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
					 ORDER BY created_at, id LIMIT ?`
				)
				.bind(nowIso, bounded)
				.all<BatchDatabaseRow>();
			return (result.results ?? []).map(normalizeBatchRow);
		},

		async claimLease(params) {
			assertBatchLeaseParams(params);
			const row = await raw
				.prepare(
					`UPDATE batches
					 SET lease_owner = ?, lease_expires_at = ?,
					     attempt_count = attempt_count + 1,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ?
					   AND status IN ('validating', 'in_progress')
					   AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.owner,
					params.leaseExpiresAtIso,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.nowIso
				)
				.first<BatchDatabaseRow>();
			return row ? normalizeBatchRow(row) : null;
		},

		async renewLease(params) {
			assertBatchLeaseParams(params);
			const row = await raw
				.prepare(
					`UPDATE batches
					 SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ? AND lease_owner = ? AND lease_expires_at > ?
					   AND status IN ('validating', 'in_progress')
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.leaseExpiresAtIso,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchDatabaseRow>();
			return row ? normalizeBatchRow(row) : null;
		},

		async advanceValidation(params) {
			assertAdvanceBatchValidationParams(params);
			const inserts = params.items.map((item) =>
					raw
					.prepare(
						`INSERT INTO batch_items (
							id, batch_id, ordinal, custom_id,
							request_start_offset, request_end_offset, request_sha256,
							created_at, updated_at
						)
						SELECT ?, id, ?, ?, ?, ?, ?, ?, ? FROM batches
						 WHERE id = ? AND account_id = ? AND workspace_id = ?
						   AND revision = ? AND status = 'validating'
						   AND lease_owner = ? AND lease_expires_at > ?
						   AND validation_next_ordinal = ?
						   AND validation_input_offset = ? AND ? < request_count
						   AND ? <= request_count AND ? <= input_bytes`
					)
					.bind(
						item.id,
						item.ordinal,
						item.customId,
						item.requestStartOffset,
						item.requestEndOffset,
						item.requestSha256,
						params.nowIso,
						params.nowIso,
						params.id,
						params.accountId,
						params.workspaceId,
						params.expectedRevision,
						params.owner,
						params.nowIso,
						params.expectedNextOrdinal,
						params.expectedInputOffset,
						item.ordinal,
						params.expectedNextOrdinal + params.items.length,
						params.nextInputOffset
					)
			);
			const checkpoint = raw
				.prepare(
					`UPDATE batches
					 SET validation_next_ordinal = ?, validation_input_offset = ?,
					     updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ? AND status = 'validating'
					   AND lease_owner = ? AND lease_expires_at > ?
					   AND validation_next_ordinal = ?
					   AND validation_input_offset = ?
					   AND ? <= request_count AND ? <= input_bytes
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.expectedNextOrdinal + params.items.length,
					params.nextInputOffset,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso,
					params.expectedNextOrdinal,
					params.expectedInputOffset,
					params.expectedNextOrdinal + params.items.length,
					params.nextInputOffset
				);
			try {
				const results = await raw.batch<BatchDatabaseRow>([
					...inserts,
					checkpoint,
				]);
				const row = results.at(-1)?.results?.[0];
				return row
					? { status: "advanced", batch: normalizeBatchRow(row) }
					: { status: "lease_lost" };
			} catch (error) {
				if (isD1UniqueConstraintError(error)) return { status: "conflict" };
				throw error;
			}
		},

		async completeValidation(params) {
			assertCompleteBatchValidationParams(params);
			const row = await raw
				.prepare(
					`UPDATE batches
					 SET status = 'in_progress', in_progress_at = COALESCE(in_progress_at, ?),
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ? AND status = 'validating'
					   AND lease_owner = ? AND lease_expires_at > ?
					   AND validation_next_ordinal = request_count
					   AND validation_input_offset = input_bytes
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.nowIso,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchDatabaseRow>();
			return row ? normalizeBatchRow(row) : null;
		},

		async failValidation(params) {
			assertFailBatchValidationParams(params);
			const row = await raw
				.prepare(
					`UPDATE batches
					 SET status = 'failed', finalized_at = ?, last_error_code = ?,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ? AND status = 'validating'
					   AND lease_owner = ? AND lease_expires_at > ?
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.nowIso,
					params.errorCode,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchDatabaseRow>();
			return row ? normalizeBatchRow(row) : null;
		},

		async claimNextItem(params) {
			assertClaimNextBatchItemParams(params);
			const currentBatch = await getById(
				raw,
				params.id,
				params.accountId,
				params.workspaceId
			);
			if (
				!currentBatch ||
				!ownsLiveBatchExecutionLease(normalizeBatchRow(currentBatch), params)
			) {
				return { status: "batch_lease_lost" };
			}
			const candidate = await getNextOpenItem(raw, params.id);
			if (!candidate) return { status: "empty" };
			const normalizedCandidate = normalizeBatchItemRow(candidate);
			if (normalizedCandidate.dispatch_started_at !== null) {
				return { status: "outcome_unknown", item: normalizedCandidate };
			}
			if (
				normalizedCandidate.status === "in_progress" &&
				normalizedCandidate.lease_owner !== params.owner &&
				normalizedCandidate.lease_expires_at !== null &&
				Date.parse(normalizedCandidate.lease_expires_at) >
					Date.parse(params.nowIso)
			) {
				return { status: "item_lease_contended" };
			}

			const row = await raw
				.prepare(
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
					     OR lease_expires_at IS NULL OR lease_expires_at <= ?)
					   AND EXISTS (
					     SELECT 1 FROM batches
					      WHERE id = ? AND account_id = ? AND workspace_id = ?
					        AND status = 'in_progress' AND revision = ?
					        AND lease_owner = ? AND lease_expires_at > ?
					   )
					 RETURNING ${ITEM_COLUMNS}`
				)
				.bind(
					params.owner,
					params.leaseExpiresAtIso,
					params.nowIso,
					params.nowIso,
					params.nowIso,
					normalizedCandidate.id,
					params.id,
					normalizedCandidate.ordinal,
					normalizedCandidate.revision,
					params.owner,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchItemDatabaseRow>();
			if (row) return { status: "claimed", item: normalizeBatchItemRow(row) };

			const refreshedBatch = await getById(
				raw,
				params.id,
				params.accountId,
				params.workspaceId
			);
			if (
				!refreshedBatch ||
				!ownsLiveBatchExecutionLease(normalizeBatchRow(refreshedBatch), params)
			) {
				return { status: "batch_lease_lost" };
			}
			return classifyUnclaimedItem(await getNextOpenItem(raw, params.id), params);
		},

		async markItemDispatchStarted(params) {
			assertMarkBatchItemDispatchStartedParams(params);
			const row = await raw
				.prepare(
					`UPDATE batch_items
					 SET dispatch_started_at = ?, generation_id = ?, reservation_id = ?,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND ordinal = ? AND revision = ?
					   AND status = 'in_progress' AND dispatch_started_at IS NULL
					   AND lease_owner = ? AND lease_expires_at > ?
					   AND EXISTS (
					     SELECT 1 FROM batches
					      WHERE id = ? AND account_id = ? AND workspace_id = ?
					        AND status = 'in_progress' AND revision = ?
					        AND lease_owner = ? AND lease_expires_at > ?
					   )
					 RETURNING ${ITEM_COLUMNS}`
				)
				.bind(
					params.nowIso,
					params.generationId,
					params.reservationId,
					params.nowIso,
					params.itemId,
					params.id,
					params.itemOrdinal,
					params.expectedItemRevision,
					params.owner,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchItemDatabaseRow>();
			return row ? normalizeBatchItemRow(row) : null;
		},

		async releaseItemBeforeDispatch(params) {
			assertReleaseBatchItemBeforeDispatchParams(params);
			const row = await raw
				.prepare(
					`UPDATE batch_items
					 SET status = 'pending', lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND batch_id = ? AND ordinal = ? AND revision = ?
					   AND status = 'in_progress' AND dispatch_started_at IS NULL
					   AND lease_owner = ? AND lease_expires_at > ?
					   AND EXISTS (
					     SELECT 1 FROM batches
					      WHERE id = ? AND account_id = ? AND workspace_id = ?
					        AND status = 'in_progress' AND revision = ?
					        AND lease_owner = ? AND lease_expires_at > ?
					   )
					 RETURNING ${ITEM_COLUMNS}`
				)
				.bind(
					params.nowIso,
					params.itemId,
					params.id,
					params.itemOrdinal,
					params.expectedItemRevision,
					params.owner,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso
				)
				.first<BatchItemDatabaseRow>();
			return row ? normalizeBatchItemRow(row) : null;
		},

		async failExecutionPreflight(params) {
			assertFailBatchExecutionPreflightParams(params);
			const failBatch = raw
				.prepare(
					`UPDATE batches
					 SET status = 'failed', failed_count = request_count - completed_count - cancelled_count,
					     finalized_at = ?, last_error_code = ?,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE id = ? AND account_id = ? AND workspace_id = ?
					   AND revision = ? AND status = 'in_progress'
					   AND lease_owner = ? AND lease_expires_at > ?
					   AND EXISTS (
					     SELECT 1 FROM batch_items
					      WHERE batch_id = ? AND status IN ('pending', 'in_progress')
					   )
					   AND NOT EXISTS (
					     SELECT 1 FROM batch_items
					      WHERE batch_id = ? AND status IN ('pending', 'in_progress')
					        AND dispatch_started_at IS NOT NULL
					   )
					 RETURNING ${COLUMNS}`
				)
				.bind(
					params.nowIso,
					params.errorCode,
					params.nowIso,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision,
					params.owner,
					params.nowIso,
					params.id,
					params.id
				);
			const failItems = raw
				.prepare(
					`UPDATE batch_items
					 SET status = 'failed', completed_at = COALESCE(completed_at, ?),
					     error_code = ?, error_summary = NULL,
					     lease_owner = NULL, lease_expires_at = NULL,
					     revision = revision + 1, updated_at = ?
					 WHERE batch_id = ? AND status IN ('pending', 'in_progress')
					   AND dispatch_started_at IS NULL
					   AND EXISTS (
					     SELECT 1 FROM batches
					      WHERE id = ? AND account_id = ? AND workspace_id = ?
					        AND status = 'failed' AND revision = ?
					        AND last_error_code = ? AND finalized_at = ?
					        AND lease_owner IS NULL AND lease_expires_at IS NULL
					   )`
				)
				.bind(
					params.nowIso,
					params.errorCode,
					params.nowIso,
					params.id,
					params.id,
					params.accountId,
					params.workspaceId,
					params.expectedRevision + 1,
					params.errorCode,
					params.nowIso
				);
			const results = await raw.batch<BatchDatabaseRow>([
				failBatch,
				failItems,
			]);
			const failed = results[0]?.results?.[0];
			if (failed) {
				return { status: "failed", batch: normalizeBatchRow(failed) };
			}

			const current = await getById(
				raw,
				params.id,
				params.accountId,
				params.workspaceId
			);
			if (
				!current ||
				!ownsLiveBatchExecutionLease(normalizeBatchRow(current), params)
			) {
				return { status: "batch_lease_lost" };
			}
			const dispatched = await getFirstOpenDispatchedItem(raw, params.id);
			if (dispatched) {
				return {
					status: "outcome_unknown",
					item: normalizeBatchItemRow(dispatched),
				};
			}
			return (await getNextOpenItem(raw, params.id))
				? { status: "batch_lease_lost" }
				: { status: "empty" };
		},
	};
}
