import postgres from 'postgres';
import type { GatewayBindings } from '../app';

/** A separate review-only LOGIN. The ordinary request pool cannot call this function. */
export const SHARED_KEY_USAGE_REPAIR_ROLE = 'cinatoken_gateway_shared_key_usage_repair_consumer';
export const SHARED_KEY_USAGE_REPAIR_ACTIVATION = 'reviewed-v3';

type RepairQuery = {
	unsafe<T extends Record<string, unknown>[]>(query: string, parameters?: readonly unknown[]): PromiseLike<T>;
};
export type RepairClient = {
	begin<T>(run: (tx: RepairQuery) => Promise<T>): Promise<T>;
};
export type RepairRunResult = Readonly<{
	/** Number of durably committed claims, including deferred and dead-lettered attempts. */
	processed: number;
	repaired: number;
	deferred: number;
	deadLettered: number;
	/** Server statement timeouts after a committed claim; the claim remains deferred. */
	cancelled: number;
	stale: number;
	/** A NULL claim may mean a concurrent writer owns every due key. It does not prove an empty queue. */
	stopReason: 'no_candidate' | 'item_limit' | 'admission_budget';
}>;

type RunLimits = Readonly<{
	maxItems: number;
	/** Checked before each new claim; an admitted claim is always followed by finish. */
	admissionBudgetMs: number;
}>;
const DEFAULT_LIMITS: RunLimits = Object.freeze({ maxItems: 20, admissionBudgetMs: 25_000 });

function checkedLimits(input: RunLimits): RunLimits {
	if (!Number.isSafeInteger(input?.maxItems) || input.maxItems < 1 || input.maxItems > 50 ||
		!Number.isSafeInteger(input.admissionBudgetMs) || input.admissionBudgetMs < 1 ||
		input.admissionBudgetMs > 60_000) {
		throw new TypeError('Invalid bounded shared-key usage repair limits');
	}
	return Object.freeze({ maxItems: input.maxItems, admissionBudgetMs: input.admissionBudgetMs });
}

function boundedServerMs(value: unknown, maximum: number): boolean {
	return typeof value === 'string' && /^(?:[1-9][0-9]{0,8})$/u.test(value) &&
		Number(value) <= maximum;
}

function isServerStatementTimeout(error: unknown): boolean {
	return typeof error === 'object' && error !== null &&
		'code' in error && error.code === '57014' &&
		'message' in error && error.message === 'canceling statement due to statement timeout';
}

async function requireRepairAuthority(tx: RepairQuery): Promise<void> {
	const rows = await tx.unsafe<{
		current_role: string; session_role: string;
		transaction_timeout_ms: string | null; statement_timeout_ms: string | null;
		lock_timeout_ms: string | null; idle_transaction_timeout_ms: string | null;
	}[]>(`SELECT current_user AS current_role, session_user AS session_role,
		(SELECT setting FROM pg_catalog.pg_settings WHERE name='transaction_timeout'
			AND unit='ms' AND source='database user') AS transaction_timeout_ms,
		(SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout'
			AND unit='ms' AND source='database user') AS statement_timeout_ms,
		(SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout'
			AND unit='ms' AND source='database user') AS lock_timeout_ms,
		(SELECT setting FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'
			AND unit='ms' AND source='database user') AS idle_transaction_timeout_ms`);
	const row = rows[0];
	if (rows.length !== 1 || row?.current_role !== SHARED_KEY_USAGE_REPAIR_ROLE ||
		row.session_role !== SHARED_KEY_USAGE_REPAIR_ROLE ||
		!boundedServerMs(row.transaction_timeout_ms, 30_000) ||
		!boundedServerMs(row.statement_timeout_ms, 15_000) ||
		!boundedServerMs(row.lock_timeout_ms, 5_000) ||
		!boundedServerMs(row.idle_transaction_timeout_ms, 10_000)) {
		throw new Error('Dedicated shared-key usage repair LOGIN and server deadlines required');
	}
}

