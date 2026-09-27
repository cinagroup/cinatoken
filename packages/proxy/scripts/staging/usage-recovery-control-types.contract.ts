import type { UsageRecoveryControlEnv } from './usage-recovery-control-env';

type Assert<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// Compile-time-only contract. Generated environments must not merge capabilities.
export type RecoveryControlTypeContract = [
	Assert<Equal<keyof UsageRecoveryControlEnv, 'RECOVERY_CONTROL_ENVIRONMENT' | 'RECOVERY_CONTROL_ENABLED' | 'RECOVERY_CONTROL_ACCESS_AUD' | 'USAGE_RECOVERY'>>,
	Assert<Equal<Parameters<UsageRecoveryControlEnv['USAGE_RECOVERY']['run']>, []>>,
	Assert<Equal<Extract<keyof UsageRecoveryWorkerEnv, keyof UsageRecoveryControlEnv>, never>>,
];
