import type { PostgresDatabaseClient } from '../../../core/src/storage/database-client';

/** Review-only direct LOGIN. No shipped Worker or Queue binding enables this runner. */
export const SHARED_EARNING_CONSUMER_ROLE = 'cinatoken_gateway_shared_earning_consumer';

type Query = {
	unsafe<T extends Record<string, unknown>[]>(sql: string, params?: readonly unknown[]): PromiseLike<T>;
};
type TransactionClient = Query & { begin<T>(run: (tx: Query) => Promise<T>): Promise<T> };

export type SharedEarningDecision = Readonly<{
	eventId: string;
	decision: 'credited' | 'pending_manual';
	creditedAttempts: number;
	pendingAttempts: number;
	netMicros: string;
}>;

export type SharedEarningConsumerOutcome =
	| Readonly<{ status: 'disabled' | 'already_used'; queueAckSafe: false }>
	| Readonly<{ status: 'open_failed'; queueAckSafe: false; clientReturned: false; resourceState: 'unknown' }>
	| Readonly<{ status: 'shared_authority'; queueAckSafe: false; clientDisposition: 'belongs_to_other_owner' }>
	| Readonly<{ status: 'invalid_client'; queueAckSafe: false; locallyRetainedClient: boolean }>
	| Readonly<{ status: 'authority_rejected' | 'outcome_unknown'; queueAckSafe: false; locallyRetainedClient: true }>
	| Readonly<{ status: 'processed'; queueAckSafe: false; physicalClose: 'not_observed'; result: SharedEarningDecision }>;

export type SharedEarningConsumerDependencies = Readonly<{
	/** Explicit local candidate switch. Construction does not enable anything. */
	enabled?: boolean;
	/** Every currently composed request/producer authority must be named here. */
	forbiddenClients: readonly PostgresDatabaseClient[];
	/** Opens an invocation-private client authenticated as the dedicated consumer LOGIN. */
	openInvocationClient(): Promise<PostgresDatabaseClient>;
	/** Called only after COMMIT acknowledgement; it does not prove physical socket closure. */
	retireConfirmedClient(client: PostgresDatabaseClient): Promise<void>;
}>;

class ConsumerAuthorityError extends Error {
	constructor() { super('Dedicated PostgreSQL shared earning consumer LOGIN and server deadlines required');
		this.name = 'ConsumerAuthorityError'; }
}

function boundedServerMs(value: unknown, maximum: number): boolean {
	return typeof value === 'string' && /^(?:[1-9][0-9]{0,8})$/u.test(value) && Number(value) <= maximum;
}

async function requireConsumerAuthority(tx: Query): Promise<void> {
	// The check runs on the same session and in the same transaction as the
	// SECURITY DEFINER invocation. Database-user-sourced deadlines reject a
	// later client SET; credential custody remains an external provision gate.
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
	if (rows.length !== 1 || row?.current_role !== SHARED_EARNING_CONSUMER_ROLE ||
		row.session_role !== SHARED_EARNING_CONSUMER_ROLE ||
		!boundedServerMs(row.transaction_timeout_ms, 30_000) ||
		!boundedServerMs(row.statement_timeout_ms, 15_000) ||
		!boundedServerMs(row.lock_timeout_ms, 5_000) ||
		!boundedServerMs(row.idle_transaction_timeout_ms, 10_000)) throw new ConsumerAuthorityError();
}

function parseDecision(eventId: string, rows: Record<string, unknown>[]): SharedEarningDecision {
	const row = rows[0];
	const credited = row?.out_credited_attempts;
	const pending = row?.out_pending_attempts;
	const net = row?.out_net_micros;
	if (rows.length !== 1 || row?.out_event_id !== eventId ||
		(row.out_decision !== 'credited' && row.out_decision !== 'pending_manual') ||
		!Number.isInteger(credited) || Number(credited) < 0 || Number(credited) > 1000 ||
		!Number.isInteger(pending) || Number(pending) < 0 || Number(pending) > 1000 ||
		Number(credited) + Number(pending) < 1 || Number(credited) + Number(pending) > 1000 ||
		(row.out_decision === 'credited' ? Number(pending) !== 0 : Number(pending) === 0) ||
		typeof net !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/u.test(net) ||
		BigInt(net) > 9007199254740991n) throw new Error('Shared earning consumer result differs');
	return Object.freeze({ eventId, decision: row.out_decision,
		creditedAttempts: Number(credited), pendingAttempts: Number(pending), netMicros: net });
}