/** Every attempt is one transaction: role check, then repair or durable failure state. */
export async function runSharedKeyUsageRepairClient(
	client: RepairClient,
	limits: RunLimits = DEFAULT_LIMITS,
	monotonicMs: () => number = () => performance.now(),
): Promise<RepairRunResult> {
	const ownedLimits = checkedLimits(limits);
	if (!client || typeof client.begin !== 'function') throw new TypeError('PostgreSQL repair client required');
	const startMs = monotonicMs();
	if (!Number.isFinite(startMs)) throw new TypeError('Invalid repair monotonic clock');
	let processed = 0;
	let repaired = 0;
	let deferred = 0;
	let deadLettered = 0;
	let cancelled = 0;
	let stale = 0;
	const result = (stopReason: RepairRunResult['stopReason']): RepairRunResult =>
		Object.freeze({ processed, repaired, deferred, deadLettered, cancelled, stale, stopReason });
	while (processed < ownedLimits.maxItems) {
		const elapsed = monotonicMs() - startMs;
		if (!Number.isFinite(elapsed) || elapsed < 0) throw new TypeError('Invalid repair monotonic clock');
		if (elapsed >= ownedLimits.admissionBudgetMs) {
			return result('admission_budget');
		}
		// begin resolves only after COMMIT. If its ACK is lost, no finish is sent;
		// the durable claim expires and is retried after its backoff window.
		const claim = await client.begin(async tx => {
			await requireRepairAuthority(tx);
			const rows = await tx.unsafe<{
				shared_key_id: string | null;
				claim_token: string | null;
				attempt_count: number;
			}[]>(
				'SELECT * FROM cinatoken_gateway.claim_one_shared_key_usage_repair()',
			);
			const row = rows[0];
			if (rows.length !== 1 || !row || !(
				(row.shared_key_id === null && row.claim_token === null && row.attempt_count === 0) ||
				(typeof row.shared_key_id === 'string' && row.shared_key_id.length > 0 &&
					typeof row.claim_token === 'string' &&
					/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(row.claim_token) &&
					Number.isInteger(row.attempt_count) && row.attempt_count >= 1 &&
					row.attempt_count <= 5)
			)) {
				throw new Error('Shared-key usage repair claim differs');
			}
			return row;
		});
		if (claim.shared_key_id === null || claim.claim_token === null) return result('no_candidate');
		processed += 1;
		let finishQueryPending = false;
		let finish: {
			shared_key_id: string;
			outcome: 'repaired' | 'deferred' | 'dead_lettered' | 'stale';
			attempt_count: number;
			retry_at: Date | string | null;
		};
		try {
		finish = await client.begin(async tx => {
			await requireRepairAuthority(tx);
			finishQueryPending = true;
			const rows = await tx.unsafe<{
				shared_key_id: string;
				outcome: 'repaired' | 'deferred' | 'dead_lettered' | 'stale';
				attempt_count: number;
				retry_at: Date | string | null;
			}[]>(
				'SELECT * FROM cinatoken_gateway.finish_claimed_shared_key_usage_repair($1::text,$2::uuid)',
				[claim.shared_key_id, claim.claim_token],
			);
			finishQueryPending = false;
			const row = rows[0];
			if (rows.length !== 1 || !row || row.shared_key_id !== claim.shared_key_id || !(
				(row.outcome === 'repaired' && row.attempt_count === claim.attempt_count &&
					row.retry_at === null) ||
				(row.outcome === 'deferred' && row.attempt_count === claim.attempt_count &&
					row.attempt_count < 5 && row.retry_at !== null) ||
				(row.outcome === 'dead_lettered' && row.attempt_count === 5 &&
					row.retry_at === null) ||
				(row.outcome === 'stale' && row.attempt_count === 0 && row.retry_at === null)
			)) throw new Error('Shared-key usage repair finish differs');
			return row;
			});
		} catch (error) {
			// postgres.js has rejected the second transaction. A known server
			// statement timeout rolls back projection/deletion but leaves the
			// already committed backoff; the next claim may repair a healthy key
			// in this Cron tick. External cancellation, disconnect, ambiguous
			// COMMIT outcomes and other errors still propagate.
			if (!finishQueryPending || !isServerStatementTimeout(error)) throw error;
			cancelled += 1;
			continue;
		}
		if (finish.outcome === 'repaired') repaired += 1;
		else if (finish.outcome === 'deferred') deferred += 1;
		else if (finish.outcome === 'dead_lettered') deadLettered += 1;
		else stale += 1;
	}
	return result('item_limit');
}

/** Existing Cron entry point; no binding or value in the shipped Wrangler config enables it. */
export async function runWorkerSharedKeyUsageRepair(
	controller: Pick<ScheduledController, 'cron'>,
	environment: GatewayBindings,
): Promise<RepairRunResult | Readonly<{ stopReason: 'disabled'; processed: 0;
	repaired: 0; deferred: 0; deadLettered: 0; cancelled: 0; stale: 0 }>> {
	const activation = environment.SHARED_KEY_USAGE_REPAIR_ENABLED;
	if (activation === undefined || activation === '') {
		return Object.freeze({ stopReason: 'disabled', processed: 0,
			repaired: 0, deferred: 0, deadLettered: 0, cancelled: 0, stale: 0 });
	}
	if (activation !== SHARED_KEY_USAGE_REPAIR_ACTIVATION) {
		throw new TypeError('Invalid shared-key usage repair activation');
	}
	const driver = environment.DATABASE_DRIVER?.trim().toLowerCase();
	if (driver !== 'postgres' && driver !== 'postgresql') {
		throw new TypeError('Shared-key usage repair requires PostgreSQL Worker storage');
	}
	const connectionString = environment.REPAIR_HYPERDRIVE?.connectionString?.trim();
	if (!connectionString) throw new TypeError('Dedicated REPAIR_HYPERDRIVE binding required');
	const client = postgres(connectionString, {
		max: 1, prepare: false, fetch_types: false, connect_timeout: 3,
		idle_timeout: 0, max_lifetime: 0, backoff: false,
	});
	try {
		const result = await runSharedKeyUsageRepairClient(client as unknown as RepairClient);
		console.log(JSON.stringify({ event: 'gateway.shared_key_usage_repair.completed',
			cron: controller.cron, ...result }));
		return result;
	} catch (error) {
		console.error(JSON.stringify({ event: 'gateway.shared_key_usage_repair.failed',
			cron: controller.cron, errorName: error instanceof Error ? error.name : 'UnknownError' }));
		throw error;
	} finally {
		await client.end({ timeout: 1 });
	}
}
