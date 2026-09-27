import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlStatement = Pick<SqlClient, 'unsafe'>;
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
const CLOSER_LOGIN = 'cinatoken_gateway_complete_text_platform_closer';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RECEIPT_FIELDS = new Set([
	'status', 'requestId', 'grantId', 'resolutionId', 'terminalId', 'eventId',
	'decisionNonce', 'decisionSha256', 'buyerChargedMicros', 'supplierCostStatus', 'closedAt',
]);
const REJECTIONS = new Set([
	'missing_grant', 'missing_no_fetch_resolution', 'decision_conflict',
	'possible_send_unknown', 'fact_contradiction_unknown', 'identity_differs',
	'holds_differ', 'account_epoch_differs',
]);

export type CompleteTextNoFetchCloseInputV388 = Readonly<{
	closerConnectionString: string;
	/** Expected request identity, checked against the database-derived result. */
	requestId: string;
	grantId: string;
	resolutionId: string;
	decisionNonce: string;
}>;

export type CommittedCompleteTextNoFetchCloseV388 = Readonly<{
	status: 'closed_no_fetch' | 'already_closed_no_fetch';
	commitAcknowledged: true;
	closeAcknowledged: true;
	requestId: string;
	grantId: string;
	resolutionId: string;
	terminalId: string;
	eventId: string;
	decisionNonce: string;
	decisionSha256: string;
	buyerChargedMicros: 0;
	supplierCostStatus: 'not_asserted';
	closedAt: string;
}>;

export class PostgresCompleteTextNoFetchCloseRejectedError extends Error {
	constructor(readonly status: string) {
		super('PostgreSQL complete text no-fetch close ' + status);
		this.name = 'PostgresCompleteTextNoFetchCloseRejectedError';
	}
}

export class PostgresCompleteTextNoFetchCloseCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL platform closer LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextNoFetchCloseCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL platform closer connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL platform closer connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || url.username !== CLOSER_LOGIN || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) =>
			key.toLowerCase() !== 'sslmode' || !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL platform closer direct LOGIN connection invalid');
	}
	return value;
}

function checkedRow(rows: unknown, input: CompleteTextNoFetchCloseInputV388):
	Omit<CommittedCompleteTextNoFetchCloseV388, 'commitAcknowledged' | 'closeAcknowledged'> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])
		|| !rows[0].value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL platform close response invalid');
	}
	const row = rows[0].value as Record<string, unknown>;
	if (row.status !== 'closed_no_fetch' && row.status !== 'already_closed_no_fetch') {
		if (typeof row.status === 'string' && REJECTIONS.has(row.status)) {
			throw new PostgresCompleteTextNoFetchCloseRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL platform close response invalid');
	}
	if (Object.keys(row).some(key => !RECEIPT_FIELDS.has(key))
		|| row.requestId !== input.requestId || row.grantId !== input.grantId
		|| row.resolutionId !== input.resolutionId || row.decisionNonce !== input.decisionNonce
		|| typeof row.terminalId !== 'string' || !UUID.test(row.terminalId)
		|| typeof row.eventId !== 'string' || !UUID.test(row.eventId)
		|| typeof row.decisionSha256 !== 'string' || !SHA256.test(row.decisionSha256)
		|| row.buyerChargedMicros !== 0 || row.supplierCostStatus !== 'not_asserted'
		|| typeof row.closedAt !== 'string' || !Number.isFinite(Date.parse(row.closedAt))) {
		throw new TypeError('PostgreSQL platform close response identity or amount differs');
	}
	return Object.freeze({
		status: row.status, requestId: input.requestId, grantId: input.grantId,
		resolutionId: input.resolutionId, terminalId: row.terminalId, eventId: row.eventId,
		decisionNonce: input.decisionNonce, decisionSha256: row.decisionSha256,
		buyerChargedMicros: 0, supplierCostStatus: 'not_asserted', closedAt: row.closedAt,
	});
}

/**
 * Review-only no-fetch platform close. PostgreSQL derives its zero buyer amount
 * from a committed permanent no-start fence; this client supplies no amount or
 * supplier-cost claim. No caller receives a receipt before COMMIT and LOGIN
 * close both acknowledge. Retry after uncertainty must retain the same nonce.
 */
export async function closePostgresCompleteTextNoFetchV388(
	params: CompleteTextNoFetchCloseInputV388,
	factory: SqlFactory = postgres,
): Promise<CommittedCompleteTextNoFetchCloseV388> {
	const input = Object.freeze({ ...params });
	const connection = validConnection(input.closerConnectionString);
	if (typeof input.requestId !== 'string' || input.requestId.length < 1
		|| input.requestId.length > 128
		|| [input.grantId, input.resolutionId, input.decisionNonce]
			.some(value => typeof value !== 'string' || !UUID.test(value))) {
		throw new TypeError('PostgreSQL platform close identity invalid');
	}
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	let result: ReturnType<typeof checkedRow> | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			const roles = await tx.unsafe('SELECT current_user AS current_role,'
				+ ' session_user AS session_role,'
				+ " pg_catalog.current_setting('transaction_isolation') AS transaction_isolation");
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== CLOSER_LOGIN
				|| roles[0]?.session_role !== CLOSER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL platform closer direct LOGIN mismatch');
			}
			return checkedRow(await tx.unsafe(
				'SELECT cinatoken_gateway.close_complete_text_no_fetch_v388('
				+ '$1::uuid,$2::uuid,$3::uuid) AS value',
				[input.grantId, input.resolutionId, input.decisionNonce]), input);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL platform closer LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextNoFetchCloseCleanupUnconfirmedError(
			failure === undefined ? cleanupError : new AggregateError(
				[failure, cleanupError], 'Platform close operation and LOGIN close failed'));
	}
	if (failure !== undefined) throw failure;
	if (!result) throw new TypeError('PostgreSQL platform close result missing');
	return Object.freeze({ ...result, commitAcknowledged: true, closeAcknowledged: true });
}
