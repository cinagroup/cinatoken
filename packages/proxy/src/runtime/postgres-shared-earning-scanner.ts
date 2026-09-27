import postgres from 'postgres';
import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import { createPostgresSharedEarningConsumer } from './postgres-shared-earning-consumer';
import { requireDeliveryAuthority } from './postgres-shared-earning-delivery';
import { observeDedicatedSharedEarningBacklog } from './postgres-shared-earning-backlog-observer';

export const DEDICATED_SHARED_EARNING_SCANNER_ACTIVATION = 'dedicated-v1';

/** Binding surface of the scheduled-only Worker. No HTTP data-plane origin. */
export type DedicatedSharedEarningScannerBindings = Readonly<{
	SHARED_EARNING_SCANNER_ENABLED?: string;
	EARNING_DELIVERY_HYPERDRIVE?: { connectionString: string };
	EARNING_CONSUMER_HYPERDRIVE?: { connectionString: string };
}>;

type Query = {
	unsafe<T extends Record<string, unknown>[]>(sql: string, params?: readonly unknown[]): PromiseLike<T>;
};
type TransactionClient = Query & { begin<T>(run: (tx: Query) => Promise<T>): Promise<T> };
type Claim = Readonly<{ eventId: string; token: string }>;
type Limits = Readonly<{ maxItems: number; admissionBudgetMs: number; leaseSeconds: number }>;
const DEFAULT_LIMITS: Limits = Object.freeze({ maxItems: 20, admissionBudgetMs: 25_000, leaseSeconds: 300 });
const MAX_HOUSEKEEPING_PASSES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type SharedEarningScanResult = Readonly<{
	claimed: number;
	completed: number;
	housekeeping: number;
	stopReason: 'no_claim' | 'item_limit' | 'admission_budget' | 'housekeeping_limit';
}>;

export type SharedEarningScanDependencies = Readonly<{
	deliveryClient: PostgresDatabaseClient;
	/** Opens an invocation-private dedicated consumer LOGIN for this one event. */
	openEarningClient(): Promise<PostgresDatabaseClient>;
	/** Called only after the consumer transaction has a confirmed COMMIT response. */
	retireConfirmedEarningClient(client: PostgresDatabaseClient): Promise<void>;
	/** Other clients composed into this process; none may own the consumer connection. */
	forbiddenClients?: readonly PostgresDatabaseClient[];
}>;

function parseClaim(rows: Record<string, unknown>[]): Claim | null {
	if (rows.length === 0) return null;
	const row = rows[0];
	if (rows.length !== 1 || typeof row?.out_event_id !== 'string' ||
		row.out_event_id.length < 1 || row.out_event_id.length > 512 ||
		/[\u0000-\u001f\u007f]/u.test(row.out_event_id) ||
		typeof row.out_claim_token !== 'string' || !UUID.test(row.out_claim_token) ||
		!Number.isInteger(row.out_attempt_count) || Number(row.out_attempt_count) < 1 ||
		Number(row.out_attempt_count) > 8 ||
		!(row.out_lease_until instanceof Date || typeof row.out_lease_until === 'string') ||
		!Number.isFinite(new Date(row.out_lease_until).getTime())) {
		throw new Error('Shared earning scanner claim differs');
	}
	return Object.freeze({ eventId: row.out_event_id, token: row.out_claim_token });
}

function checkedLimits(input: Limits): Limits {
	if (!Number.isSafeInteger(input?.maxItems) || input.maxItems < 1 || input.maxItems > 50 ||
		!Number.isSafeInteger(input.admissionBudgetMs) || input.admissionBudgetMs < 1 ||
		input.admissionBudgetMs > 60_000 || !Number.isSafeInteger(input.leaseSeconds) ||
		input.leaseSeconds < 5 || input.leaseSeconds > 300) {
		throw new TypeError('Invalid bounded shared earning scanner limits');
	}
	return Object.freeze({ ...input });
}

/**
 * One durable claim at a time. The v342 trigger creates jobs in the source
 * transaction; claim_events owns the lease in PostgreSQL. If a claim, earning,
 * or ACK response is uncertain, stop and let that lease expire. A later Cron
 * invocation can replay the event ID; the consumer marker prevents double pay.
 */