/**
 * One event-ID-only invocation against the review-only PostgreSQL consumer
 * function. A successful result is a local COMMIT acknowledgement. Queue ACK,
 * durable scanning, retry leases, DLQ and physical client retirement are
 * separate gates. An uncertain client stays referenced by this one-shot owner.
 */
export function createPostgresSharedEarningConsumer(input: SharedEarningConsumerDependencies) {
	if (!input || typeof input !== 'object' ||
		(input.enabled !== undefined && typeof input.enabled !== 'boolean') ||
		typeof input.openInvocationClient !== 'function' ||
		typeof input.retireConfirmedClient !== 'function' ||
		!Array.isArray(input.forbiddenClients) || input.forbiddenClients.length < 1 ||
		input.forbiddenClients.some(value => value?.driver !== 'postgres' || !value.raw))
		throw new TypeError('Explicit PostgreSQL shared earning consumer authorities required');
	const enabled = input.enabled === true;
	const forbidden = [...input.forbiddenClients];
	const forbiddenRaw = forbidden.map(value => value.raw);
	let used = false;
	let retainedClient: PostgresDatabaseClient | null = null;
	return Object.freeze({
		snapshot: () => Object.freeze({ used, retainedClient: retainedClient !== null }),
		async runEventOnce(eventId: string): Promise<SharedEarningConsumerOutcome> {
			if (!enabled) return Object.freeze({ status: 'disabled', queueAckSafe: false });
			if (used) return Object.freeze({ status: 'already_used', queueAckSafe: false });
			if (typeof eventId !== 'string' || eventId.length < 1 || eventId.length > 512 ||
				/[\u0000-\u001f\u007f]/u.test(eventId)) throw new TypeError('Bounded economic event ID required');
			used = true;
			let client: PostgresDatabaseClient;
			try { client = await input.openInvocationClient(); }
			catch { return Object.freeze({ status: 'open_failed', queueAckSafe: false,
				clientReturned: false, resourceState: 'unknown' }); }
			if (forbidden.some(value => value === client) || forbiddenRaw.some(raw => raw === client?.raw))
				return Object.freeze({ status: 'shared_authority', queueAckSafe: false,
					clientDisposition: 'belongs_to_other_owner' });
			if (client?.driver !== 'postgres' || !client.raw ||
				typeof (client.raw as unknown as TransactionClient).begin !== 'function') {
				retainedClient = client ?? null;
				return Object.freeze({ status: 'invalid_client', queueAckSafe: false,
					locallyRetainedClient: retainedClient !== null });
			}
			retainedClient = client;
			let result: SharedEarningDecision;
			try {
				result = await (client.raw as unknown as TransactionClient).begin(async tx => {
					await requireConsumerAuthority(tx);
					const rows = await tx.unsafe<Record<string, unknown>[]>(
						'SELECT * FROM cinatoken_economic_consumer.consume_shared_key_economic_event($1::text)',
						[eventId],
					);
					return parseDecision(eventId, rows);
				});
			} catch (error) {
				return Object.freeze({ status: error instanceof ConsumerAuthorityError ? 'authority_rejected' : 'outcome_unknown',
					queueAckSafe: false, locallyRetainedClient: true });
			}
			try { await input.retireConfirmedClient(client); retainedClient = null; }
			catch { return Object.freeze({ status: 'outcome_unknown', queueAckSafe: false, locallyRetainedClient: true }); }
			return Object.freeze({ status: 'processed', queueAckSafe: false,
				physicalClose: 'not_observed', result });
		},
	});
}
