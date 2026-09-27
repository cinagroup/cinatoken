import postgres from 'postgres';
import type { PostgresDatabaseClient } from '@octafuse/core';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connectionString: string, options: { max: 1 }) => SqlClient;
type SqlStatement = Pick<SqlClient, 'unsafe'>;

const BUYER_LOGIN = 'cinatoken_gateway_buyer_settlement';
const MAX_MICROS = 9_007_199_254_740_991;

export type CommittedLegacyBuyerHeldV368 = Readonly<{
	status: 'legacy_settled';
	commitAcknowledged: true;
	requestId: string;
	ordinarySettledMicros: number;
	guardrailSettledMicros: number;
	guardrailRows: number;
}>;

export class PostgresLegacyBuyerHeldRejectedError extends Error {
	constructor(readonly status: string) {
		super(`PostgreSQL legacy buyer held settlement ${status}`);
		this.name = 'PostgresLegacyBuyerHeldRejectedError';
	}
}

export class PostgresLegacyBuyerHeldCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL legacy buyer LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresLegacyBuyerHeldCleanupUnconfirmedError';
	}
}

function validConnection(value: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError('PostgreSQL legacy buyer connection invalid');
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError('PostgreSQL legacy buyer connection invalid'); }
	if (!['postgres:', 'postgresql:'].includes(url.protocol)
		|| !url.hostname || url.username !== BUYER_LOGIN || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1
		|| [...url.searchParams].some(([key, setting]) => key.toLowerCase() !== 'sslmode'
			|| !['require', 'disable'].includes(setting))) {
		throw new TypeError('PostgreSQL legacy buyer connection invalid');
	}
	return value;
}

function validText(value: string, label: string): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > 128
		|| value !== value.trim() || /[\x00-\x1f\x7f]/u.test(value)) {
		throw new TypeError(`PostgreSQL legacy buyer ${label} invalid`);
	}
	return value;
}

function validMicros(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MICROS) {
		throw new TypeError(`PostgreSQL legacy buyer ${label} invalid`);
	}
	return value;
}

/** Review-only. Caller amounts are not a verified Provider or buyer fact. */
export async function settlePostgresLegacyBuyerHeldV368(params: {
	buyerConnectionString: string;
	requestId: string;
	ordinarySettledMicros: number;
	guardrailSettledMicros: number;
	reason: string;
}, factory: SqlFactory = postgres): Promise<CommittedLegacyBuyerHeldV368> {
	const connection = validConnection(params.buyerConnectionString);
	const requestId = validText(params.requestId, 'request ID');
	const ordinarySettledMicros = validMicros(params.ordinarySettledMicros,
		'ordinary settled micros');
	const guardrailSettledMicros = validMicros(params.guardrailSettledMicros,
		'Guardrail settled micros');
	const reason = validText(params.reason, 'reason');
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as {
		begin<R>(callback: (tx: SqlStatement) => Promise<R>): Promise<R>;
	};
	let result: Record<string, unknown> | undefined;
	let failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			const roles = await tx.unsafe(`SELECT current_user AS current_role,
			  session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			if (!Array.isArray(roles) || roles.length !== 1
				|| roles[0]?.current_role !== BUYER_LOGIN
				|| roles[0]?.session_role !== BUYER_LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') {
				throw new TypeError('PostgreSQL legacy buyer direct LOGIN mismatch');
			}
			const rows = await tx.unsafe(`SELECT
			  cinatoken_gateway.settle_legacy_buyer_held_v368(
			    $1::text,$2::bigint,$3::bigint,$4::text) AS value`,
				[requestId, ordinarySettledMicros, guardrailSettledMicros, reason]);
			if (!Array.isArray(rows) || rows.length !== 1
				|| !rows[0]?.value || typeof rows[0].value !== 'object'
				|| Array.isArray(rows[0].value)) {
				throw new TypeError('PostgreSQL legacy buyer response invalid');
			}
			return rows[0].value as Record<string, unknown>;
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') {
			throw new Error('PostgreSQL legacy buyer LOGIN close did not acknowledge');
		}
		await closed;
	} catch (cleanupError) {
		throw new PostgresLegacyBuyerHeldCleanupUnconfirmedError(
			failure === undefined ? cleanupError
				: new AggregateError([failure, cleanupError],
					'Legacy buyer operation and LOGIN close failed'));
	}
	if (failure !== undefined) throw failure;
	if (result?.status !== 'legacy_settled') {
		if (typeof result?.status === 'string' && result.status.length <= 80) {
			throw new PostgresLegacyBuyerHeldRejectedError(result.status);
		}
		throw new TypeError('PostgreSQL legacy buyer response invalid');
	}
	if (result.requestId !== requestId
		|| result.ordinarySettledMicros !== ordinarySettledMicros
		|| result.guardrailSettledMicros !== guardrailSettledMicros
		|| !Number.isSafeInteger(result.guardrailRows)
		|| (result.guardrailRows as number) < 1
		|| (result.guardrailRows as number) > 32) {
		throw new TypeError('PostgreSQL legacy buyer response mismatch');
	}
	return Object.freeze({
		status: 'legacy_settled', commitAcknowledged: true,
		requestId, ordinarySettledMicros, guardrailSettledMicros,
		guardrailRows: result.guardrailRows as number,
	});
}