export async function runSharedEarningScannerClient(
	input: SharedEarningScanDependencies,
	limits: Limits = DEFAULT_LIMITS,
	monotonicMs: () => number = () => performance.now(),
): Promise<SharedEarningScanResult> {
	const bounded = checkedLimits(limits);
	if (input?.deliveryClient?.driver !== 'postgres' ||
		typeof (input.deliveryClient.raw as unknown as TransactionClient)?.begin !== 'function' ||
		typeof input.openEarningClient !== 'function' ||
		typeof input.retireConfirmedEarningClient !== 'function' ||
		(input.forbiddenClients !== undefined && (!Array.isArray(input.forbiddenClients) ||
			input.forbiddenClients.some(value => value?.driver !== 'postgres' || !value.raw)))) {
		throw new TypeError('Dedicated PostgreSQL shared earning scanner dependencies required');
	}
	const delivery = input.deliveryClient.raw as unknown as TransactionClient;
	const forbidden = [input.deliveryClient, ...(input.forbiddenClients ?? [])];
	const start = monotonicMs();
	if (!Number.isFinite(start)) throw new TypeError('Invalid scanner monotonic clock');
	let claimed = 0;
	let completed = 0;
	let housekeeping = 0;
	const result = (stopReason: SharedEarningScanResult['stopReason']): SharedEarningScanResult =>
		Object.freeze({ claimed, completed, housekeeping, stopReason });
	while (claimed < bounded.maxItems) {
		const elapsed = monotonicMs() - start;
		if (!Number.isFinite(elapsed) || elapsed < 0)
			throw new TypeError('Invalid scanner monotonic clock');
		if (elapsed >= bounded.admissionBudgetMs) return result('admission_budget');
		// A rejected begin can mean COMMIT succeeded and its response was lost.
		// No consumer is started unless this transaction returns a confirmed claim.
		const scan = await delivery.begin(async tx => {
			await requireDeliveryAuthority(tx);
			const claim = parseClaim(await tx.unsafe<Record<string, unknown>[]>(
				'SELECT * FROM cinatoken_economic_delivery.claim_events($1::integer,$2::integer)',
				[1, bounded.leaseSeconds],
			));
			if (claim !== null) return { claim, housekeeping: false };
			// v342 returns zero rows both for an empty scan and for a due row it
			// just completed/dead-lettered. In this dedicated transaction, only
			// claim_events can assign an XID. A read-only miss stops immediately;
			// a changed due row gets a bounded follow-up scan after COMMIT.
			const progress = await tx.unsafe<{ touched_due_row: unknown }[]>(
				'SELECT pg_catalog.pg_current_xact_id_if_assigned() IS NOT NULL AS touched_due_row',
			);
			if (progress.length !== 1 || typeof progress[0]?.touched_due_row !== 'boolean')
				throw new Error('Shared earning scanner progress probe differs');
			return { claim: null, housekeeping: progress[0].touched_due_row };
		});
		if (scan.claim === null) {
			if (!scan.housekeeping) return result('no_claim');
			housekeeping += 1;
			if (housekeeping >= MAX_HOUSEKEEPING_PASSES) return result('housekeeping_limit');
			continue;
		}
		const claim = scan.claim;
		claimed += 1;
		const consumer = createPostgresSharedEarningConsumer({
			enabled: true, forbiddenClients: forbidden,
			openInvocationClient: input.openEarningClient,
			retireConfirmedClient: input.retireConfirmedEarningClient,
		});
		const consumed = await consumer.runEventOnce(claim.eventId);
		if (consumed.status !== 'processed')
			throw new Error('Shared earning scanner consumer outcome unconfirmed');
		const disposition = await delivery.begin(async tx => {
			await requireDeliveryAuthority(tx);
			const rows = await tx.unsafe<{ disposition: unknown }[]>(
				'SELECT cinatoken_economic_delivery.ack_event($1::text,$2::uuid) AS disposition',
				[claim.eventId, claim.token],
			);
			if (rows.length !== 1 || (rows[0]?.disposition !== 'completed' &&
				rows[0]?.disposition !== 'already_completed'))
				throw new Error('Shared earning scanner ACK differs');
			return rows[0].disposition;
		});
		if (disposition !== 'completed' && disposition !== 'already_completed')
			throw new Error('Shared earning scanner ACK differs');
		completed += 1;
	}
	return result('item_limit');
}

