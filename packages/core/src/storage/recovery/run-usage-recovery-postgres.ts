import type { PostgresDatabaseClient } from '../database-client';
import { createUsageRecoveryJobsPostgres, ownPostgresRecoveryScope, type PostgresRecoveryScope,
  type PostgresRecoveryLease, type PostgresRecoveryFailure, type PostgresRecoveryCandidate } from './usage-recovery-jobs-postgres';
import { createUsageSettlementRepositoryPostgres } from './usage-settlement-postgres';
import { SettlementConflictError, SettlementSnapshotInvalidError } from './settlement-recovery-types';
import { ownPostgresRecoveryOperations, POSTGRES_RECOVERY_SCAN_FENCE, POSTGRES_RECOVERY_DEADLINE_FENCE,
  POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE } from './postgres-recovery-operation-owner';
import type { PostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline';

export type PostgresRecoveryRunOptions = Readonly<{
  scope: PostgresRecoveryScope;
  /** Separate bounded work lists; neither is an unbounded/full-drain loop. */
  maxRegistrations: number;
  maxItems: number;
  concurrency: number;
  leaseSeconds: number;
  /** Stops NEW work admission, NOT a database/server execution timeout. */
  runBudgetMs: number;
  /** Required measured runtime profile, no production memory defaults. */
  reservedBytesPerConsumer: number;
  reservedBytesPerScan: number;
}>;
type Capacity = { tryAcquire(bytes: number): { release(): void } | null };
type Stop = 'aborted' | 'budget' | 'clock_invalid' | 'database_unconfirmed' | 'scan_failed' | 'registration_failed' | 'consumer_failed' | 'observation_deadline';
type Control = { signal?: AbortSignal; now?: () => number;
  /** Created before client initialization; still only an admission deadline. */ deadline?: PostgresRecoveryInvocationDeadline;
  /** Explicit, default-disabled candidate only. */ ownedScans?: true };
export type PostgresRecoveryRunResult = {
  discovered: number; registered: number; scanned: number; claimed: number; committed: number;
  blocked: number; deferred: number; lostOwnership: number; uncertain: number; skipped: number;
  leasesLeftForExpiry: number; capacityLimited: boolean; admissionStopped: boolean; stopReason: Stop | null;
  resources: 'confirmed' | 'unconfirmed'; retainedHolds: number;
};

/** Disabled internal, admission/work-count bounded invocation. No inference, scheduler,
 * ACTIVATION BLOCKED: installed-driver onclose regression, native/Workers lifecycle gates.
 * Queue send, current-price lookup, background promise, pool close or cancel command.
 * SQL/transaction callback lifetime remains separately owned, even after stop/ACK failure.
 */
export async function runUsageRecoveryPostgres(
  client: PostgresDatabaseClient, input: PostgresRecoveryRunOptions, capacity: Capacity,
  control: Control = {},
): Promise<PostgresRecoveryRunResult> {
  if (control.ownedScans === true)
    throw new TypeError('Owned recovery scans require the single-execution handle');
  return createPostgresRecoveryRun(client, input, capacity, control).completion;
}

/** Internal single execution handle. Never start a second run because an observer times out.
 * Its completion includes every started callback/SQL and lane drain, and may stay pending.
 * No cancellation, disposal, release, or replay authority is granted by stop/snapshot.
 */
export function createPostgresRecoveryRun(
  client: PostgresDatabaseClient, input: PostgresRecoveryRunOptions, capacity: Capacity,
  control: Control = {},
) {
  if (client.driver !== 'postgres') throw new TypeError('PostgreSQL recovery authority required');
  if (control.ownedScans !== undefined && control.ownedScans !== true) throw new TypeError('Invalid owned recovery scan option');
  const ownedScans = control.ownedScans === true;
  if (ownedScans && (client.raw as { ownedCancellation?: string }).ownedCancellation !== 'postgres-js-3.4.9-owned-cancel-v302')
    throw new TypeError('Owned cancellation driver required');
  if (ownedScans && (client.raw as { ownedRecoveryScanFence?: string }).ownedRecoveryScanFence !== POSTGRES_RECOVERY_SCAN_FENCE)
    throw new TypeError('Owned recovery scan driver required');
  if (ownedScans && control.deadline &&
    (client.raw as { ownedRecoveryDeadlineFence?: string }).ownedRecoveryDeadlineFence !== POSTGRES_RECOVERY_DEADLINE_FENCE)
    throw new TypeError('Owned recovery scan deadline driver required');
  const options = Object.freeze({ scope: ownPostgresRecoveryScope(input.scope), maxRegistrations: input.maxRegistrations,
    maxItems: input.maxItems, concurrency: input.concurrency, leaseSeconds: input.leaseSeconds,
    runBudgetMs: input.runBudgetMs, reservedBytesPerConsumer: input.reservedBytesPerConsumer, reservedBytesPerScan: input.reservedBytesPerScan });
  for (const [value,max] of [[options.maxRegistrations,50],[options.maxItems,50],[options.concurrency,4],
    [options.leaseSeconds,300],[options.runBudgetMs,60000],[options.reservedBytesPerConsumer,Number.MAX_SAFE_INTEGER],[options.reservedBytesPerScan,Number.MAX_SAFE_INTEGER]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid bounded PostgreSQL recovery options');
  }
  if (control.deadline && (control.deadline.budgetMs !== options.runBudgetMs || control.now !== undefined))
    throw new TypeError('Recovery invocation deadline must be the single run clock');
  if (control.deadline &&
    (client.raw as { recoveryStatementDeadlineFence?: string }).recoveryStatementDeadlineFence !== POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE)
    throw new TypeError('Recovery statement deadline driver required');
  const signal = control.signal, now = control.now ?? (() => performance.now());
  const start = control.deadline ? 0 : now();
  if (!control.deadline && (!Number.isFinite(start) || start < 0 || start > Number.MAX_SAFE_INTEGER-options.runBudgetMs))
    throw new TypeError('Invalid recovery clock');
  let lastTick = start, databaseUnconfirmed = false;
  const result: PostgresRecoveryRunResult = { discovered:0,registered:0,scanned:0,claimed:0,committed:0,blocked:0,deferred:0,
    lostOwnership:0,uncertain:0,skipped:0,leasesLeftForExpiry:0,capacityLimited:false,admissionStopped:false,stopReason:null,resources:'confirmed',retainedHolds:0 };
  let settled = false, observationClaimed = false;
  function stop(reason: Stop): void { if (!settled) { result.admissionStopped = true; result.stopReason ??= reason; } }
  function stopped(): boolean {
    if (result.admissionStopped) return true;
    if (signal?.aborted) { stop('aborted'); return true; }
    if (control.deadline) {
      const deadline = control.deadline.snapshot();
      if (deadline.status !== 'open') stop(deadline.status === 'clock_invalid' ? 'clock_invalid' : 'budget');
      return result.admissionStopped;
    }
    let tick: number;
    try { tick = now(); } catch { stop('clock_invalid'); return true; }
    if (!Number.isFinite(tick) || tick < lastTick || tick > Number.MAX_SAFE_INTEGER) stop('clock_invalid');
    else { lastTick = tick; if (tick-start >= options.runBudgetMs) stop('budget'); }
    return result.admissionStopped;
  }
  type OwnedLane = { hold: { release(): void }; owner: ReturnType<typeof ownPostgresRecoveryOperations>; released: boolean };
  type FailedOwnerLane = { hold: { release(): void }; owner: null; released: false };
  const lanes: (OwnedLane | FailedOwnerLane)[] = [];
  type ActiveScan = ReturnType<OwnedLane['owner']['ownedRecoveryScan']>;
  let activeScan: ActiveScan | null = null;
  function acquire(bytes: number): OwnedLane | null {
    const hold = capacity.tryAcquire(bytes);
    if (!hold) { result.capacityLimited = true; return null; }
    let owner: ReturnType<typeof ownPostgresRecoveryOperations>;
    try { owner = ownPostgresRecoveryOperations(client, () => { databaseUnconfirmed = true; stop('database_unconfirmed'); }, control.deadline); }
    catch {
      // The hold already exists, but a failed owner constructor cannot certify
      // whether a custom driver allocated a resource. Keep it visible/held.
      lanes.push({ hold, owner: null, released: false });
      databaseUnconfirmed = true; stop('database_unconfirmed');
      return null;
    }
    const lane = { hold, released: false, owner };
    lanes.push(lane);return lane;
  }
  async function recordFailure(lane: OwnedLane, lease: PostgresRecoveryLease, reason: PostgresRecoveryFailure): Promise<void> {
    // Never issue a failure write while the previous transaction/callback may still be active.
    // Known leases after run stop may expire naturally; neither expiry nor this count is refund.
    if (lane.owner.unconfirmed() || databaseUnconfirmed) { result.leasesLeftForExpiry++; return; }
    try {
      const status = await createUsageRecoveryJobsPostgres(lane.owner.client).fail(lease, reason);
      if (status === 'not_owned') result.lostOwnership++; else result[status]++;
    } catch { result.uncertain++; result.leasesLeftForExpiry++; }
  }
  async function execute(): Promise<PostgresRecoveryRunResult> {
    try {
      if (stopped()) return result;
      const scan = acquire(options.reservedBytesPerScan);
      if (!scan) return result;
      const consumers: OwnedLane[] = [];
      for (let i=0;i<Math.min(options.concurrency,options.maxItems);i++) {
        if (stopped()) break;
        const lane = acquire(options.reservedBytesPerConsumer);if (!lane) break;consumers.push(lane);
      }
      if (!consumers.length || stopped()) return result;
      // Only the two repository-owned, bounded SELECT scans use the opt-in
      // transport. Registration, claim, settlement and failure writes retain
      // their ordinary owner/transaction path and are never auto-cancelled.
      const discovery = createUsageRecoveryJobsPostgres(scan.owner.client, ownedScans ? {
        scan(kind, scope, limit) {
          if (activeScan) throw new Error('Controlled recovery scan already active');
          const statement = scan.owner.ownedRecoveryScan(kind, scope, limit);
          activeScan = statement;
          return statement.completion.finally(() => { if (activeScan === statement) activeScan = null; });
        },
      } : undefined);
      // Registration is restartable from a full bounded anti-join; no permanent high-water mark.
      try {
        const missing = await discovery.scanUnregistered(options.scope, options.maxRegistrations);
        result.discovered = missing.length;
        for (let i=0;i<missing.length && !stopped();i++) {
          try { await discovery.ensure(missing[i]); result.registered++; }
          catch { result.uncertain++; stop('registration_failed'); break; }
        }
        // Drop the first bounded reference list before allocating the due list.
        missing.length = 0;
      } catch { result.uncertain++; stop('scan_failed'); }
      if (stopped()) return result;
      let candidates: PostgresRecoveryCandidate[];
      try { candidates = await discovery.scanDue(options.scope, options.maxItems); }
      catch { result.uncertain++; stop('scan_failed'); return result; }
      result.scanned = candidates.length;
      let cursor = 0;
      async function consume(lane: OwnedLane): Promise<void> {
        const jobs = createUsageRecoveryJobsPostgres(lane.owner.client), settlements = createUsageSettlementRepositoryPostgres(lane.owner.client);
        try {
          while (!stopped() && cursor < candidates.length) {
            const candidate = candidates[cursor++];
            let claim;
            try { claim = await jobs.claim(candidate, options.leaseSeconds); }
            catch { result.uncertain++; continue; }
            if (claim.status === 'not_claimed') { result.skipped++; continue; }
            if (claim.status === 'exhausted') { result.blocked++; continue; }
            result.claimed++;
            if (stopped()) { await recordFailure(lane,claim.lease,'interrupted'); break; }
            try { await settlements.commit(claim.lease.ref,claim.lease.proof); result.committed++; }
            catch (error) {
              result.uncertain += lane.owner.unconfirmed() ? 1 : 0;
              await recordFailure(lane,claim.lease,error instanceof SettlementSnapshotInvalidError ? 'snapshot_invalid'
                : error instanceof SettlementConflictError ? 'settlement_conflict' : 'execution_error');
            }
          }
        } catch { result.uncertain++; stop('consumer_failed'); }
      }
      // Wait every started consumer, then each owner's detached driver callbacks/SQL below.
      await Promise.allSettled(consumers.map(consume));
      candidates.length = 0;
      return result;
    } finally {
      // Draining one stalled lane must not prevent observing another lane's rejection. No race,
      // timeout, TTL-based release, or implicit successful cancellation.
      await Promise.allSettled(lanes.map(async lane => {
        if (!lane.owner) { result.resources = 'unconfirmed'; result.retainedHolds++; return; }
        const completion = await lane.owner.drain();
        if (completion !== 'confirmed') { result.resources = 'unconfirmed'; result.retainedHolds++; return; }
        try { lane.hold.release(); lane.released = true; }
        catch { result.resources = 'unconfirmed'; result.retainedHolds++; }
      }));
      settled = true;
    }
  }
  // Keep the returned legacy-style result separate from authoritative observer state.
  const completion = execute().then(value => ({ ...value }));
  // Observe failures immediately; preserve the same rejected promise for its caller.
  void completion.catch(() => undefined);
  return Object.freeze({
    completion,
    /** Explicit diagnostic cancellation of only the current fixed read scan.
     * No active scan means no cancellation and no change to lane certainty.
     * Observation deadlines do not call this method automatically.
     */
    cancelActiveScan() {
      return ownedScans && activeScan ? activeScan.cancel() : null;
    },
    claimObservation() {
      if (observationClaimed) throw new Error('Recovery run already has an observation owner');
      observationClaimed = true;
    },
    stopAdmission: (reason: 'aborted' | 'observation_deadline' | 'clock_invalid') => stop(reason),
    snapshot() {
      const pending = { statement: 0, transaction: 0, callback: 0 };
      let cancellationRequested = false;
      for (const lane of lanes) {
        if (!lane.owner) continue;
        const current = lane.owner.snapshot();
        for (const kind of ['statement', 'transaction', 'callback'] as const) pending[kind] += current[kind];
        cancellationRequested ||= current.cancellation.requested > 0;
      }
      return Object.freeze({
        settled, heldLanes: lanes.filter(lane => !lane.released).length,
        uncertainLanes: lanes.filter(lane => !lane.owner || lane.owner.unconfirmed()).length,
        resources: !settled ? 'pending' as const : result.resources,
        pending: Object.freeze(pending), result: Object.freeze({ ...result, resources: !settled ? 'pending' as const : result.resources }),
        // None of the local promise/hold observations prove a server cancel or socket close.
        cancellation: cancellationRequested ? 'requested' as const : 'not_requested' as const,
        physicalClose: 'not_observed' as const,
      });
    },
  });
}
