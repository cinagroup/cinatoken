import { createHash } from "node:crypto";
import {
	MAX_BATCH_LEASE_MILLISECONDS,
	isBatchDispatchMessage,
	type BatchDispatchMessage,
	type BatchRow,
	type BatchValidationFailureCode,
	type BatchesRepository,
} from "@octafuse/core";
import type { GatewayBindings } from "../app";
import {
	BatchJsonlError,
	consumeBatchJsonlChunk,
	type BatchJsonlChunkSummary,
} from "../services/batch-jsonl";
import {
	BatchObjectIntegrityError,
	CloudflareBatchObjectStore,
} from "../services/batch-object-storage";

const STAGED_RETRY_DELAY_SECONDS = 300;
const CONTINUATION_DELAY_SECONDS = 1;
const LEASE_CONTENTION_DELAY_SECONDS = 30;

interface BatchValidationObject {
	body: ReadableStream<Uint8Array>;
}

interface BatchValidationObjectStore {
	getVerifiedRange(
		workspaceId: string,
		batchId: string,
		kind: "input",
		expectedSha256: string,
		expectedSize: number,
		offset: number
	): Promise<BatchValidationObject | null>;
}

export interface BatchQueueDependencies {
	resolveBatchesRepository: () => Promise<BatchesRepository>;
	now?: () => Date;
	objectStore?: BatchValidationObjectStore;
}

function validationLeaseOwner(batchId: string): string {
	return `validation:${createHash("sha256").update(batchId).digest("hex")}`;
}

export function batchValidationItemId(batchId: string, ordinal: number): string {
	if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
		throw new RangeError("batch validation item ordinal must be non-negative");
	}
	return `batch_req_${createHash("sha256")
		.update(batchId)
		.update("\0")
		.update(String(ordinal))
		.digest("hex")}`;
}

function instant(dependencies: BatchQueueDependencies): Date {
	const value = dependencies.now?.() ?? new Date();
	if (!Number.isFinite(value.getTime())) {
		throw new TypeError("Batch Queue clock returned an invalid instant");
	}
	return value;
}

function retry(message: Message<unknown>, delaySeconds: number): void {
	message.retry({ delaySeconds });
}

async function failValidation(
	repository: BatchesRepository,
	batch: BatchRow,
	owner: string,
	nowIso: string,
	errorCode: BatchValidationFailureCode,
	message: Message<unknown>
): Promise<void> {
	const failed = await repository.failValidation({
		id: batch.id,
		accountId: batch.account_id,
		workspaceId: batch.workspace_id,
		owner,
		expectedRevision: batch.revision,
		nowIso,
		errorCode,
	});
	if (!failed) {
		retry(message, LEASE_CONTENTION_DELAY_SECONDS);
		return;
	}
	console.warn(
		JSON.stringify({
			level: "warn",
			message: "cinatoken.batch_validation_failed",
			message_id: message.id,
			batch_id: batch.id,
			error_code: errorCode,
		})
	);
	message.ack();
}

async function acquireValidationLease(
	repository: BatchesRepository,
	batch: BatchRow,
	owner: string,
	now: Date
): Promise<BatchRow | null> {
	const nowIso = now.toISOString();
	const leaseExpiresAtIso = new Date(
		now.getTime() + MAX_BATCH_LEASE_MILLISECONDS
	).toISOString();
	if (
		batch.lease_owner === owner &&
		batch.lease_expires_at !== null &&
		Date.parse(batch.lease_expires_at) > now.getTime()
	) {
		return await repository.renewLease({
			id: batch.id,
			accountId: batch.account_id,
			workspaceId: batch.workspace_id,
			owner,
			expectedRevision: batch.revision,
			nowIso,
			leaseExpiresAtIso,
		});
	}
	return await repository.claimLease({
		id: batch.id,
		accountId: batch.account_id,
		workspaceId: batch.workspace_id,
		owner,
		expectedRevision: batch.revision,
		nowIso,
		leaseExpiresAtIso,
	});
}

async function continueValidation(
	environment: GatewayBindings,
	body: BatchDispatchMessage,
	message: Message<unknown>
): Promise<void> {
	if (!environment.BATCH_QUEUE) {
		retry(message, CONTINUATION_DELAY_SECONDS);
		return;
	}
	try {
		await environment.BATCH_QUEUE.send(body, {
			delaySeconds: CONTINUATION_DELAY_SECONDS,
		});
		message.ack();
	} catch {
		retry(message, CONTINUATION_DELAY_SECONDS);
	}
}

