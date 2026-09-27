export type PostgresRecoveryDeadlineStatus = 'open' | 'expired' | 'clock_invalid';

export type PostgresRecoveryDeadlineSnapshot = Readonly<{
  status: PostgresRecoveryDeadlineStatus;
  /** Integer milliseconds left; zero is never a usable PostgreSQL timeout. */
  remainingMs: number;
}>;

export type PostgresRecoveryInvocationDeadline = Readonly<{
  budgetMs: number;
  snapshot(): PostgresRecoveryDeadlineSnapshot;
}>;

/** One monotonic, non-renewable invocation budget. This is an admission gate,
 * not a server SQL timeout or a receipt that already-started work has ended.
 */
export function createPostgresRecoveryInvocationDeadline(
  budgetMs: number,
  now: () => number = () => performance.now(),
): PostgresRecoveryInvocationDeadline {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000 || typeof now !== 'function')
    throw new TypeError('Invalid PostgreSQL recovery invocation budget');
  let initial: number;
  try { initial = now(); }
  catch { throw new TypeError('Invalid PostgreSQL recovery invocation clock'); }
  if (!Number.isFinite(initial) || initial < 0 || initial > Number.MAX_SAFE_INTEGER - budgetMs)
    throw new TypeError('Invalid PostgreSQL recovery invocation clock');
  const expiresAt = initial + budgetMs;
  let last = initial;
  let terminal: Exclude<PostgresRecoveryDeadlineStatus, 'open'> | null = null;
  return Object.freeze({
    budgetMs,
    snapshot(): PostgresRecoveryDeadlineSnapshot {
      if (terminal) return Object.freeze({ status: terminal, remainingMs: 0 });
      let current: number;
      try { current = now(); }
      catch { terminal = 'clock_invalid'; return Object.freeze({ status: terminal, remainingMs: 0 }); }
      if (!Number.isFinite(current) || current < last || current > Number.MAX_SAFE_INTEGER) {
        terminal = 'clock_invalid'; return Object.freeze({ status: terminal, remainingMs: 0 });
      }
      last = current;
      const remainingMs = Math.floor(expiresAt - current);
      if (remainingMs < 1) {
        terminal = 'expired'; return Object.freeze({ status: terminal, remainingMs: 0 });
      }
      return Object.freeze({ status: 'open', remainingMs });
    },
  });
}
