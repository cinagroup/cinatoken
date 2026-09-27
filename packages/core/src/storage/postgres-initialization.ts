type InitializationStage = 'session' | 'repositories' | 'worker_decoration';
type CleanupOutcome = 'confirmed' | 'unconfirmed';

/** Constructed only after the owned client's close attempt terminates. No raw
 * driver error/cause is retained: it may contain a DSN, credentials or SQL. */
class PostgresInitializationError extends Error {
	/** Canonical safe category, not a copy of the driver's raw message or code. */
	readonly code: 'CONNECTION_CLOSED' | undefined;
	constructor(readonly stage: InitializationStage, readonly cleanup: CleanupOutcome, transientConnection: boolean) {
		super(`PostgreSQL initialization failed (${stage}); cleanup ${cleanup}`);
		this.name = 'PostgresInitializationError';
		this.code = transientConnection ? 'CONNECTION_CLOSED' : undefined;
	}
}

/** Structural lookalikes and arbitrary resolver failures are not close receipts. */
export function postgresInitializationCleanup(error: unknown): CleanupOutcome | null {
	return error instanceof PostgresInitializationError ? error.cleanup : null;
}

/** Guard only clients not yet published to any consumer or shared pool. Never
 * wrap business queries: their ambiguous commit/settlement state is separate. */
export async function withUnpublishedPostgresClient<T>(
	client: { end(options: { timeout: number }): Promise<void> },
	stage: InitializationStage,
	initialize: () => T | Promise<T>,
): Promise<T> {
	try { return await initialize(); }
	catch (error) {
		let cleanup: CleanupOutcome = 'unconfirmed';
		try { await client.end({ timeout: 1 }); cleanup = 'confirmed'; }
		catch { /* Closing failed; no retry, no implicit resource confirmation. */ }
		// Preserve existing unavailable-vs-internal-error classification without
		// leaking the original error. Even a throwing getter cannot skip closure.
		let transientConnection = false;
		try { transientConnection = isTransientPostgresConnectionError(error); }
		catch { /* Unreadable errors remain the safe generic category. */ }
		throw new PostgresInitializationError(stage, cleanup, transientConnection);
	}
}
import { isTransientPostgresConnectionError } from './postgres-connection-error';
