import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';
import { createPostgresSharedEarningConsumer, type SharedEarningDecision,
} from './postgres-shared-earning-consumer';

export const SHARED_EARNING_DELIVERY_ROLE = 'cinatoken_gateway_shared_earning_delivery';

type Query = {
	unsafe<T extends Record<string, unknown>[]>(sql: string, params?: readonly unknown[]): PromiseLike<T>;
};
type TransactionClient = Query & { begin<T>(run: (tx: Query) => Promise<T>): Promise<T> };
type JobStatus = 'absent' | 'pending' | 'leased' | 'completed' | 'dead_letter';
type Claim = Readonly<{ eventId: string; token: string; attemptCount: number }>;

export type SharedEarningDeliveryOutcome =
	| Readonly<{ status: 'disabled' | 'already_used'; queueAckSafe: false }>
	| Readonly<{ status: 'open_failed'; queueAckSafe: false; resourceState: 'unknown' }>
	| Readonly<{ status: 'shared_authority'; queueAckSafe: false }>
	| Readonly<{ status: 'invalid_client'; queueAckSafe: false; locallyRetainedClient: boolean }>
	| Readonly<{ status: 'authority_rejected' | 'outcome_unknown'; queueAckSafe: false;
		locallyRetainedClient: true }>
	| Readonly<{ status: 'unclaimed'; queueAckSafe: false; jobStatus: JobStatus;
		physicalClose: 'not_observed' }>
	| Readonly<{ status: 'completed'; queueAckSafe: false; physicalClose: 'not_observed';
		result: SharedEarningDecision; disposition: 'completed' | 'already_completed' }>;

export type SharedEarningDeliveryDependencies = Readonly<{
	/** No shipped Queue or Worker binding enables this local candidate. */
	enabled?: boolean;
	leaseSeconds: number;
	/** Request/producer authorities the delivery and earning clients may never reuse. */
	forbiddenClients: readonly PostgresDatabaseClient[];
	openDeliveryClient(): Promise<PostgresDatabaseClient>;
	retireConfirmedDeliveryClient(client: PostgresDatabaseClient): Promise<void>;
	openEarningClient(): Promise<PostgresDatabaseClient>;
	retireConfirmedEarningClient(client: PostgresDatabaseClient): Promise<void>;
}>;

