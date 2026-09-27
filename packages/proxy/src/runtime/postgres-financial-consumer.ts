import { drizzle } from 'drizzle-orm/postgres-js';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import { pgCoreSchema } from '../../../core/src/storage/drizzle/schema.pg';
import {
	runUsageRecoveryPostgres,
	type PostgresRecoveryRunOptions,
	type PostgresRecoveryRunResult,
} from '../../../core/src/storage/recovery/run-usage-recovery-postgres';
import { ownPostgresRecoveryScope } from '../../../core/src/storage/recovery/usage-recovery-jobs-postgres';

export const FINANCIAL_RECOVERY_ROLE = 'cinatoken_gateway_financial_recovery_consumer';

type PgQuery = {
	unsafe<T extends unknown[] = Record<string, unknown>[]>(
		query: string, params?: readonly unknown[],
	): PromiseLike<T> & { values(): PromiseLike<unknown> };
};
type PgRoot = PgQuery & {
	options: PostgresDatabaseClient['raw']['options'];
	begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T>;
};
type Capacity = { tryAcquire(bytes: number): { release(): void } | null };

class RecoveryAuthorityError extends Error {
	constructor(message: string) { super(message); this.name = 'RecoveryAuthorityError'; }
}

async function requireRecoveryRole(query: PgQuery): Promise<void> {
	// pg_settings.setting is normalized to its implicit unit. Requiring the
	// database-user source rejects later session SET/client overrides. It does
	// not independently prove the originally authenticated credential: a
	// superuser can change session authorization, so origin provisioning and
	// credential custody remain separate requirements.
	const rows = await query.unsafe<{
		current_role: unknown; session_role: unknown;
		transaction_timeout_ms: unknown; statement_timeout_ms: unknown;
		lock_timeout_ms: unknown; idle_transaction_timeout_ms: unknown;
	}[]>(
		`SELECT current_user AS current_role, session_user AS session_role,
		  (SELECT setting FROM pg_catalog.pg_settings WHERE name='transaction_timeout'
		    AND unit='ms' AND source='database user') AS transaction_timeout_ms,
		  (SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout'
		    AND unit='ms' AND source='database user') AS statement_timeout_ms,
		  (SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout'
		    AND unit='ms' AND source='database user') AS lock_timeout_ms,
		  (SELECT setting FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'
		    AND unit='ms' AND source='database user') AS idle_transaction_timeout_ms`,
	);
	function bounded(value: unknown, maximum: number): boolean {
		return typeof value === 'string' && /^(?:[1-9][0-9]{0,8})$/u.test(value)
			&& Number(value) <= maximum;
	}
	if (!Array.isArray(rows) || rows.length !== 1 ||
		rows[0]?.current_role !== FINANCIAL_RECOVERY_ROLE || rows[0]?.session_role !== FINANCIAL_RECOVERY_ROLE ||
		!bounded(rows[0]?.transaction_timeout_ms, 30_000) ||
		!bounded(rows[0]?.statement_timeout_ms, 15_000) ||
		!bounded(rows[0]?.lock_timeout_ms, 5_000) ||
		!bounded(rows[0]?.idle_transaction_timeout_ms, 10_000)) {
		throw new RecoveryAuthorityError('Dedicated PostgreSQL recovery login and server deadlines required');
	}
}

