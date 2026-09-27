import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresDatabaseClient } from '../database-client';
import { pgCoreSchema } from '../drizzle/schema.pg';
import { postgresRecoveryScan, type PostgresRecoveryScanKind, type PostgresRecoveryScope } from './usage-recovery-jobs-postgres';
import type { PostgresRecoveryInvocationDeadline } from './postgres-recovery-invocation-deadline';

type Raw = {
  options: PostgresDatabaseClient['raw']['options'];
  ownedCancellation?: string;
  ownedRecoveryScanFence?: string;
  ownedRecoveryDeadlineFence?: string;
  recoveryStatementDeadlineFence?: string;
  unsafe(query: string, params?: readonly unknown[], options?:
    { owned_cancel: true; admission_deadline?: PostgresRecoveryInvocationDeadline } |
    { recovery_admission_deadline: PostgresRecoveryInvocationDeadline }): PromiseLike<unknown> & {
    values(): PromiseLike<unknown>;
    cancelOwned?(): OwnedCancellationHandle;
  };
};
type Root = Raw & { begin<T>(run: (tx: Raw) => Promise<T>): Promise<T> };
type OperationKind = 'statement' | 'transaction' | 'callback';
type OwnedCancellationHandle = Readonly<{
  result: PromiseLike<Readonly<{ status: string }>>;
  transportClosed: PromiseLike<Readonly<{ status: string }>>;
  transportRawClosed: PromiseLike<Readonly<{ status: string }>>;
  primaryCloseObserved: PromiseLike<Readonly<{ status: string }>>;
  primaryRawClosed: PromiseLike<Readonly<{ status: string }>>;
  snapshot(): Readonly<{ result: string; transportClose: string; transportRawClose: string; primaryClose: string; primaryRawClose: string }>;
}>;
export const POSTGRES_RECOVERY_SCAN_FENCE = 'postgres-js-3.4.9-owned-scan-v307';
export const POSTGRES_RECOVERY_DEADLINE_FENCE = 'postgres-js-3.4.9-owned-scan-deadline-v311';
export const POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE = 'postgres-js-3.4.9-recovery-statement-deadline-v312';

/** Internal narrow adapter for these repositories only, not a general postgres.js replacement.
 * ACTIVATION BLOCKED: the installed postgres.js 3.4.9 loopback onclose test still raises
 * socket=null in driver-internal rollback/nextWrite after the callback ends. Owning/rejecting
 * callback SQL is not enough to stop that internal continuation. Do not enable this adapter
 * merely because the default-disabled v300 Node candidate passes; Workers and full DB
 * lifecycle gates remain open. Do not hide failures by closing the caller's shared pool.
 * Normal non-streaming unsafe/values success observes ReadyForQuery in the installed driver.
 * Any driver rejection is conservatively unconfirmed; an error code or later read is NOT a
 * cleanup receipt. Never close/cancel the caller's shared pool. Runtime recovery of retained
 * logical capacity requires separate authoritative evidence and is not provided here.
 */
