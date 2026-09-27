import postgres from 'postgres';
import type { PostgresDatabaseClient, UserBudgetReservationsRepository } from '@octafuse/core';

type RecoverySql = PostgresDatabaseClient['raw'];
type RecoverySqlFactory = (connectionString: string, options: { max: 1 }) => RecoverySql;
type SqlStatement = Pick<RecoverySql, 'unsafe'>;
type RecoveryPort = Pick<UserBudgetReservationsRepository, 'forfeitDispatched' | 'expireBefore'>;

const RUNTIME_LOGIN = 'cinatoken_gateway_runtime';
const RECOVERY_LOGIN = 'cinatoken_gateway_budget_recovery';

export class PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError extends Error {
	constructor() {
		super('PostgreSQL ordinary budget recovery client cleanup was not confirmed');
		this.name = 'PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError';
	}
}

function validConnectionString(value: string, label: string): string {
	if (typeof value !== 'string' || !value || value !== value.trim()) {
		throw new TypeError(`${label} PostgreSQL connection string required`);
	}
	let url: URL;
	try { url = new URL(value); }
	catch { throw new TypeError(`Invalid ${label} PostgreSQL connection string`); }
	const query = [...url.searchParams];
	if ((url.protocol !== 'postgres:' && url.protocol !== 'postgresql:')
		|| !url.hostname || !url.username || !url.password
		|| !url.pathname || url.pathname === '/' || url.hash
		|| (query.length !== 0 && (query.length !== 1
			|| query[0][0].toLowerCase() !== 'sslmode'
			|| !['disable', 'require'].includes(query[0][1])))) {
		throw new TypeError(`Invalid ${label} PostgreSQL connection string`);
	}
	return value;
}

async function requireLogin(sql: SqlStatement, expected: string): Promise<void> {
	let rows: unknown;
	try { rows = await sql.unsafe('SELECT current_user AS current_role, session_user AS session_role'); }
	catch { throw new Error(`PostgreSQL ordinary budget ${expected} LOGIN preflight failed`); }
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new Error(`PostgreSQL ordinary budget ${expected} LOGIN role mismatch`);
	}
}

async function confirmedClose(sql: RecoverySql): Promise<void> {
	try {
		const completion = sql.end({ timeout: 1 });
		if (!completion || typeof completion.then !== 'function') {
			throw new PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError();
		}
		await completion;
	} catch { throw new PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError(); }
}

function count(rows: unknown, maximum: number): number {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
		throw new Error('PostgreSQL ordinary budget recovery response invalid');
	}
	const value = rows[0].value;
	if (typeof value !== 'number' || !Number.isInteger(value)
		|| value < 0 || value > maximum) {
		throw new Error('PostgreSQL ordinary budget recovery response invalid');
	}
	return value;
}

/**
 * Review-only, direct LOGIN owner. No route or maintenance scheduler opens it
 * by default. Its caller closes it in finally and never retries an unknown
 * COMMIT automatically. It is intentionally separate from admission.
 */
export async function openPostgresOrdinaryBudgetRecoveryOwner(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		recoveryConnectionString: string;
	},
	createSql: RecoverySqlFactory = postgres,
): Promise<{ readonly recovery: RecoveryPort; close(): Promise<void> }> {
	if (params.runtimeClient.driver !== 'postgres') {
		throw new TypeError('PostgreSQL ordinary budget recovery requires PostgreSQL runtime storage');
	}
	const runtimeConnectionString = validConnectionString(params.runtimeConnectionString, 'runtime');
	const recoveryConnectionString = validConnectionString(params.recoveryConnectionString, 'recovery');
	if (runtimeConnectionString === recoveryConnectionString) {
		throw new TypeError('PostgreSQL ordinary budget runtime and recovery connections must be distinct');
	}
	await requireLogin(params.runtimeClient.raw, RUNTIME_LOGIN);
	let sql: RecoverySql;
	try { sql = createSql(recoveryConnectionString, { max: 1 }); }
	catch { throw new Error('PostgreSQL ordinary budget recovery client open failed'); }
	if (sql === params.runtimeClient.raw) {
		throw new TypeError('PostgreSQL ordinary budget runtime and recovery clients must be distinct');
	}
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	const statement = async <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> =>
		transactional.begin(async tx => {
			await requireLogin(tx, RECOVERY_LOGIN);
			return callback(tx);
		});
	try { await statement(async () => undefined); }
	catch (error) { await confirmedClose(sql); throw error; }

	let state: 'open' | 'closing' = 'open';
	let closing: Promise<void> | undefined;
	const inFlight = new Set<Promise<unknown>>();
	const run = <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> => {
		if (state !== 'open') throw new Error('PostgreSQL ordinary budget recovery owner is closed');
		const operation = statement(callback).finally(() => { inFlight.delete(operation); });
		inFlight.add(operation);
		return operation;
	};
	return {
		recovery: {
			forfeitDispatched: (requestId, nowIso, reason) =>
				run(async tx => count(await tx.unsafe(`SELECT
					cinatoken_gateway.forfeit_user_budget_dispatched_v354(
						$1,$2::timestamptz,$3) AS value`,
					[requestId, nowIso, reason]), 1)),
			expireBefore: (nowIso, limit = 100) => {
				if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
					throw new TypeError('PostgreSQL ordinary budget recovery limit must be 1-100');
				}
				return run(async tx => count(await tx.unsafe(`SELECT
					cinatoken_gateway.expire_user_budget_leases_v354(
						$1::timestamptz,$2::integer) AS value`,
					[nowIso, limit]), limit));
			},
		},
		close() {
			closing ??= (async () => {
				state = 'closing';
				await Promise.allSettled([...inFlight]);
				await confirmedClose(sql);
			})();
			return closing;
		},
	};
}
