import type { DeadlineClock } from '../../request-deadline';
import type {
  PostgresRecoveryObservation as RecoveryObservation,
  PostgresRecoveryObservationProfile as RecoveryObservationProfile,
  PostgresRecoveryObservationView,
} from './postgres-observation-types';
export type {
  PostgresRecoveryObservation as RecoveryObservation,
  PostgresRecoveryObservationProfile as RecoveryObservationProfile,
} from './postgres-observation-types';

/** Internal control edge; deliberately absent from the public observation view. */
type ObservableRun = PostgresRecoveryObservationView & {
  claimObservation(): void;
  stopAdmission(reason: 'aborted' | 'observation_deadline' | 'clock_invalid'): void;
};

const CLOCK: DeadlineClock = {
  now: () => performance.now(),
  set: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Attach exactly once to an already-owned run. No driver cancel/pool close, detached retry,
 * or Workers waitUntil wiring: the caller must own completion for its full runtime lifetime.
 * observation is a frozen point-in-time report, never a substitute for completion.
 */
export function supervisePostgresRecoveryRun(
  run: ObservableRun, input: RecoveryObservationProfile,
  control: { signal?: AbortSignal; clock?: DeadlineClock } = {},
) {
  const profile = Object.freeze({ observationBudgetMs: input.observationBudgetMs, cleanupObservationMs: input.cleanupObservationMs });
  for (const value of [profile.observationBudgetMs, profile.cleanupObservationMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new TypeError('Invalid recovery observation profile');
  }
  const clock = control.clock ?? CLOCK, signal = control.signal;
  let last = clock.now();
  if (!Number.isFinite(last) || last < 0 || last > Number.MAX_SAFE_INTEGER - 120_000) throw new TypeError('Invalid recovery observation clock');
  run.claimObservation();
  const deadline = last + profile.observationBudgetMs;
  let cleanupDeadline: number | undefined, timer: unknown, timerArmed = false, terminal = false;
  let resolve!: (value: RecoveryObservation) => void;
  const observation = new Promise<RecoveryObservation>(yes => { resolve = yes; });
  function clearTimer(): void {
    if (!timerArmed) return;
    timerArmed = false;
    // A broken injected clock cannot turn an observation failure into database completion.
    try { clock.clear(timer); } catch { /* stale callback is guarded by terminal */ }
  }
  function finish(status: RecoveryObservation['status']): void {
    if (terminal) return;
    terminal = true; clearTimer(); signal?.removeEventListener('abort', abort);
    resolve(Object.freeze({ status, snapshot: run.snapshot() }));
  }
  function readTime(): number | null {
    let value: number;
    try { value = clock.now(); } catch { return null; }
    if (!Number.isFinite(value) || value < last || value > Number.MAX_SAFE_INTEGER - 120_000) return null;
    last = value; return value;
  }
  function stop(reason: 'aborted' | 'observation_deadline', time: number): void {
    run.stopAdmission(reason);
    cleanupDeadline ??= time + profile.cleanupObservationMs;
  }
  function check(): void {
    if (terminal) return;
    clearTimer();
    const time = readTime();
    if (time === null) { run.stopAdmission('clock_invalid'); finish('clock_invalid'); return; }
    // Anchor grace to the absolute deadline, not a delayed timer firing (no budget renewal).
    if (time >= deadline) stop('observation_deadline', deadline);
    if (cleanupDeadline !== undefined && time >= cleanupDeadline) { finish('observation_expired'); return; }
    const next = cleanupDeadline ?? deadline;
    try { timer = clock.set(check, Math.max(1, next - time)); timerArmed = true; }
    catch { run.stopAdmission('clock_invalid'); finish('clock_invalid'); }
  }
  function abort(): void {
    if (terminal) return;
    const time = readTime();
    if (time === null) { run.stopAdmission('clock_invalid'); finish('clock_invalid'); return; }
    stop('aborted', Math.min(time, deadline)); check();
  }
  // Register both terminal outcomes before arming timers or observing an already-aborted signal.
  void run.completion.then(() => finish('completed'), () => finish('completion_rejected'));
  if (signal?.aborted) abort();
  else { signal?.addEventListener('abort', abort, { once: true }); check(); }
  return Object.freeze({ observation, completion: run.completion, snapshot: run.snapshot });
}
