import { WorkerEntrypoint } from 'cloudflare:workers';
import { createUsageRecoveryHost, rejectUsageRecoveryHttp, type RecoveryInvocationResult } from '../../src/runtime/usage-recovery-host';

const host = createUsageRecoveryHost();

/** Only a control Worker explicitly bound to this named entrypoint can trigger it. */
export class UsageRecovery extends WorkerEntrypoint<UsageRecoveryWorkerEnv> {
	async run(): Promise<RecoveryInvocationResult | { status: 'invalid_arguments' }> {
		// RPC callers cannot select tenants, jobs, SQL, credentials or run budgets.
		if (arguments.length !== 0) return { status: 'invalid_arguments' as const };
		return host.run(this.env.RECOVERY_DB, this.env, this.ctx);
	}

	fetch() { return rejectUsageRecoveryHttp(); }
}

export default { fetch: rejectUsageRecoveryHttp } satisfies ExportedHandler<UsageRecoveryWorkerEnv>;
