import type {
  PostgresRecoveryObservation,
  PostgresRecoveryObservationProfile,
  PostgresRecoveryObservationView,
} from '@octafuse/core/storage/recovery/postgres-observation-types';

declare const view: PostgresRecoveryObservationView;
declare const observation: PostgresRecoveryObservation;
declare const profile: PostgresRecoveryObservationProfile;

const completion: Promise<Readonly<{ resources: 'confirmed' | 'unconfirmed' }>> = view.completion;
const settled: boolean = view.snapshot().settled;
const status: PostgresRecoveryObservation['status'] = observation.status;
const budget: number = profile.observationBudgetMs;
void [completion, settled, status, budget];

// @ts-expect-error A read-only observer has no SQL or cancellation authority.
view.ownedStatement('SELECT 1');
// @ts-expect-error A read-only observer cannot stop or release the run.
view.stopAdmission('aborted');
// @ts-expect-error A read-only observer cannot cancel an active scan.
view.cancelActiveScan();
// @ts-expect-error A read-only observer cannot expose the raw database client.
view.raw;
// @ts-expect-error A read-only observer cannot mutate a reported state.
view.snapshot().resources = 'confirmed';
