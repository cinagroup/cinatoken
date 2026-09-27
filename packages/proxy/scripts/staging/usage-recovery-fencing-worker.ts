import { WorkerEntrypoint } from 'cloudflare:workers';
import { createUsageRecoveryHost, rejectUsageRecoveryHttp, type RecoveryInvocationResult } from '../../src/runtime/usage-recovery-host';
import { withRecoveryFencingProbe } from './recovery-fencing-probe';

const host = createUsageRecoveryHost();

/** Separate staging-only candidate. Default consumer and production never import it. */
export class UsageRecovery extends WorkerEntrypoint<UsageRecoveryWorkerEnv> {
	async run(): Promise<RecoveryInvocationResult | { status: 'invalid_arguments' }> {
		if (arguments.length !== 0) return { status: 'invalid_arguments' as const };
		// Adapter construction performs no I/O; host registers waitUntil first.
		return host.run(withRecoveryFencingProbe(this.env.RECOVERY_DB), this.env, this.ctx);
	}

	fetch() { return rejectUsageRecoveryHttp(); }
}

export default { fetch: rejectUsageRecoveryHttp } satisfies ExportedHandler<UsageRecoveryWorkerEnv>;
