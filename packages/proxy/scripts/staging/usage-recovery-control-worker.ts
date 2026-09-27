import type { UsageRecoveryControlEnv } from './usage-recovery-control-env';
import { createUsageRecoveryControl } from '../../src/runtime/usage-recovery-control';

const control = createUsageRecoveryControl();
export default {
	fetch(request, env, ctx) { return control.fetch(request, env, ctx); },
} satisfies ExportedHandler<UsageRecoveryControlEnv>;
