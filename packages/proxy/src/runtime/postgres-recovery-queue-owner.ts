import type { ExecutionContext, MessageBatch } from '@cloudflare/workers-types';
import type { PostgresRecoveryRunResult } from '../../../core/src/storage/recovery/run-usage-recovery-postgres';
import {
	createPostgresRecoveryInvocationDeadline,
	type PostgresRecoveryInvocationDeadline,
} from '../../../core/src/storage/recovery/postgres-recovery-invocation-deadline';

/** A wake-up signal only. It carries no tenant, job, model, SQL or retry policy. */
export const POSTGRES_RECOVERY_WAKE_V1 = 'postgres-usage-recovery-wake-v1';
export const POSTGRES_RECOVERY_STAGING_QUEUE = 'cinatoken-staging-postgres-recovery';

type Run = Readonly<{ completion: Promise<PostgresRecoveryRunResult> }>;
type ScalarResult = Readonly<{
	scanned: number;
	claimed: number;
	committed: number;
}>;

export type PostgresRecoveryQueueOutcome =
	| Readonly<{ status: 'disabled' | 'invalid_wake' | 'busy' | 'capacity_quarantined' | 'host_rejected' }>
	| Readonly<{ status: 'deadline_expired' | 'clock_invalid'; physicalClose: 'not_observed' }>
	| Readonly<{ status: 'run_drained' | 'bounded_incomplete'; result: ScalarResult; physicalClose: 'not_observed' }>
	| Readonly<{ status: 'outcome_unknown'; physicalClose: 'not_observed' }>;

export type PostgresRecoveryQueueDependencies<Environment, Client> = Readonly<{
	/** Explicit server composition only. No binding or message can enable the candidate. */
	enabled?: boolean;
	/** Starts before openClient; not a server/driver queue timeout. Required if enabled. */
	invocationBudgetMs?: number;
	/** Monotonic injected clock for deterministic local tests. */
	now?: () => number;
	/** Must create an invocation-private client; never pass the gateway's shared pool. */
	openClient(environment: Environment, deadline: PostgresRecoveryInvocationDeadline): Client | Promise<Client>;
	/** Exactly one bounded recovery execution using the SAME deadline. No inference. */
	startRun(client: Client, deadline: PostgresRecoveryInvocationDeadline): Run;
	/** Called only after the same run completion settles. Not a physical-close receipt. */
	retireClient(client: Client): void | Promise<void>;
}>;

const COUNTERS = [
	'discovered', 'registered', 'scanned', 'claimed', 'committed', 'blocked',
	'deferred', 'lostOwnership', 'uncertain', 'skipped', 'leasesLeftForExpiry',
	'retainedHolds',
] as const;

function classify(value: PostgresRecoveryRunResult): PostgresRecoveryQueueOutcome {
	try {
		if (!value || typeof value !== 'object') throw new TypeError();
		for (const key of COUNTERS) {
			if (!Number.isSafeInteger(value[key]) || value[key] < 0) throw new TypeError();
		}
		if (value.resources !== 'confirmed' && value.resources !== 'unconfirmed') throw new TypeError();
		if (typeof value.capacityLimited !== 'boolean' || typeof value.admissionStopped !== 'boolean') throw new TypeError();
		if (value.stopReason !== null && ![
			'aborted', 'budget', 'clock_invalid', 'database_unconfirmed', 'scan_failed',
			'registration_failed', 'consumer_failed', 'observation_deadline',
		].includes(value.stopReason)) throw new TypeError();
		if (value.committed > value.claimed || value.claimed > value.scanned || value.registered > value.discovered) throw new TypeError();
		if (value.resources !== 'confirmed' || value.retainedHolds !== 0 || value.uncertain !== 0 || value.leasesLeftForExpiry !== 0)
			return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
		const result = Object.freeze({ scanned: value.scanned, claimed: value.claimed, committed: value.committed });
		const incomplete = value.capacityLimited || value.admissionStopped || value.stopReason !== null ||
			value.blocked !== 0 || value.deferred !== 0 || value.lostOwnership !== 0 || value.skipped !== 0 ||
			value.registered !== value.discovered || value.claimed !== value.scanned || value.committed !== value.claimed;
		return Object.freeze({ status: incomplete ? 'bounded_incomplete' : 'run_drained', result, physicalClose: 'not_observed' });
	} catch {
		// A malformed or throwing result is not a successful recovery receipt.
		return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
	}
}

function validWake(batch: MessageBatch<unknown>): boolean {
	try {
		return batch.queue === POSTGRES_RECOVERY_STAGING_QUEUE && batch.messages.length === 1 &&
			batch.messages[0]?.body === POSTGRES_RECOVERY_WAKE_V1;
	} catch { return false; }
}