function connectionString(binding: unknown, name: string): string {
	const value = binding && typeof binding === 'object'
		? (binding as { connectionString?: unknown }).connectionString : undefined;
	if (typeof value !== 'string' || value.length === 0 || value !== value.trim())
		throw new TypeError(`Dedicated ${name} connection string required`);
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError(`Invalid ${name} connection string`); }
	const query = [...url.searchParams];
	const validSslMode = query.length === 0 || (query.length === 1 &&
		query[0][0].toLowerCase() === 'sslmode' &&
		(query[0][1] === 'disable' || query[0][1] === 'require'));
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') ||
		!url.hostname || !url.username || !url.password || !url.pathname ||
		url.pathname === '/' || !validSslMode || url.hash)
		throw new TypeError(`Invalid ${name} connection string`);
	return value;
}

/**
 * Dedicated scheduled Worker: two financial origins only. The shared
 * lease/consume/ACK protocol remains in runSharedEarningScannerClient.
 */
export async function runDedicatedSharedEarningScanner(
	controller: Pick<ScheduledController, 'cron'>,
	environment: DedicatedSharedEarningScannerBindings,
	createSql: typeof postgres = postgres,
): Promise<SharedEarningScanResult | Readonly<{ claimed: 0; completed: 0;
	housekeeping: 0; stopReason: 'disabled' }>> {
	const allowed = new Set([
		'SHARED_EARNING_SCANNER_ENABLED',
		'EARNING_DELIVERY_HYPERDRIVE',
		'EARNING_CONSUMER_HYPERDRIVE',
	]);
	if (!environment || Object.keys(environment).some(key => !allowed.has(key)))
		throw new TypeError('Dedicated scanner Worker bindings contain an HTTP or unknown authority');
	const activation = environment.SHARED_EARNING_SCANNER_ENABLED;
	if (activation === undefined || activation === '' || activation === 'false')
		return Object.freeze({ claimed: 0, completed: 0, housekeeping: 0, stopReason: 'disabled' });
	if (activation !== DEDICATED_SHARED_EARNING_SCANNER_ACTIVATION)
		throw new TypeError('Invalid dedicated shared earning scanner activation');
	const delivery = connectionString(environment.EARNING_DELIVERY_HYPERDRIVE,
		'EARNING_DELIVERY_HYPERDRIVE');
	const earning = connectionString(environment.EARNING_CONSUMER_HYPERDRIVE,
		'EARNING_CONSUMER_HYPERDRIVE');
	if (delivery === earning ||
		environment.EARNING_DELIVERY_HYPERDRIVE === environment.EARNING_CONSUMER_HYPERDRIVE)
		throw new TypeError('Dedicated scanner Hyperdrive bindings must be distinct');
	const opened = new Set<ReturnType<typeof postgres>>();
	const create = (value: string) => {
		const sql = createSql(value, { max: 1, prepare: false, fetch_types: false,
			connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });
		opened.add(sql);
		return { driver: 'postgres', raw: sql } as PostgresDatabaseClient;
	};
	let runFailure: unknown;
	try {
		const deliveryClient = create(delivery);
		const backlog = await observeDedicatedSharedEarningBacklog(deliveryClient);
		console.log(JSON.stringify({ event: 'gateway.shared_earning_scan.backlog',
			cron: controller.cron, ...backlog }));
		const result = await runSharedEarningScannerClient({
			deliveryClient,
			async openEarningClient() { return create(earning); },
			async retireConfirmedEarningClient(client) {
				await client.raw.end({ timeout: 1 });
				opened.delete(client.raw);
			},
		});
		console.log(JSON.stringify({ event: 'gateway.shared_earning_scan.completed',
			cron: controller.cron, ...result }));
		return result;
	} catch (error) {
		runFailure = error;
		console.error(JSON.stringify({ event: 'gateway.shared_earning_scan.failed',
			cron: controller.cron, errorName: error instanceof Error ? error.name : 'UnknownError' }));
		throw error;
	} finally {
		// Do not reuse a client after an uncertain claim, credit or ACK response.
		const retired = await Promise.allSettled([...opened].map(sql => sql.end({ timeout: 1 })));
		if (retired.some(item => item.status === 'rejected')) {
			console.error(JSON.stringify({ event: 'gateway.shared_earning_scan.cleanup_unconfirmed',
				cron: controller.cron }));
			if (!runFailure) throw new Error('Dedicated scanner client cleanup unconfirmed');
		}
	}
}
