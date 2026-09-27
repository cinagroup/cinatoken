import type { PostgresRecoveryRunResult } from './run-usage-recovery-postgres';

/** Type-only view of a disabled PostgreSQL recovery candidate.
 * This does not grant execution, SQL, cancellation, connection or release authority.
 */
export type PostgresRecoveryResultView = Readonly<PostgresRecoveryRunResult>;

export type PostgresRecoverySnapshot = Readonly<{
  settled: boolean;
  heldLanes: number;
  uncertainLanes: number;
  resources: 'pending' | PostgresRecoveryRunResult['resources'];
  pending: Readonly<{ statement: number; transaction: number; callback: number }>;
  result: Readonly<Omit<PostgresRecoveryRunResult, 'resources'> & {
    resources: 'pending' | PostgresRecoveryRunResult['resources'];
  }>;
  cancellation: 'requested' | 'not_requested';
  physicalClose: 'not_observed';
}>;

/** Observation cannot start work, alter admission, cancel SQL or release a hold. */
export type PostgresRecoveryObservationView = Readonly<{
  completion: Promise<PostgresRecoveryResultView>;
  snapshot(): PostgresRecoverySnapshot;
}>;

export type PostgresRecoveryObservation = Readonly<{
  status: 'completed' | 'completion_rejected' | 'observation_expired' | 'clock_invalid';
  snapshot: PostgresRecoverySnapshot;
}>;

export type PostgresRecoveryObservationProfile = Readonly<{
  /** Total elapsed observation budget, not a SQL/server execution timeout. */
  observationBudgetMs: number;
  /** Additional observation, not a forced cleanup or release TTL. */
  cleanupObservationMs: number;
}>;
