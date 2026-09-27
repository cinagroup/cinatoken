import { WorkerEntrypoint } from 'cloudflare:workers';
import { createUsageRecoveryHost, rejectUsageRecoveryHttp, type RecoveryInvocationResult } from '../../src/runtime/usage-recovery-host';
import { withRecoveryFencingProbe } from './recovery-fencing-probe';
import { withRecoveryClaimDelayProbe } from './recovery-claim-delay-probe';

const host = createUsageRecoveryHost();

/** Staging-only composition; no new binding, public trigger, argument or budget. */
export class UsageRecovery extends WorkerEntrypoint<UsageRecoveryWorkerEnv> {
	async run(): Promise<RecoveryInvocationResult | { status: 'invalid_arguments' }> {
		if (arguments.length !== 0) return { status: 'invalid_arguments' as const };
		return host.run(withRecoveryClaimDelayProbe(withRecoveryFencingProbe(this.env.RECOVERY_DB)), this.env, this.ctx);
	}
	fetch() { return rejectUsageRecoveryHttp(); }
}

export default { fetch: rejectUsageRecoveryHttp } satisfies ExportedHandler<UsageRecoveryWorkerEnv>;
