/// <reference path="../../scripts/staging/usage-recovery-env.d.ts" />
import type { D1Database, ExecutionContext } from '@cloudflare/workers-types';
import { createD1DatabaseClient } from '../../../core/src/storage/database-client';
import { runUsageRecoveryD1, type UsageRecoveryRunOptions, type UsageRecoveryRunResult } from '../../../core/src/storage/recovery/run-usage-recovery-d1';
import { createRequestCapacityPool, type RequestCapacityPool } from '../services/request-capacity';

type RecoverySettings = Omit<UsageRecoveryWorkerEnv, 'RECOVERY_DB'>;
export type RecoveryInvocationResult =
	| { status: 'finished'; runId: string; result: UsageRecoveryRunResult }
	| { status: 'disabled' | 'invalid_configuration' | 'profile_changed' | 'busy' | 'host_rejected' | 'execution_failed'; runId?: string };

function positive(value: string, max: number): number {
	if (typeof value !== 'string' || value.length > 16 || !/^[1-9][0-9]*$/.test(value)) throw new TypeError('Invalid recovery parameter');
	const number = Number(value);
	if (!Number.isSafeInteger(number) || number > max) throw new TypeError('Invalid recovery parameter');
	return number;
}

function configuration(settings: RecoverySettings): { options: UsageRecoveryRunOptions; instanceBytes: number } {
	if (settings.RECOVERY_ENVIRONMENT !== 'staging' || settings.RECOVERY_ENABLED !== 'true') throw new TypeError('Recovery is not enabled for staging');
	const options: UsageRecoveryRunOptions = {
		scope: { kind: 'all' }, // Dedicated DB administrative capability, never a caller-selected tenant.
		maxItems: positive(settings.RECOVERY_MAX_ITEMS, 50),
		concurrency: positive(settings.RECOVERY_CONCURRENCY, 4),
		leaseSeconds: positive(settings.RECOVERY_LEASE_SECONDS, 300),
		runBudgetMs: positive(settings.RECOVERY_RUN_BUDGET_MS, 60000),
		reservedBytesPerConsumer: positive(settings.RECOVERY_RESERVED_BYTES, Number.MAX_SAFE_INTEGER),
	};
	const instanceBytes = positive(settings.RECOVERY_INSTANCE_BYTES, Number.MAX_SAFE_INTEGER);
	if (instanceBytes < options.reservedBytesPerConsumer) throw new TypeError('Recovery profile cannot admit one consumer');
	return { options, instanceBytes };
}

/**
 * One numeric-only host per dedicated Worker isolate. No stored bindings, env,
 * requests, DTOs, promises, tenant IDs or leases. This is NOT a fleet-wide lock.
 */
export function createUsageRecoveryHost(control: { now?: () => number } = {}) {
	let active = false;
	let profile: string | undefined;
	let capacity: RequestCapacityPool | undefined;
	const now = control.now;
	return {
		// Local diagnostic only; the Worker does not expose this over RPC.
		snapshot: () => ({ active, capacity: capacity?.snapshot() ?? null }),
		run(db: D1Database, settings: RecoverySettings, context: Pick<ExecutionContext, 'waitUntil'>): Promise<RecoveryInvocationResult> {
			if (settings.RECOVERY_ENABLED === 'false') return Promise.resolve({ status: 'disabled' });
			let config: ReturnType<typeof configuration>;
			try { config = configuration(settings); }
			catch { return Promise.resolve({ status: 'invalid_configuration' }); }
			const fingerprint = JSON.stringify(config);
			if (profile !== undefined && profile !== fingerprint) return Promise.resolve({ status: 'profile_changed' });
			if (active) return Promise.resolve({ status: 'busy' });
			// Initialize once; a new per-call pool would bypass aggregate admission.
			capacity ??= createRequestCapacityPool({ maxRequests: config.options.concurrency, maxReservedBytes: config.instanceBytes });
			profile = fingerprint;
			const pool = capacity;
			active = true;
			let registered = false;
			const task = Promise.resolve().then(async (): Promise<RecoveryInvocationResult> => {
				if (!registered) return { status: 'host_rejected' };
				const runId = crypto.randomUUID();
				try {
					const result = await runUsageRecoveryD1(createD1DatabaseClient(db), config.options, pool, { now });
					// Scalars only. Never log raw D1 exceptions, SQL, snapshots or credentials.
					console.log(JSON.stringify({ event: 'usage_recovery_run', runId, status: 'finished', ...result }));
					return { status: 'finished', runId, result };
				} catch {
					console.error(JSON.stringify({ event: 'usage_recovery_run', runId, status: 'execution_failed' }));
					return { status: 'execution_failed', runId };
				}
			}).catch((): RecoveryInvocationResult => ({ status: 'execution_failed' }))
				.finally(() => { active = false; });
			// Register before any D1 I/O. If host registration throws, queued work
			// observes registered=false and performs no scan/claim/accounting write.
			try { context.waitUntil(task.then(() => undefined)); registered = true; }
			catch { /* Fixed host_rejected result; do not leak the runtime exception. */ }
			return task;
		},
	};
}

/** No request parsing, authentication-header trust, public trigger or DB access. */
export function rejectUsageRecoveryHttp(): Response {
	return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
