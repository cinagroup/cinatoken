import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import {
	POSTGRES_RECOVERY_STAGING_QUEUE,
	type PostgresRecoveryQueueOutcome,
} from './postgres-recovery-queue-owner';

type QueueContext = Pick<ExecutionContext, 'waitUntil'>;
type QueueOwner<Environment> = Readonly<{
	queue(batch: MessageBatch<unknown>, environment: Environment, context: QueueContext): Promise<PostgresRecoveryQueueOutcome>;
}>;

/**
 * Local declaration only. An operator must separately verify the deployed Queue
 * consumer has these exact settings and an active DLQ before binding a handler.
 * This object is not proof of Cloudflare configuration.
 */
export type DeclaredRecoveryQueueConsumer = Readonly<{
	queue: typeof POSTGRES_RECOVERY_STAGING_QUEUE;
	deadLetterQueue: string;
	maxBatchSize: 1;
	maxRetries: number;
	baseRetryDelaySeconds: number;
	maxRetryDelaySeconds: number;
}>;

export type PostgresRecoveryQueueDisposition = Readonly<{
	ownerStatus: PostgresRecoveryQueueOutcome['status'] | 'owner_threw' | 'invalid_batch' | 'disabled';
	disposition: 'retry_requested';
	/** Diagnostic only. A declared limit does not prove the platform sent to the DLQ. */
	atDeclaredRetryLimit: boolean;
}>;

export type PostgresRecoveryQueueDispositionDependencies<Environment> = Readonly<{
	/** Default false; construction never installs a Worker Queue handler. */
	enabled?: boolean;
	owner: QueueOwner<Environment>;
	declaredConsumer?: DeclaredRecoveryQueueConsumer;
}>;

function ownDeclaration(input: DeclaredRecoveryQueueConsumer | undefined): DeclaredRecoveryQueueConsumer {
	if (!input || input.queue !== POSTGRES_RECOVERY_STAGING_QUEUE || input.maxBatchSize !== 1 ||
		typeof input.deadLetterQueue !== 'string' ||
		!/^[-a-z0-9]{1,100}$/u.test(input.deadLetterQueue) ||
		input.deadLetterQueue === input.queue ||
		!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 1 || input.maxRetries > 100 ||
		!Number.isSafeInteger(input.baseRetryDelaySeconds) || input.baseRetryDelaySeconds < 1 ||
		input.baseRetryDelaySeconds > 3600 ||
		!Number.isSafeInteger(input.maxRetryDelaySeconds) ||
		input.maxRetryDelaySeconds < input.baseRetryDelaySeconds || input.maxRetryDelaySeconds > 3600)
		throw new TypeError('Explicit bounded PostgreSQL recovery Queue and DLQ declaration required');
	return Object.freeze({
		queue: input.queue, deadLetterQueue: input.deadLetterQueue,
		maxBatchSize: 1, maxRetries: input.maxRetries,
		baseRetryDelaySeconds: input.baseRetryDelaySeconds,
		maxRetryDelaySeconds: input.maxRetryDelaySeconds,
	});
}

function attempt(batch: MessageBatch<unknown>): number | null {
	try {
		if (batch.queue !== POSTGRES_RECOVERY_STAGING_QUEUE || batch.messages.length !== 1) return null;
		const value = batch.messages[0]?.attempts;
		return Number.isSafeInteger(value) && value >= 1 ? value : null;
	} catch { return null; }
}

function retryDelay(input: DeclaredRecoveryQueueConsumer | undefined, deliveryAttempt: number | null): number | null {
	if (!input || deliveryAttempt === null) return null;
	return Math.min(input.maxRetryDelaySeconds, input.baseRetryDelaySeconds * 2 ** Math.min(deliveryAttempt - 1, 20));
}

function observationOnlyBatch(batch: MessageBatch<unknown>): MessageBatch<unknown> {
	const forbidDisposition = () => { throw new TypeError('Queue disposition is owned by the outer handler'); };
	// Cloudflare gives the first ack/retry call precedence. Never let an injected
	// owner mark the real batch before the outer handler requests retry.
	return Object.freeze({
		queue: batch.queue,
		messages: Object.freeze(batch.messages.map(message => Object.freeze({
			id: message.id, timestamp: message.timestamp, attempts: message.attempts,
			body: message.body, ack: forbidDisposition, retry: forbidDisposition,
		}))),
		metadata: batch.metadata,
		ackAll: forbidDisposition,
		retryAll: forbidDisposition,
	}) as MessageBatch<unknown>;
}

/**
 * Isolated, default-disabled delivery candidate. It NEVER ACKs, even for
 * `run_drained`: that result lacks a per-wake durable receipt and is explicitly
 * `physicalClose: not_observed`; the financial consumer likewise reports
 * `queueAckSafe: false` for every outcome. A future ACK path needs a durable
 * wake identity/receipt plus lease and unknown-result reconciliation, followed
 * by real at-least-once redelivery tests. The V1 identity-free wake cannot
 * supply that proof.
 *
 * The main Promise awaits the owner's original completion. On every normal
 * path it marks the entire batch for explicit retry, including when disabled,
 * malformed or the owner throws. If retryAll itself throws, the handler rejects
 * so the host sees a failed invocation. It does not release owner capacity,
 * reset a quarantine, verify a physical close, or prove actual DLQ settings.
 * Do not bind to a real Worker until DBL-04/05/06, cross-isolate ownership,
 * host configuration and delivery/DLQ gates are separately verified.
 */
export function createPostgresRecoveryQueueDisposition<Environment>(
	dependencies: PostgresRecoveryQueueDispositionDependencies<Environment>,
) {
	if (!dependencies || typeof dependencies.owner?.queue !== 'function' ||
		(dependencies.enabled !== undefined && typeof dependencies.enabled !== 'boolean'))
		throw new TypeError('PostgreSQL recovery Queue owner and switch required');
	const declaration = dependencies.enabled === true ? ownDeclaration(dependencies.declaredConsumer) : undefined;
	return Object.freeze({
		async queue(batch: MessageBatch<unknown>, environment: Environment, context: QueueContext): Promise<PostgresRecoveryQueueDisposition> {
			const deliveryAttempt = attempt(batch);
			let ownerStatus: PostgresRecoveryQueueDisposition['ownerStatus'] = 'disabled';
			if (dependencies.enabled === true) {
				if (deliveryAttempt === null || deliveryAttempt > declaration!.maxRetries + 1) {
					ownerStatus = 'invalid_batch';
				} else {
					try { ownerStatus = (await dependencies.owner.queue(observationOnlyBatch(batch), environment, context)).status; }
					catch { ownerStatus = 'owner_threw'; }
				}
			}
			const delaySeconds = retryDelay(declaration, deliveryAttempt);
			// A normal return without this call would implicitly ACK the whole batch.
			// Keep this after the awaited owner completion; never use waitUntil alone.
			try {
				if (delaySeconds === null) batch.retryAll();
				else batch.retryAll({ delaySeconds });
			} catch {
				// A rejected handler triggers host retry; do not leak a raw host error.
				throw new Error('PostgreSQL recovery Queue retry disposition failed');
			}
			return Object.freeze({
				ownerStatus,
				disposition: 'retry_requested',
				atDeclaredRetryLimit: deliveryAttempt !== null && declaration !== undefined &&
					deliveryAttempt >= declaration.maxRetries + 1,
			});
		},
	});
}