/** Internal adapter: the check and each statement run inside one postgres.js session. */
export function createRoleCheckedRecoveryClient(client: PostgresDatabaseClient): PostgresDatabaseClient {
	if (client?.driver !== 'postgres' || !client.raw) throw new TypeError('PostgreSQL recovery client required');
	const source = client.raw as unknown as PgRoot;
	if (typeof source.begin !== 'function' || typeof source.unsafe !== 'function'
		|| !source.options?.parsers || !source.options?.serializers)
		throw new TypeError('PostgreSQL recovery transaction client required');
	const raw: PgRoot = {
		options: source.options,
		unsafe<T extends unknown[] = Record<string, unknown>[]>(query: string, params?: readonly unknown[]) {
			const ownedParams = params === undefined ? undefined : [...params];
			let execution: Promise<T> | undefined;
			let form: 'rows' | 'values' | undefined;
			function execute(requested: 'rows' | 'values'): Promise<T> {
				if (form !== undefined && form !== requested) return Promise.reject(new TypeError('Recovery query result form changed'));
				form = requested;
				return execution ??= source.begin(async tx => {
					await requireRecoveryRole(tx);
					const statement = tx.unsafe<T>(query, ownedParams);
					return await (requested === 'values' ? statement.values() : statement) as T;
				});
			}
			return {
				then<TResult1 = T, TResult2 = never>(
					yes?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
					no?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
				): Promise<TResult1 | TResult2> { return execute('rows').then(yes, no); },
				values: () => execute('values'),
			} as PromiseLike<T> & { values(): PromiseLike<unknown> };
		},
		begin<T>(run: (tx: PgQuery) => Promise<T>): Promise<T> {
			return source.begin(async tx => {
				await requireRecoveryRole(tx);
				return run(tx);
			});
		},
	};
	return {
		driver: 'postgres',
		raw: raw as unknown as PostgresDatabaseClient['raw'],
		drizzle: drizzle(raw as unknown as PostgresDatabaseClient['raw'], { schema: pgCoreSchema }),
	};
}

function ownLimits(input: PostgresRecoveryRunOptions): PostgresRecoveryRunOptions {
	if (!input || typeof input !== 'object') throw new TypeError('Explicit PostgreSQL recovery limits required');
	const scope = ownPostgresRecoveryScope(input.scope);
	const limits = Object.freeze({
		scope,
		maxRegistrations: input.maxRegistrations,
		maxItems: input.maxItems,
		concurrency: input.concurrency,
		leaseSeconds: input.leaseSeconds,
		runBudgetMs: input.runBudgetMs,
		reservedBytesPerConsumer: input.reservedBytesPerConsumer,
		reservedBytesPerScan: input.reservedBytesPerScan,
	});
	for (const [value, maximum] of [
		[limits.maxRegistrations, 50], [limits.maxItems, 50], [limits.concurrency, 4],
		[limits.leaseSeconds, 300], [limits.runBudgetMs, 60_000],
		[limits.reservedBytesPerConsumer, Number.MAX_SAFE_INTEGER],
		[limits.reservedBytesPerScan, Number.MAX_SAFE_INTEGER],
	]) {
		if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
			throw new TypeError('Invalid bounded PostgreSQL recovery limits');
	}
	return limits;
}

export type PostgresFinancialConsumerOutcome =
	| Readonly<{ status: 'disabled' | 'already_used'; queueAckSafe: false }>
	| Readonly<{ status: 'open_failed'; queueAckSafe: false; clientReturned: false; resourceState: 'unknown' }>
	| Readonly<{ status: 'shared_authority'; queueAckSafe: false; clientDisposition: 'belongs_to_other_owner' }>
	| Readonly<{ status: 'invalid_client'; queueAckSafe: false; locallyRetainedClient: boolean }>
	| Readonly<{ status: 'authority_rejected' | 'outcome_unknown'; queueAckSafe: false;
		/** A JS reference held by this one-shot object, not a socket/server lifecycle receipt. */
		locallyRetainedClient: true; result?: PostgresRecoveryRunResult }>
	| Readonly<{ status: 'run_drained' | 'bounded_incomplete'; queueAckSafe: false;
		physicalClose: 'not_observed'; result: PostgresRecoveryRunResult }>;

export type PostgresFinancialConsumerDependencies = Readonly<{
	/** Explicit local candidate switch. Constructing the consumer enables nothing. */
	enabled?: boolean;
	/** The currently composed request and producer authorities, used to reject pool reuse. */
	runtime: PostgresDatabaseClient;
	dispatchProducer: PostgresDatabaseClient;
	factProducer: PostgresDatabaseClient;
	/** Must return a new invocation-private, dedicated recovery-login client. */
	openInvocationClient(): Promise<PostgresDatabaseClient>;
	/** Called only after the single runner completion confirms all local operations drained. */
	retireConfirmedClient(client: PostgresDatabaseClient): Promise<void>;
	capacity: Capacity;
	limits: PostgresRecoveryRunOptions;
}>;

