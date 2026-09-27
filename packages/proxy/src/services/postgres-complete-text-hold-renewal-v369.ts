import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlStatement = Pick<SqlClient, 'unsafe'>;
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;

const RENEWER_LOGIN = 'cinatoken_gateway_complete_text_hold_renewer';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_EXPECTED_EPOCH = 9_007_199_254_740_990;

export type CommittedCompleteTextHoldRenewalV369 = Readonly<{
	status: 'renewal_recorded';
	commitAcknowledged: true;
	closeAcknowledged: true;
	grantId: string;
	holderRunId: string;
	sendStartId: string;
	leaseEpoch: number;
	leaseUntil: string;
}>;

export class PostgresCompleteTextHoldRenewalRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL complete text hold renewal ${status}`);
		this.name = 'PostgresCompleteTextHoldRenewalRejectedError';
	}
}

export class PostgresCompleteTextHoldRenewalCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL complete text hold renewer LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresCompleteTextHoldRenewalCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL complete text renewer connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL complete text renewer connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || url.username !== RENEWER_LOGIN || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) => key.toLowerCase() !== 'sslmode'
			|| !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL complete text renewer connection invalid');
	}
	return value;
}

function validId(value: string, label: string): string {
	if (typeof value !== 'string' || !UUID.test(value)) {
		throw new TypeError(`PostgreSQL complete text ${label} invalid`);
	}
	return value;
}

function responseValue(rows: unknown): Record<string, unknown> {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])
		|| !rows[0].value || typeof rows[0].value !== 'object'
		|| Array.isArray(rows[0].value)) {
		throw new TypeError('PostgreSQL complete text renewal response invalid');
	}
	return rows[0].value as Record<string, unknown>;
}

function safeClockNow(clock: () => number): number {
	const now = clock();
	if (!Number.isSafeInteger(now)) {
		throw new TypeError('PostgreSQL complete text renewal clock invalid');
	}
	return now;
}

/**
 * Review-only one-shot direct LOGIN call. A SQL result has no authority until
 * both the transaction COMMIT and dedicated connection shutdown acknowledge.
 * A replay or uncertain acknowledgement never extends the caller's deadline.
 */
export async function renewPostgresCompleteTextHoldsV367(params: {
	renewerConnectionString: string;
	grantId: string;
	holderRunId: string;
	sendStartId: string;
	expectedEpoch: number;
	nowMs?: () => number;
}, factory: SqlFactory = postgres): Promise<CommittedCompleteTextHoldRenewalV369> {
	const connection = validConnection(params.renewerConnectionString);
	const grantId = validId(params.grantId, 'grant ID');
	const holderRunId = validId(params.holderRunId, 'holder run ID');
	const sendStartId = validId(params.sendStartId, 'send start ID');
	const expectedEpoch = params.expectedEpoch;
	if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1
		|| expectedEpoch > MAX_EXPECTED_EPOCH) {
		throw new TypeError('PostgreSQL complete text renewal epoch invalid');
	}
	const clock = params.nowMs ?? Date.now;
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	let row: Record<string, unknown> | undefined;
	let failure: unknown;
	try {
		row = await transactional.begin(async tx => {
			const roles = await tx.unsafe(`SELECT current_user AS current_role,
			  session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== RENEWER_LOGIN
				|| roles[0]?.session_role !== RENEWER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL complete text renewer direct LOGIN mismatch');
			}
			return responseValue(await tx.unsafe(
				`SELECT cinatoken_gateway.renew_complete_text_holds_v367(
				  $1::uuid,$2::uuid,$3::uuid,$4::bigint) AS value`,
				[grantId, holderRunId, sendStartId, expectedEpoch],
			));
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL renewer LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresCompleteTextHoldRenewalCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError],
					'Renewal operation and LOGIN close failed'),
		);
	}
	if (failure !== undefined) throw failure;
	if (!row || row.status !== 'renewal_recorded') {
		if (typeof row?.status === 'string' && row.status.length <= 80) {
			throw new PostgresCompleteTextHoldRenewalRejectedError(row.status);
		}
		throw new TypeError('PostgreSQL complete text renewal response invalid');
	}
	if (row.grantId !== grantId || row.holderRunId !== holderRunId
		|| row.sendStartId !== sendStartId
		|| row.leaseEpoch !== expectedEpoch + 1
		|| typeof row.leaseUntil !== 'string'
		|| !Number.isFinite(Date.parse(row.leaseUntil))
		|| Date.parse(row.leaseUntil) <= safeClockNow(clock)) {
		throw new TypeError('PostgreSQL complete text renewal response mismatch');
	}
	return Object.freeze({ status: 'renewal_recorded' as const,
		commitAcknowledged: true as const, closeAcknowledged: true as const,
		grantId, holderRunId, sendStartId,
		leaseEpoch: expectedEpoch + 1, leaseUntil: row.leaseUntil });
}
