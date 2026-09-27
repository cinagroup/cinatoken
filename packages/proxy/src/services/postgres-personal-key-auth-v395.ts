import postgres from 'postgres';
import { resolveMeMetadata } from '../../../core/src/lib/resolve-me-metadata';
import type { PostgresDatabaseClient } from '@octafuse/core';
import type { AuthenticatedApiKey } from './api-key-auth';

type SqlClient = PostgresDatabaseClient['raw'];
type SqlFactory = (connection: string, options: { max: 1 }) => SqlClient;
type Statement = Pick<SqlClient, 'unsafe'>;
const LOGIN = 'cinatoken_gateway_personal_key_auth';
const encoder = new TextEncoder();
export type AuthenticatedPersonalKeyV395 = Readonly<AuthenticatedApiKey & { keyLimitEpoch: number }>;

export class PostgresPersonalPeriodPendingV395 extends Error {
	constructor() {
		super('Personal budget period is waiting for unresolved obligations');
		this.name = 'PostgresPersonalPeriodPendingV395';
	}
}
export class PostgresPersonalAuthCleanupUnconfirmedV395 extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL personal auth LOGIN cleanup unconfirmed', { cause });
		this.name = 'PostgresPersonalAuthCleanupUnconfirmedV395';
	}
}
function invalid(): never { throw new TypeError('PostgreSQL personal auth contract invalid'); }
function bounded(value: unknown, max: number): value is string {
	return typeof value === 'string' && value.length > 0 && encoder.encode(value).length <= max;
}
function nullableText(value: unknown, max: number): value is string | null {
	return value === null || (typeof value === 'string' && encoder.encode(value).length <= max);
}
function money(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0
		&& Number.isSafeInteger(Math.round(value * 1_000_000))
		&& Math.abs(value * 1_000_000 - Math.round(value * 1_000_000)) < 0.001;
}
function deepFreeze(value: unknown): void {
	if (value && typeof value === 'object' && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
}
function parse(value: unknown): AuthenticatedPersonalKeyV395 | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
	const row = value as Record<string, unknown>;
	if (row.status !== 'authenticated') {
		if (Object.keys(row).join(',') !== 'status') invalid();
		if (row.status === 'unauthorized') return null;
		if (row.status === 'period_reset_pending') throw new PostgresPersonalPeriodPendingV395();
		return invalid();
	}
	if (Object.keys(row).sort().join(',') !== 'budgetEpoch,budgetMax,budgetPeriod,budgetResetAt,budgetSpent,chargedCostFactors,includeByokInLimit,keyId,keyLimitEpoch,keyMetadata,status,userEmail,userId,userMetadata,workspaceId'
		|| !bounded(row.keyId, 512) || !bounded(row.userId, 512) || !bounded(row.workspaceId, 512)
		|| !nullableText(row.userEmail, 512) || !nullableText(row.userMetadata, 65_536) || !nullableText(row.keyMetadata, 65_536)
		|| !nullableText(row.chargedCostFactors, 16_384) || typeof row.includeByokInLimit !== 'boolean'
		|| (row.budgetMax !== null && !money(row.budgetMax)) || !money(row.budgetSpent)
		|| !Number.isSafeInteger(row.budgetEpoch) || (row.budgetEpoch as number) < 0
		|| !Number.isInteger(row.keyLimitEpoch) || (row.keyLimitEpoch as number) < 0 || (row.keyLimitEpoch as number) > 2_147_483_646
		|| !['none', 'daily', 'weekly', 'monthly'].includes(row.budgetPeriod as string)
		|| (row.budgetResetAt !== null && (typeof row.budgetResetAt !== 'string'
			|| !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(row.budgetResetAt)
			|| !Number.isFinite(Date.parse(row.budgetResetAt))))) invalid();
	const metadata = resolveMeMetadata(row.userMetadata, row.keyMetadata);
	deepFreeze(metadata);
	return Object.freeze({ keyId: row.keyId, keyLimitEpoch: row.keyLimitEpoch as number,
		userId: row.userId, workspaceId: row.workspaceId, userEmail: row.userEmail,
		budgetMax: row.budgetMax as number | null, budgetSpent: row.budgetSpent,
		budgetEpoch: row.budgetEpoch as number, budgetPeriod: row.budgetPeriod as string,
		budgetResetAt: row.budgetResetAt as string | null, includeByokInLimit: row.includeByokInLimit,
		metadata, chargedCostFactors: row.chargedCostFactors });
}
const open: SqlFactory = connection => postgres(connection, { max: 1, prepare: false,
	fetch_types: false, connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false });

/**
 * Modern/legacy bearer authentication and due-period maintenance are one owned
 * SQL transaction. Resolution requires COMMIT and close; cancellation never
 * races a financial write. A pending period is not an authenticated context.
 */
export async function authenticatePostgresPersonalKeyV395(params: {
	authConnectionString: string; bearer: string; signal?: AbortSignal;
}, factory: SqlFactory = open): Promise<AuthenticatedPersonalKeyV395 | null> {
	const signal = params.signal, bearer = params.bearer, connection = params.authConnectionString;
	signal?.throwIfAborted();
	let url: URL;
	try { url = new URL(connection); } catch { return invalid(); }
	if (typeof connection !== 'string' || connection !== connection.trim()
		|| !['postgres:', 'postgresql:'].includes(url.protocol) || decodeURIComponent(url.username) !== LOGIN
		|| !url.hostname || !url.password || !url.pathname || url.pathname === '/' || url.hash
		|| [...url.searchParams].length > 1 || [...url.searchParams].some(([key, value]) =>
			key.toLowerCase() !== 'sslmode' || !['disable', 'require'].includes(value))
		|| typeof bearer !== 'string' || encoder.encode(bearer).length < 16 || encoder.encode(bearer).length > 512) invalid();
	const sql = factory(connection, { max: 1 });
	const transactional = sql as unknown as { begin<T>(work: (tx: Statement) => Promise<T>): Promise<T> };
	let result: AuthenticatedPersonalKeyV395 | null | undefined, failure: unknown;
	try {
		result = await transactional.begin(async tx => {
			signal?.throwIfAborted();
			const roles = await tx.unsafe(`SELECT current_user AS current_role, session_user AS session_role,
			  pg_catalog.current_setting('transaction_isolation') AS transaction_isolation`);
			signal?.throwIfAborted();
			if (roles.length !== 1 || roles[0]?.current_role !== LOGIN || roles[0]?.session_role !== LOGIN
				|| roles[0]?.transaction_isolation !== 'read committed') invalid();
			await tx.unsafe("SET LOCAL lock_timeout='2s'"); signal?.throwIfAborted();
			await tx.unsafe("SET LOCAL statement_timeout='15s'"); signal?.throwIfAborted();
			const rows = await tx.unsafe('SELECT cinatoken_gateway.authenticate_personal_gateway_key_v395($1::text) AS value', [bearer]);
			signal?.throwIfAborted();
			if (rows.length !== 1 || !Object.hasOwn(rows[0]!, 'value')) invalid();
			return parse(rows[0]!.value);
		});
	} catch (error) { failure = error; }
	try {
		const closed = sql.end({ timeout: 1 });
		if (!closed || typeof closed.then !== 'function') throw new Error('Auth LOGIN close did not acknowledge');
		await closed;
	} catch (error) {
		throw new PostgresPersonalAuthCleanupUnconfirmedV395(failure === undefined ? error
			: new AggregateError([failure, error], 'Auth operation and LOGIN cleanup failed'));
	}
	if (failure !== undefined) throw failure;
	signal?.throwIfAborted();
	if (result === undefined) invalid();
	return result;
}