async function processBatchMessage(
	message: Message<unknown>,
	body: BatchDispatchMessage,
	environment: GatewayBindings,
	dependencies: BatchQueueDependencies,
	repository: BatchesRepository,
	objectStore: BatchValidationObjectStore
): Promise<void> {
	const current = await repository.getByIdForDispatch(body.batch_id);
	if (!current) {
		console.warn(
			JSON.stringify({
				level: "warn",
				message: "cinatoken.batch_message_orphaned",
				message_id: message.id,
				batch_id: body.batch_id,
			})
		);
		message.ack();
		return;
	}
	if (current.status !== "validating") {
		if (current.status === "in_progress") {
			console.error(
				JSON.stringify({
					level: "error",
					message: "cinatoken.batch_executor_staged",
					message_id: message.id,
					batch_id: current.id,
				})
			);
			retry(message, STAGED_RETRY_DELAY_SECONDS);
			return;
		}
		message.ack();
		return;
	}

	const owner = validationLeaseOwner(current.id);
	const now = instant(dependencies);
	const leased = await acquireValidationLease(repository, current, owner, now);
	if (!leased) {
		retry(message, LEASE_CONTENTION_DELAY_SECONDS);
		return;
	}
	const nowIso = now.toISOString();
	if (
		leased.validation_input_offset === leased.input_bytes ||
		leased.validation_next_ordinal === leased.request_count
	) {
		if (
			leased.validation_input_offset !== leased.input_bytes ||
			leased.validation_next_ordinal !== leased.request_count
		) {
			await failValidation(
				repository,
				leased,
				owner,
				nowIso,
				"batch_input_count_mismatch",
				message
			);
			return;
		}
		const completed = await repository.completeValidation({
			id: leased.id,
			accountId: leased.account_id,
			workspaceId: leased.workspace_id,
			owner,
			expectedRevision: leased.revision,
			nowIso,
		});
		retry(
			message,
			completed ? STAGED_RETRY_DELAY_SECONDS : LEASE_CONTENTION_DELAY_SECONDS
		);
		return;
	}

	let object: BatchValidationObject | null;
	try {
		object = await objectStore.getVerifiedRange(
			leased.workspace_id,
			leased.id,
			"input",
			leased.input_sha256,
			leased.input_bytes,
			leased.validation_input_offset
		);
	} catch (error) {
		if (error instanceof BatchObjectIntegrityError) {
			await failValidation(
				repository,
				leased,
				owner,
				nowIso,
				"batch_input_integrity",
				message
			);
			return;
		}
		throw error;
	}
	if (!object) {
		await failValidation(
			repository,
			leased,
			owner,
			nowIso,
			"batch_input_missing",
			message
		);
		return;
	}

	const items: Array<{
		id: string;
		ordinal: number;
		customId: string;
		requestStartOffset: number;
		requestEndOffset: number;
		requestSha256: string;
	}> = [];
	let summary: BatchJsonlChunkSummary;
	try {
		summary = await consumeBatchJsonlChunk(object.body, {
			expectedModel: leased.model_id,
			totalInputBytes: leased.input_bytes,
			initialOrdinal: leased.validation_next_ordinal,
			initialOffset: leased.validation_input_offset,
			maxRequests: leased.request_count,
			onItem(item, cursor) {
				items.push({
					id: batchValidationItemId(leased.id, cursor.ordinal),
					ordinal: cursor.ordinal,
					customId: item.custom_id,
					requestStartOffset: cursor.startOffset,
					requestEndOffset: cursor.nextOffset,
					requestSha256: cursor.requestSha256,
				});
			},
		});
	} catch (error) {
		if (error instanceof BatchJsonlError) {
			await failValidation(
				repository,
				leased,
				owner,
				nowIso,
				error.code === "too_many_requests"
					? "batch_input_count_mismatch"
					: "batch_input_invalid",
				message
			);
			return;
		}
		throw error;
	}

	const advanced = await repository.advanceValidation({
		id: leased.id,
		accountId: leased.account_id,
		workspaceId: leased.workspace_id,
		owner,
		expectedRevision: leased.revision,
		expectedNextOrdinal: leased.validation_next_ordinal,
		expectedInputOffset: leased.validation_input_offset,
		nextInputOffset: summary.nextOffset,
		items,
		nowIso,
	});
	if (advanced.status === "lease_lost") {
		retry(message, LEASE_CONTENTION_DELAY_SECONDS);
		return;
	}
	if (advanced.status === "conflict") {
		await failValidation(
			repository,
			leased,
			owner,
			nowIso,
			"batch_item_conflict",
			message
		);
		return;
	}
	if (
		summary.reachedEnd !==
		(summary.nextOrdinal === advanced.batch.request_count)
	) {
		await failValidation(
			repository,
			advanced.batch,
			owner,
			nowIso,
			"batch_input_count_mismatch",
			message
		);
		return;
	}
	if (summary.reachedEnd) {
		const completed = await repository.completeValidation({
			id: advanced.batch.id,
			accountId: advanced.batch.account_id,
			workspaceId: advanced.batch.workspace_id,
			owner,
			expectedRevision: advanced.batch.revision,
			nowIso,
		});
		retry(
			message,
			completed ? STAGED_RETRY_DELAY_SECONDS : LEASE_CONTENTION_DELAY_SECONDS
		);
		return;
	}
	await continueValidation(environment, body, message);
}

