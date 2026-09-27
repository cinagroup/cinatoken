import type { D1DatabaseClient } from '../database-client';
import { createUsageSettlementRepositoryD1 } from './usage-settlement-d1';
import { createUsageRecoveryJobsD1, ownRecoveryScope, type RecoveryScanScope, type RecoveryFailure, type RecoveryLease } from './usage-recovery-jobs-d1';
import { SettlementConflictError, SettlementSnapshotInvalidError } from './settlement-recovery-types';
import { assertUsageRecoverySchemaD1 } from './usage-recovery-schema-d1';

export type UsageRecoveryRunOptions = Readonly<{
	scope: RecoveryScanScope;
	maxItems: number;
	concurrency: number;
	leaseSeconds: number;
	/** Stops NEW admission only; D1 promises cannot be cancelled or released before settling. */
	runBudgetMs: number;
	/** Supplied by a measured runtime profile, including payload/encoding/SQL and shared scan overhead. No production default. */
	reservedBytesPerConsumer: number;
}>;
export type RecoveryCapacity = { tryAcquire(reservedBytes: number): { release(): void } | null };
export type UsageRecoveryRunResult = {
	scanned: number; claimed: number; committed: number; blocked: number; deferred: number;
	lostOwnership: number; uncertain: number; skipped: number; capacityLimited: boolean; admissionStopped: boolean;
};

/** One bounded invocation, independent of original HTTP requests. No polling/sleep loop, model I/O or queue send. */
export async function runUsageRecoveryD1(
	client: D1DatabaseClient,
	input: UsageRecoveryRunOptions,
	capacity: RecoveryCapacity,
	control: { signal?: AbortSignal; now?: () => number } = {},
): Promise<UsageRecoveryRunResult> {
	const options = { scope: ownRecoveryScope(input.scope), maxItems: input.maxItems, concurrency: input.concurrency,
		leaseSeconds: input.leaseSeconds, runBudgetMs: input.runBudgetMs, reservedBytesPerConsumer: input.reservedBytesPerConsumer };
	for (const [value, max] of [[options.maxItems,50],[options.concurrency,4],[options.leaseSeconds,300],[options.runBudgetMs,60000],[options.reservedBytesPerConsumer,Number.MAX_SAFE_INTEGER]]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid bounded recovery run options');
	}
	const signal = control.signal, now = control.now ?? (() => performance.now());
	const startedAt = now();
	if (!Number.isFinite(startedAt) || startedAt < 0 || startedAt > Number.MAX_SAFE_INTEGER - options.runBudgetMs) throw new TypeError('Invalid recovery clock');
	const result: UsageRecoveryRunResult = { scanned:0,claimed:0,committed:0,blocked:0,deferred:0,lostOwnership:0,uncertain:0,skipped:0,capacityLimited:false,admissionStopped:false };
	const stopped = () => {
		const tick = now();
		if (!Number.isFinite(tick) || tick < startedAt || signal?.aborted || tick - startedAt >= options.runBudgetMs) { result.admissionStopped = true; return true; }
		return false;
	};
	const holds: { release(): void }[] = [];
	const jobs = createUsageRecoveryJobsD1(client.raw), settlements = createUsageSettlementRepositoryD1(client);
	async function recordFailure(lease: RecoveryLease, reason: RecoveryFailure) {
		try {
			const status = await jobs.fail(lease, reason);
			if (status === 'not_owned') result.lostOwnership++;
			else result[status]++;
		} catch { result.uncertain++; }
	}
	try {
		if (stopped()) return result;
		for (let n=0; n < Math.min(options.concurrency,options.maxItems); n++) {
			const hold = capacity.tryAcquire(options.reservedBytesPerConsumer);
			if (!hold) { result.capacityLimited = true; break; }
			holds.push(hold);
		}
		if (holds.length === 0) return result;
		// This read/hashing is part of the held workset, never done ahead of admission.
		await assertUsageRecoverySchemaD1(client.raw);
		if (stopped()) return result;
		const candidates = await jobs.scanDue(options.scope, options.maxItems);
		result.scanned = candidates.length;
		let cursor = 0;
		async function consume() {
			while (!stopped() && cursor < candidates.length) {
				const candidate = candidates[cursor++];
				let claim;
				try { claim = await jobs.claim(candidate, options.leaseSeconds); }
				catch { result.uncertain++; continue; }
				if (claim.status === 'not_claimed') { result.skipped++; continue; }
				if (claim.status === 'exhausted') { result.blocked++; continue; }
				const { lease } = claim;
				result.claimed++;
				if (stopped()) { await recordFailure(lease,'interrupted'); break; }
				try {
					await settlements.commit(lease.ref,lease.proof);
					result.committed++;
				} catch (error) {
					await recordFailure(lease, error instanceof SettlementSnapshotInvalidError ? 'snapshot_invalid'
						: error instanceof SettlementConflictError ? 'settlement_conflict' : 'execution_error');
				}
			}
		}
		// allSettled retains every capacity hold until ALL started D1 work really settles,
		// including unexpected errors in another consumer. No Promise.race(timeout).
		const outcomes = await Promise.allSettled(holds.map(() => consume()));
		const failure = outcomes.find(outcome => outcome.status === 'rejected');
		if (failure?.status === 'rejected') throw failure.reason;
		return result;
	} finally { for (const hold of holds) hold.release(); }
}