/**
 * Default-disabled, one-shot local composition of the existing bounded financial runner.
 * This is not a Queue handler or a production connection factory. No outcome here grants
 * Queue ACK authority: cross-isolate exclusion, retry/DLQ, server deadlines and physical
 * close evidence remain separate gates. An unconfirmed client is deliberately retained.
 */
export function createPostgresFinancialConsumer(input: PostgresFinancialConsumerDependencies) {
	if (!input || typeof input !== 'object') throw new TypeError('PostgreSQL financial consumer dependencies required');
	if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new TypeError('Invalid consumer enable switch');
	if (typeof input.openInvocationClient !== 'function' || typeof input.retireConfirmedClient !== 'function'
		|| typeof input.capacity?.tryAcquire !== 'function') throw new TypeError('Explicit recovery owner and capacity required');
	const limits = ownLimits(input.limits);
	const forbidden = [input.runtime, input.dispatchProducer, input.factProducer];
	if (forbidden.some(client => client?.driver !== 'postgres' || !client.raw))
		throw new TypeError('Distinct PostgreSQL request and producer authorities required');
	let used = false;
	// Keep an unconfirmed private client reachable for the lifetime of this one-shot
	// owner. This is only local retention, never physical close or server-stop proof.
	let retainedClient: PostgresDatabaseClient | null = null;
	return Object.freeze({
		snapshot: () => Object.freeze({ used, retainedClient: retainedClient !== null }),
		async runOnce(): Promise<PostgresFinancialConsumerOutcome> {
			if (input.enabled !== true) return Object.freeze({ status: 'disabled', queueAckSafe: false });
			if (used) return Object.freeze({ status: 'already_used', queueAckSafe: false });
			used = true;
			let client: PostgresDatabaseClient;
			try { client = await input.openInvocationClient(); }
			catch { return Object.freeze({ status: 'open_failed', queueAckSafe: false,
				clientReturned: false, resourceState: 'unknown' }); }
			if (forbidden.some(value => value === client || value.raw === client?.raw))
				return Object.freeze({ status: 'shared_authority', queueAckSafe: false,
					clientDisposition: 'belongs_to_other_owner' });
			if (client?.driver !== 'postgres' || !client.raw) {
				retainedClient = client ?? null;
				return Object.freeze({ status: 'invalid_client', queueAckSafe: false,
					locallyRetainedClient: retainedClient !== null });
			}
			retainedClient = client;
			const raw = client.raw as unknown as PgRoot;
			try {
				// This preflight fails before acquiring any runner capacity. Every subsequent
				// query/transaction checks again on its own session.
				await raw.begin(async tx => { await requireRecoveryRole(tx); });
			} catch (error) {
				return Object.freeze({ status: error instanceof RecoveryAuthorityError ? 'authority_rejected' : 'outcome_unknown',
					queueAckSafe: false, locallyRetainedClient: true });
			}
			let result: PostgresRecoveryRunResult;
			try { result = await runUsageRecoveryPostgres(createRoleCheckedRecoveryClient(client), limits, input.capacity); }
			catch { return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true }); }
			if (result.resources !== 'confirmed' || result.retainedHolds !== 0 || result.uncertain !== 0
				|| result.leasesLeftForExpiry !== 0) {
				return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true, result });
			}
			try { await input.retireConfirmedClient(client); retainedClient = null; }
			catch { return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true, result }); }
			const incomplete = result.capacityLimited || result.admissionStopped || result.stopReason !== null ||
				result.blocked !== 0 || result.deferred !== 0 || result.lostOwnership !== 0 || result.skipped !== 0 ||
				result.registered !== result.discovered || result.claimed !== result.scanned || result.committed !== result.claimed;
			return Object.freeze({ status: incomplete ? 'bounded_incomplete' : 'run_drained', queueAckSafe: false,
				physicalClose: 'not_observed', result });
		},
	});
}