/**
 * Default-disabled candidate, not an exported Worker handler or a configured Queue consumer.
 * The queue handler's MAIN returned Promise must await this method. `waitUntil` is an
 * additional early registration guard, never a substitute for `completion`. An observer
 * timeout cannot release this invocation. Unknown client acquisition, an
 * uncertain run or failed retirement permanently quarantines this owner's local
 * capacity. This is only an isolate-local gate, not a fleet lock, server deadline,
 * financial receipt or physical socket-close proof.
 *
 * DO NOT bind queue() directly as ExportedHandler.queue: a normally resolved
 * Queue handler implicitly acknowledges the message, including `busy`,
 * `capacity_quarantined` or `outcome_unknown` diagnostic results. No durable wake
 * disposition, cross-isolate exclusion, full DBL-05 server deadline or DBL-06
 * release proof exists here. Keep this candidate unbound until those policies
 * are implemented and verified.
 */
export function createPostgresRecoveryQueueOwner<Environment, Client>(
	dependencies: PostgresRecoveryQueueDependencies<Environment, Client>,
) {
	if (dependencies.enabled === true && (!Number.isSafeInteger(dependencies.invocationBudgetMs) ||
		dependencies.invocationBudgetMs! < 1 || dependencies.invocationBudgetMs! > 60_000))
		throw new TypeError('Invalid PostgreSQL recovery invocation budget');
	let active = false;
	let capacityQuarantined = false;
	return {
		queue(
			batch: MessageBatch<unknown>,
			environment: Environment,
			context: Pick<ExecutionContext, 'waitUntil'>,
		): Promise<PostgresRecoveryQueueOutcome> {
			if (dependencies.enabled !== true) return Promise.resolve(Object.freeze({ status: 'disabled' }));
			if (!validWake(batch)) return Promise.resolve(Object.freeze({ status: 'invalid_wake' }));
			if (capacityQuarantined) return Promise.resolve(Object.freeze({ status: 'capacity_quarantined' }));
			if (active) return Promise.resolve(Object.freeze({ status: 'busy' }));
			let deadline: PostgresRecoveryInvocationDeadline;
			try { deadline = createPostgresRecoveryInvocationDeadline(dependencies.invocationBudgetMs!, dependencies.now); }
			catch { return Promise.resolve(Object.freeze({ status: 'clock_invalid', physicalClose: 'not_observed' })); }
			active = true;
			let registered = false;
			const task = Promise.resolve().then(async (): Promise<PostgresRecoveryQueueOutcome> => {
				if (!registered) return Object.freeze({ status: 'host_rejected' });
				const initial = deadline.snapshot();
				if (initial.status !== 'open') return Object.freeze({
					status: initial.status === 'expired' ? 'deadline_expired' : 'clock_invalid', physicalClose: 'not_observed',
				});
				let client: Client;
				try { client = await dependencies.openClient(environment, deadline); }
				catch {
					// A rejected opener may already have allocated an origin connection.
					capacityQuarantined = true;
					return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
				}
				const afterOpen = deadline.snapshot();
				if (afterOpen.status !== 'open') {
					try { await dependencies.retireClient(client); }
					catch {
						capacityQuarantined = true;
						return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
					}
					return Object.freeze({
						status: afterOpen.status === 'expired' ? 'deadline_expired' : 'clock_invalid', physicalClose: 'not_observed',
					});
				}
				let outcome: PostgresRecoveryQueueOutcome;
				try {
					const run = dependencies.startRun(client, deadline);
					// Await the ONE original run, including its started SQL/callbacks and lane drain.
					// Do not race an observation deadline or manufacture a replacement run.
					outcome = classify(await run.completion);
				} catch {
					outcome = Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
				}
				try { await dependencies.retireClient(client); }
				catch {
					capacityQuarantined = true;
					return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
				}
				// A completed runner may still report retained holds, an uncertain
				// transaction or a malformed result. Retirement alone cannot clear it.
				if (outcome.status === 'outcome_unknown') capacityQuarantined = true;
				return outcome;
			}).catch((): PostgresRecoveryQueueOutcome => {
				capacityQuarantined = true;
				return Object.freeze({ status: 'outcome_unknown', physicalClose: 'not_observed' });
			})
				.finally(() => { active = false; });
			// Defer even client initialization until the host accepts ownership. Returning
			// task itself keeps the Queue event open; waitUntil alone would not suffice.
			try { context.waitUntil(task.then(() => undefined)); registered = true; }
			catch { /* The deferred task observes registered=false and performs no DB I/O. */ }
			return task;
		},
	};
}