/**
 * Phase 3 validates private JSONL into an idempotent item ledger. Upstream item
 * execution remains deliberately staged, so in_progress messages are retained.
 */
export async function handleWorkerBatchQueue(
	batch: MessageBatch<unknown>,
	environment: GatewayBindings,
	dependencies?: BatchQueueDependencies
): Promise<void> {
	const dlqName = environment.BATCH_QUEUE_DLQ;
	if (dlqName && batch.queue === dlqName) {
		console.error(
			JSON.stringify({
				level: "error",
				message: "cinatoken.batch_dead_letter",
				queue: batch.queue,
				messages: batch.messages.map((message) => ({
					message_id: message.id,
					batch_id: isBatchDispatchMessage(message.body)
						? message.body.batch_id
						: null,
				})),
			})
		);
		for (const message of batch.messages) message.ack();
		return;
	}

	if (!dependencies) {
		for (const message of batch.messages) {
			if (!isBatchDispatchMessage(message.body)) {
				console.warn(
					JSON.stringify({
						level: "warn",
						message: "cinatoken.batch_message_rejected",
						message_id: message.id,
						reason: "invalid_envelope",
					})
				);
				message.ack();
				continue;
			}
			console.error(
				JSON.stringify({
					level: "error",
					message: "cinatoken.batch_consumer_staged",
					message_id: message.id,
					batch_id: message.body.batch_id,
					api_enabled: environment.BATCH_API_ENABLED === "true",
				})
			);
			retry(message, STAGED_RETRY_DELAY_SECONDS);
		}
		return;
	}

	const accepted: Array<{
		message: Message<unknown>;
		body: BatchDispatchMessage;
	}> = [];
	for (const message of batch.messages) {
		if (!isBatchDispatchMessage(message.body)) {
			console.warn(
				JSON.stringify({
					level: "warn",
					message: "cinatoken.batch_message_rejected",
					message_id: message.id,
					reason: "invalid_envelope",
				})
			);
			message.ack();
			continue;
		}
		accepted.push({ message, body: message.body });
	}
	if (accepted.length === 0) return;

	const objectStore =
		dependencies.objectStore ??
		(environment.BATCH_BUCKET
			? new CloudflareBatchObjectStore(environment.BATCH_BUCKET)
			: null);
	if (!objectStore) {
		for (const { message, body } of accepted) {
			console.error(
				JSON.stringify({
					level: "error",
					message: "cinatoken.batch_binding_missing",
					message_id: message.id,
					batch_id: body.batch_id,
					binding: "BATCH_BUCKET",
				})
			);
			retry(message, STAGED_RETRY_DELAY_SECONDS);
		}
		return;
	}

	let repository: BatchesRepository;
	try {
		repository = await dependencies.resolveBatchesRepository();
	} catch (error) {
		for (const { message, body } of accepted) {
			console.error(
				JSON.stringify({
					level: "error",
					message: "cinatoken.batch_storage_unavailable",
					message_id: message.id,
					batch_id: body.batch_id,
					error_type: error instanceof Error ? error.name : "UnknownError",
				})
			);
			retry(message, LEASE_CONTENTION_DELAY_SECONDS);
		}
		return;
	}

	for (const { message, body } of accepted) {
		try {
			await processBatchMessage(
				message,
				body,
				environment,
				dependencies,
				repository,
				objectStore
			);
		} catch (error) {
			console.error(
				JSON.stringify({
					level: "error",
					message: "cinatoken.batch_consumer_error",
					message_id: message.id,
					batch_id: body.batch_id,
					error_type: error instanceof Error ? error.name : "UnknownError",
				})
			);
			retry(message, LEASE_CONTENTION_DELAY_SECONDS);
		}
	}
}
