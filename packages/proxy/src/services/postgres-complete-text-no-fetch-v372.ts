import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlStatement = Pick<SqlClient, 'unsafe'>;
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;

const RESOLVER_LOGIN = 'cinatoken_gateway_complete_text_no_fetch_resolver';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export type CommittedCompleteTextNoFetchV372 = Readonly<{
	status: 'verified_no_fetch_recorded' | 'already_verified_no_fetch';
	commitAcknowledged: true;
	closeAcknowledged: true;
	grantId: string;
	resolutionNonce: string;
	resolutionId: string;
	fencedAt: string;
}>;

export class PostgresCompleteTextNoFetchRejectedError extends Error {
	constructor(readonly status: string) {
		super('PostgreSQL complete text no-fetch resolution ' + status);
		this.name = 'PostgresCompleteTextNoFetchRejectedError';
	}
}

export class PostgresCompleteTextNoFetchCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete text no-fetch resolver LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextNoFetchCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL complete text no-fetch connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL complete text no-fetch connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || url.username !== RESOLVER_LOGIN || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) =>
			key.toLowerCase() !== 'sslmode' || !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL complete text no-fetch direct LOGIN connection invalid');
	}
	return value;
}

function validId(value: string, label: string): string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new TypeError('PostgreSQL complete text ' + label + ' invalid');
	}
	return value;
}

function responseValue(rows: unknown): Record<string, unknown> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])
		|| !rows[0].value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL complete text no-fetch response invalid');
	}
	return rows[0].value as Record<string, unknown>;
}

/**
 * Review-only durable no-send evidence reader. This result never authorizes
 * another grant, a buyer zero debit, or a supplier zero-charge conclusion.
 * A same-nonce replay is useful after an uncertain earlier COMMIT/close ACK:
 * only this call's acknowledged COMMIT and close make the row usable.
 */
export async function confirmPostgresCompleteTextNoFetchV370(params: {
	resolverConnectionString: string;
	grantId: string;
	resolutionNonce: string;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextNoFetchV372> {
	const connection = validConnection(params.resolverConnectionString);
	const grantId = validId(params.grantId, 'grant ID');
	const resolutionNonce = validId(params.resolutionNonce, 'resolution nonce');
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	let row: Record<string, unknown> | undefined;
	let failure: unknown;
	try {
		row = await transactional.begin(async tx => {
			const roles = await tx.unsafe('SELECT current_user AS current_role,'
				+ ' session_user AS session_role,'
				+ " pg_catalog.current_setting('transaction_isolation') AS transaction_isolation");
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== RESOLVER_LOGIN
				|| roles[0]?.session_role !== RESOLVER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL complete text no-fetch direct LOGIN mismatch');
			}
			return responseValue(await tx.unsafe(
				'SELECT cinatoken_gateway.resolve_complete_text_no_fetch_v370('
				+ '$1::uuid,$2::uuid) AS value', [grantId, resolutionNonce]));
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL no-fetch resolver LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextNoFetchCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError],
					'No-fetch operation and LOGIN close failed'));
	}
	if (failure !== undefined) throw failure;
	if (!row || !['verified_no_fetch_recorded', 'already_verified_no_fetch']
		.includes(String(row.status))) {
		if (typeof row?.status === 'string' && row.status.length <= 80) {
			throw new PostgresCompleteTextNoFetchRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL complete text no-fetch response invalid');
	}
	if (row.grantId !== grantId || typeof row.resolutionId !== 'string'
		|| !UUID.test(row.resolutionId)
		|| typeof row.fencedAt !== 'string'
		|| !Number.isFinite(Date.parse(row.fencedAt))
		|| (row.status === 'verified_no_fetch_recorded'
			&& row.result !== 'verified_no_fetch')) {
		throw new TypeError('PostgreSQL complete text no-fetch response mismatch');
	}
	return Object.freeze({
		status: row.status as CommittedCompleteTextNoFetchV372['status'],
		commitAcknowledged: true as const,
		closeAcknowledged: true as const,
		grantId, resolutionNonce,
		resolutionId: row.resolutionId,
		fencedAt: row.fencedAt,
	});
}