class DeliveryAuthorityError extends Error {
	constructor() { super('Dedicated PostgreSQL shared earning delivery LOGIN and server deadlines required');
		this.name = 'DeliveryAuthorityError'; }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function boundedMs(value: unknown, maximum: number): boolean {
	return typeof value === 'string' && /^(?:[1-9][0-9]{0,8})$/u.test(value) && Number(value) <= maximum;
}

export async function requireDeliveryAuthority(tx: Query): Promise<void> {
	const rows = await tx.unsafe<{
		current_role: unknown; session_role: unknown;
		transaction_timeout_ms: unknown; statement_timeout_ms: unknown;
		lock_timeout_ms: unknown; idle_transaction_timeout_ms: unknown;
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
	if (rows.length !== 1 || row?.current_role !== SHARED_EARNING_DELIVERY_ROLE ||
		row.session_role !== SHARED_EARNING_DELIVERY_ROLE ||
		!boundedMs(row.transaction_timeout_ms, 30_000) ||
		!boundedMs(row.statement_timeout_ms, 15_000) ||
		!boundedMs(row.lock_timeout_ms, 5_000) ||
		!boundedMs(row.idle_transaction_timeout_ms, 10_000)) throw new DeliveryAuthorityError();
}

function parseClaim(eventId: string, rows: Record<string, unknown>[]): Claim | null {
	if (rows.length === 0) return null;
	const row = rows[0];
	if (rows.length !== 1 || row?.out_event_id !== eventId ||
		typeof row.out_claim_token !== 'string' || !UUID.test(row.out_claim_token) ||
		!Number.isInteger(row.out_attempt_count) || Number(row.out_attempt_count) < 1 ||
		Number(row.out_attempt_count) > 8 ||
		!(row.out_lease_until instanceof Date || typeof row.out_lease_until === 'string') ||
		!Number.isFinite(new Date(row.out_lease_until).getTime()))
		throw new Error('Shared earning delivery claim differs');
	return Object.freeze({ eventId, token: row.out_claim_token, attemptCount: Number(row.out_attempt_count) });
}

function parseStatus(rows: Record<string, unknown>[]): JobStatus {
	const row = rows[0];
	if (rows.length !== 1 || !row || !['absent', 'pending', 'leased', 'completed', 'dead_letter']
		.includes(String(row.out_status))) throw new Error('Shared earning delivery inspection differs');
	return row.out_status as JobStatus;
}

function parseDisposition(rows: Record<string, unknown>[]): 'completed' | 'already_completed' {
	const row = rows[0];
	if (rows.length !== 1 || !row || (row.disposition !== 'completed' &&
		row.disposition !== 'already_completed')) throw new Error('Shared earning delivery ACK differs');
	return row.disposition;
}

/**
 * Event-ID-only local Queue candidate. Claim, consumer credit and ACK use
 * separate bounded transactions and distinct LOGINs. A lost commit response
 * never becomes an ACK. The durable scanner and Queue policy remain separate;
 * every outcome deliberately reports queueAckSafe=false.
 */
export function createPostgresSharedEarningDelivery(input: SharedEarningDeliveryDependencies) {
	if (!input || typeof input !== 'object' ||
		(input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
		!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 5 || input.leaseSeconds > 300 ||
		!Array.isArray(input.forbiddenClients) || input.forbiddenClients.length < 1 ||
		input.forbiddenClients.some(value => value?.driver !== 'postgres' || !value.raw) ||
		typeof input.openDeliveryClient !== 'function' ||
		typeof input.retireConfirmedDeliveryClient !== 'function' ||
		typeof input.openEarningClient !== 'function' ||
		typeof input.retireConfirmedEarningClient !== 'function')
		throw new TypeError('Explicit bounded PostgreSQL shared earning delivery dependencies required');
	const enabled = input.enabled === true;
	const leaseSeconds = input.leaseSeconds;
	const forbidden = [...input.forbiddenClients];
	const forbiddenRaw = forbidden.map(value => value.raw);
	let used = false;
	let retainedClient: PostgresDatabaseClient | null = null;
	return Object.freeze({
		snapshot: () => Object.freeze({ used, retainedClient: retainedClient !== null }),
		async runEventOnce(eventId: string): Promise<SharedEarningDeliveryOutcome> {
			if (!enabled) return Object.freeze({ status: 'disabled', queueAckSafe: false });
			if (used) return Object.freeze({ status: 'already_used', queueAckSafe: false });
			if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 512 ||
				/[\u0000-\u001f\u007f]/u.test(eventId)) throw new TypeError('Bounded economic event ID required');
			used = true;
			let client: PostgresDatabaseClient;
			try { client = await input.openDeliveryClient(); }
			catch { return Object.freeze({ status: 'open_failed', queueAckSafe: false, resourceState: 'unknown' }); }
			if (forbidden.some(value => value === client) || forbiddenRaw.some(raw => raw === client?.raw))
				return Object.freeze({ status: 'shared_authority', queueAckSafe: false });
			if (client?.driver !== 'postgres' || !client.raw ||
				typeof (client.raw as unknown as TransactionClient).begin !== 'function') {
				retainedClient = client ?? null;
				return Object.freeze({ status: 'invalid_client', queueAckSafe: false,
					locallyRetainedClient: retainedClient !== null });
			}
			retainedClient = client;
			const raw = client.raw as unknown as TransactionClient;
			let claimed: Claim | null;
			let inspected: JobStatus | null = null;
			try {
				({ claimed, inspected } = await raw.begin(async tx => {
					await requireDeliveryAuthority(tx);
					const rows = await tx.unsafe<Record<string, unknown>[]>(
						'SELECT * FROM cinatoken_economic_delivery.claim_event($1::text,$2::integer)',
						[eventId, leaseSeconds],
					);
					const claim = parseClaim(eventId, rows);
					const status = claim === null ? parseStatus(await tx.unsafe<Record<string, unknown>[]>(
						'SELECT * FROM cinatoken_economic_delivery.inspect_event($1::text)', [eventId],
					)) : null;
					return { claimed: claim, inspected: status };
				}));
			} catch (error) {
				return Object.freeze({ status: error instanceof DeliveryAuthorityError ? 'authority_rejected' : 'outcome_unknown',
					queueAckSafe: false, locallyRetainedClient: true });
			}
			if (claimed === null) {
				try { await input.retireConfirmedDeliveryClient(client); retainedClient = null; }
				catch { return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true }); }
				return Object.freeze({ status: 'unclaimed', queueAckSafe: false,
					jobStatus: inspected!, physicalClose: 'not_observed' });
			}
			const consumer = createPostgresSharedEarningConsumer({ enabled: true,
				forbiddenClients: [...forbidden, client],
				openInvocationClient: input.openEarningClient,
				retireConfirmedClient: input.retireConfirmedEarningClient,
			});
			const consumed = await consumer.runEventOnce(eventId);
			if (consumed.status !== 'processed')
				return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true });
			let disposition: 'completed' | 'already_completed';
			try {
				disposition = await raw.begin(async tx => {
					await requireDeliveryAuthority(tx);
					return parseDisposition(await tx.unsafe<Record<string, unknown>[]>(
						'SELECT cinatoken_economic_delivery.ack_event($1::text,$2::uuid) AS disposition',
						[eventId, claimed.token],
					));
				});
			} catch (error) {
				return Object.freeze({ status: error instanceof DeliveryAuthorityError ? 'authority_rejected' : 'outcome_unknown',
					queueAckSafe: false, locallyRetainedClient: true });
			}
			try { await input.retireConfirmedDeliveryClient(client); retainedClient = null; }
			catch { return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true }); }
			return Object.freeze({ status: 'completed', queueAckSafe: false, physicalClose: 'not_observed',
				result: consumed.result, disposition });
		},
	});
}