function createPostgresRecoveryOperationOwner(base: PostgresDatabaseClient, onUnconfirmed: () => void,
  deadline?: PostgresRecoveryInvocationDeadline) {
  if (base.driver !== 'postgres') throw new TypeError('PostgreSQL recovery authority required');
  if (deadline && (base.raw as Raw).recoveryStatementDeadlineFence !== POSTGRES_RECOVERY_STATEMENT_DEADLINE_FENCE)
    throw new TypeError('Recovery statement deadline driver required');
  const pending = new Set<Promise<void>>();
  const counts: Record<OperationKind, number> = { statement: 0, transaction: 0, callback: 0 };
  const cancellation = { requested: 0, resultPending: 0, closePending: 0, transportRawClosePending: 0, primaryClosePending: 0, primaryRawClosePending: 0 };
  let sealed = false, drained = false, unconfirmed = false;
  function uncertain(): void {
    if (unconfirmed) return;
    unconfirmed = true;
    onUnconfirmed();
  }
  // The local owner check runs before each new call. The default-disabled
  // candidate also checks tagged Queries at their final wire-dispatch gate.
  function requireAdmission(): void {
    if (!deadline) return;
    let snapshot: ReturnType<PostgresRecoveryInvocationDeadline['snapshot']>;
    try { snapshot = deadline.snapshot(); }
    catch { throw new Error('Recovery invocation clock invalid before SQL admission'); }
    if (snapshot.status === 'open' && Number.isSafeInteger(snapshot.remainingMs) && snapshot.remainingMs >= 1) return;
    throw new Error(snapshot.status === 'expired'
      ? 'Recovery invocation budget expired before SQL admission'
      : 'Recovery invocation clock invalid before SQL admission');
  }
  function track<T>(operation: () => PromiseLike<T> | T, kind: OperationKind): Promise<T> {
    if (sealed) return Promise.reject(new Error('Recovery operation owner is sealed'));
    // Register before invoking the driver/callback, including synchronous throw paths.
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    pending.add(done);
    counts[kind]++;
    return (async () => {
      try { return await operation(); }
      catch (error) { if (kind !== 'callback') uncertain(); throw error; }
      finally { counts[kind]--; pending.delete(done); finish(); }
    })();
  }
  function registerCancellation(promise: PromiseLike<unknown>, kind: 'resultPending' | 'closePending' | 'transportRawClosePending' | 'primaryClosePending' | 'primaryRawClosePending'): void {
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    pending.add(done);
    cancellation[kind]++;
    // Both terminal paths belong to the owner. A result rejection does not complete
    // the auxiliary socket, and neither event confirms the primary SQL was stopped.
    void Promise.resolve(promise).then(
      () => { cancellation[kind]--; pending.delete(done); finish(); },
      () => { uncertain(); cancellation[kind]--; pending.delete(done); finish(); },
    );
  }
  function adapt(raw: Raw, active: () => boolean = () => true): Raw {
    return {
      options: raw.options,
      unsafe(query, params = []) {
        let operation: Promise<unknown> | undefined;
        const execute = (arrays: boolean) => operation ??= (() => {
          if (!active()) return Promise.reject(new Error('Recovery transaction callback no longer owns SQL admission'));
          try { requireAdmission(); }
          catch (error) { return Promise.reject(error); }
          if (!active()) return Promise.reject(new Error('Recovery transaction callback no longer owns SQL admission'));
          return track(() => {
            const q = raw.unsafe(query, params, deadline ? { recovery_admission_deadline: deadline } : undefined);
            return arrays ? q.values() : q;
          }, 'statement');
        })();
        return { then: (yes, no) => execute(false).then(yes, no), values: () => execute(true) };
      },
    };
  }
  const source = base.raw as unknown as Root;
  /** Explicit experimental entry for controlled non-streaming recovery SQL only.
   * The installed driver lacks cancelOwned, so reject before dispatch. A cancellation
   * makes the lane unconfirmed even if its primary query succeeds; a separate DBL-06
   * receipt is required to release that capacity.
   */
  function ownedStatement<T = unknown>(query: string, params: readonly unknown[] = [], scanDeadline?: PostgresRecoveryInvocationDeadline) {
    if (sealed) throw new Error('Recovery operation owner is sealed');
    requireAdmission();
    if (sealed) throw new Error('Recovery operation owner is sealed');
    if (source.ownedCancellation !== 'postgres-js-3.4.9-owned-cancel-v302')
      throw new TypeError('Owned cancellation driver required');
    if (scanDeadline && source.ownedRecoveryDeadlineFence !== POSTGRES_RECOVERY_DEADLINE_FENCE)
      throw new TypeError('Owned recovery scan deadline driver required');
    let q: ReturnType<Raw['unsafe']> | undefined;
    // Query construction itself belongs to the lane: a synchronous socket/
    // factory failure cannot escape ownership and allow capacity to release.
    const completion = track(() => {
      q = source.unsafe(query, [...params], scanDeadline
        ? { owned_cancel: true, admission_deadline: scanDeadline }
        : { owned_cancel: true });
      if (typeof q.cancelOwned !== 'function') throw new TypeError('Owned cancellation driver required');
      return q;
    }, 'statement') as Promise<T>;
    void completion.catch(() => undefined);
    let handle: OwnedCancellationHandle | undefined;
    let cancellationAttempted = false;
    const cancelFailure = Object.assign(new Error('Cancellation transport failed'), { code: 'CANCEL_TRANSPORT_FAILED' as const });
    return Object.freeze({
      completion,
      cancel(): OwnedCancellationHandle {
        if (handle) return handle;
        if (cancellationAttempted) throw cancelFailure;
        if (drained) throw new Error('Recovery operation owner has already drained');
        if (!q || typeof q.cancelOwned !== 'function') throw new TypeError('Owned cancellation driver required');
        // The driver may have sent a cancel request before returning its handle.
        // Sticky uncertainty prevents a later successful SQL result from releasing
        // this lane on the strength of cancel transport observations alone.
        cancellationAttempted = true;
        uncertain();
        cancellation.requested++;
        try {
          const value = q.cancelOwned();
          if (!value || !value.result || !value.transportClosed || !value.transportRawClosed || !value.primaryCloseObserved || !value.primaryRawClosed || typeof value.snapshot !== 'function')
            throw cancelFailure;
          registerCancellation(value.result, 'resultPending');
          registerCancellation(value.transportClosed, 'closePending');
          registerCancellation(value.transportRawClosed, 'transportRawClosePending');
          registerCancellation(value.primaryCloseObserved, 'primaryClosePending');
          registerCancellation(value.primaryRawClosed, 'primaryRawClosePending');
          handle = value;
          return handle;
        } catch { throw cancelFailure; }
      },
    });
  }
  /** The run-level opt-in path never accepts caller SQL or Query mode. Both exact SQL
   * templates and bound arguments come from the recovery repository's closed catalog.
   * The legacy experimental ownedStatement remains for protocol diagnostics only.
   */
  function ownedRecoveryScan(kind: PostgresRecoveryScanKind, scope: PostgresRecoveryScope, limit: number) {
    if (source.ownedRecoveryScanFence !== POSTGRES_RECOVERY_SCAN_FENCE)
      throw new TypeError('Owned recovery scan driver required');
    const spec = postgresRecoveryScan(kind, scope, limit);
    return ownedStatement<unknown[]>(spec.query, spec.params, deadline);
  }
  const raw: Root = {
    ...adapt(source),
    begin<T>(run: (tx: Raw) => Promise<T>): Promise<T> {
      try { requireAdmission(); }
      catch (error) { return Promise.reject(error); }
      let active = true;
      return track(() => source.begin(tx => {
        if (!active) throw new Error('Recovery transaction callback started after ownership ended');
        // postgres.js begin races scope(fn) against connection.onclose. Own the callback
        // separately: outer rejection cannot drain or release a still-running callback.
        return track(() => run(adapt(tx, () => active)), 'callback');
      }), 'transaction').finally(() => { active = false; });
    },
  };
  const client: PostgresDatabaseClient = {
    driver: 'postgres', raw: raw as unknown as PostgresDatabaseClient['raw'],
    drizzle: drizzle(raw as unknown as PostgresDatabaseClient['raw'], { schema: pgCoreSchema }),
  };
  return {
    client,
    ownedStatement,
    ownedRecoveryScan,
    unconfirmed: () => unconfirmed,
    pending: () => pending.size,
    /** Local ownership only: a registered statement may still be in a driver/pool queue.
     * These counts do not expose SQL/parameters or assert remote dispatch/cancellation.
     */
    snapshot: () => Object.freeze({ ...counts, cancellation: Object.freeze({ ...cancellation }), sealed, unconfirmed }),
    /** Call only after all high-level consumers have stopped issuing operations. Sealing
     * blocks a late detached callback from starting another SQL, but does not cancel its
     * already-started work. This may remain pending; no wall-clock completion guarantee.
     */
    async drain(): Promise<'confirmed' | 'unconfirmed'> {
      sealed = true;
      // An admitted statement may register its cancellation while drain is waiting.
      // Recheck the set after every wave, then close the cancel admission boundary.
      while (pending.size) await Promise.all([...pending]);
      drained = true;
      return unconfirmed ? 'unconfirmed' : 'confirmed';
    },
  };
}

/** Production-facing internal owner surface. Deliberately do not return the
 * arbitrary-SQL cancellation probe; only the repository's fixed recovery scans
 * may reach that implementation through its private closure.
 */
export function ownPostgresRecoveryOperations(base: PostgresDatabaseClient, onUnconfirmed: () => void,
  deadline?: PostgresRecoveryInvocationDeadline) {
  const owner = createPostgresRecoveryOperationOwner(base, onUnconfirmed, deadline);
  return {
    client: owner.client,
    ownedRecoveryScan: owner.ownedRecoveryScan,
    unconfirmed: owner.unconfirmed,
    pending: owner.pending,
    snapshot: owner.snapshot,
    drain: owner.drain,
  };
}

/** Internal protocol diagnostics only; never export from the package surface. */
export function ownPostgresRecoveryOperationsForDiagnostics(base: PostgresDatabaseClient, onUnconfirmed: () => void,
  deadline?: PostgresRecoveryInvocationDeadline) {
  return createPostgresRecoveryOperationOwner(base, onUnconfirmed, deadline);
}
