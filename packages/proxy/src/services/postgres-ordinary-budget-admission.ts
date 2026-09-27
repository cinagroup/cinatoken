import postgres from 'postgres';
import type { PostgresDatabaseClient, ReserveUserBudgetResult } from '@octafuse/core';
import type { OrdinaryBudgetRepositories } from './ordinary-budget-lifecycle';

type AdmissionSql = PostgresDatabaseClient['raw'];
type AdmissionSqlFactory = (connectionString: string, options: { max: 1 }) => AdmissionSql;
type SqlStatement = Pick<AdmissionSql, 'unsafe'>;

const RUNTIME_LOGIN = 'cinatoken_gateway_runtime';
const ADMISSION_LOGIN = 'cinatoken_gateway_budget_admission';

export class PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError extends Error {
	constructor() {
		super('PostgreSQL ordinary budget admission client cleanup was not confirmed');
		this.name = 'PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError';
	}
}

export class PostgresOrdinaryBudgetAdmissionUnsupportedTransitionError extends Error {
	constructor() {
		super('PostgreSQL admission LOGIN cannot forfeit a dispatched ordinary budget lease');
		this.name = 'PostgresOrdinaryBudgetAdmissionUnsupportedTransitionError';
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
	try {
		rows = await sql.unsafe('SELECT current_user AS current_role, session_user AS session_role');
	} catch {
		throw new Error(`PostgreSQL ordinary budget ${expected} LOGIN preflight failed`);
	}
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new Error(`PostgreSQL ordinary budget ${expected} LOGIN role mismatch`);
	}
}

async function confirmedClose(sql: AdmissionSql): Promise<void> {
	try {
		const completion = sql.end({ timeout: 1 });
		if (!completion || typeof completion.then !== 'function') {
			throw new PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError();
		}
		await completion;
	} catch {
		throw new PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError();
	}
}

function safeMicros(value: unknown): number | null {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? value : null;
}

function singleValue(rows: unknown, field: string): unknown {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !(field in rows[0])) {
		throw new Error(`PostgreSQL ordinary budget admission ${field} response invalid`);
	}
	return rows[0][field];
}

function reserveResult(value: unknown, params: {
	requestId: string; userId: string; apiKeyId: string;
	expectedBudgetEpoch: number; reservedMicros: number;
}): ReserveUserBudgetResult {
	if (!value || typeof value !== 'object' || !('status' in value)) {
		throw new Error('PostgreSQL ordinary budget reservation response invalid');
	}
	switch (value.status) {
		case 'reserved':
		case 'idempotent': {
			const limitMicros = 'limitMicros' in value ? safeMicros(value.limitMicros) : null;
			if (limitMicros === null || limitMicros < params.reservedMicros) break;
			return {
				status: value.status,
				reservation: {
					requestId: params.requestId,
					userId: params.userId,
					apiKeyId: params.apiKeyId,
					budgetEpoch: params.expectedBudgetEpoch,
					limitMicros,
					reservedMicros: params.reservedMicros,
				},
			};
		}
		case 'blocked': {
			const remainingMicros = 'remainingMicros' in value
				? safeMicros(value.remainingMicros) : null;
			if (remainingMicros === null) break;
			return { status: 'blocked', remainingMicros };
		}
		case 'stale': return { status: 'stale', budgetResetAt: null };
		case 'unlimited': return { status: 'unlimited' };
		case 'conflict': return {
			status: 'conflict', message: 'Ordinary budget reservation conflicts with current account state',
		};
	}
	throw new Error('PostgreSQL ordinary budget reservation response invalid');
}

/**
 * Explicit, request-scoped candidate for the v350 SECURITY DEFINER API.
 * The caller owns close() in its request finally block. No route opens it by
 * default; an unknown COMMIT outcome rejects and is never silently retried.
 */
export async function openPostgresOrdinaryBudgetAdmissionOwner(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		admissionConnectionString: string;
	},
	createSql: AdmissionSqlFactory = postgres,
): Promise<{
	readonly ordinaryBudgetRepositories: OrdinaryBudgetRepositories;
	close(): Promise<void>;
}> {
	if (params.runtimeClient.driver !== 'postgres') {
		throw new TypeError('PostgreSQL ordinary budget admission requires PostgreSQL runtime storage');
	}
	const runtimeConnectionString = validConnectionString(
		params.runtimeConnectionString, 'runtime');
	const admissionConnectionString = validConnectionString(
		params.admissionConnectionString, 'admission');
	if (runtimeConnectionString === admissionConnectionString) {
		throw new TypeError('PostgreSQL ordinary budget runtime and admission connections must be distinct');
	}
	await requireLogin(params.runtimeClient.raw, RUNTIME_LOGIN);

	let sql: AdmissionSql;
	try { sql = createSql(admissionConnectionString, { max: 1 }); }
	catch { throw new Error('PostgreSQL ordinary budget admission client open failed'); }
	if (sql === params.runtimeClient.raw) {
		throw new TypeError('PostgreSQL ordinary budget runtime and admission clients must be distinct');
	}
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	const statement = async <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> => transactional.begin(async tx => {
		await requireLogin(tx, ADMISSION_LOGIN);
		return callback(tx);
	});
	try { await statement(async () => undefined); }
	catch (error) {
		await confirmedClose(sql);
		throw error;
	}

	let state: 'open' | 'closing' = 'open';
	let closing: Promise<void> | undefined;
	const inFlight = new Set<Promise<unknown>>();
	const run = <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> => {
		if (state !== 'open') {
			throw new Error('PostgreSQL ordinary budget admission owner is closed');
		}
		const operation = statement(callback).finally(() => { inFlight.delete(operation); });
		inFlight.add(operation);
		return operation;
	};
	return {
		ordinaryBudgetRepositories: {
			userBudgets: {
				reserve: params => run(async tx => reserveResult(singleValue(
					await tx.unsafe(`SELECT cinatoken_gateway.reserve_user_budget_v350(
						$1,$2,$3,$4::bigint,$5::bigint,$6::timestamptz,$7::timestamptz
					) AS value`, [params.requestId, params.userId, params.apiKeyId,
						params.expectedBudgetEpoch, params.reservedMicros, params.nowIso,
						params.expiresAtIso]), 'value'), params)),
				markDispatched: (requestId, nowIso, expiresAtIso) => run(async tx => {
					const marked = singleValue(await tx.unsafe(`SELECT
						cinatoken_gateway.mark_user_budget_dispatched_v350(
							$1,$2::timestamptz,$3::timestamptz) AS value`,
						[requestId, nowIso, expiresAtIso]), 'value');
					if (typeof marked !== 'boolean') {
						throw new Error('PostgreSQL ordinary budget dispatch response invalid');
					}
					return marked;
				}),
				release: (requestId, nowIso, reason) => run(async tx => {
					const released = singleValue(await tx.unsafe(`SELECT
						cinatoken_gateway.release_user_budget_v350(
							$1,$2::timestamptz,$3) AS value`,
						[requestId, nowIso, reason]), 'value');
					if (released !== 0 && released !== 1) {
						throw new Error('PostgreSQL ordinary budget release response invalid');
					}
					return released;
				}),
				// Recovery belongs to a separate maintenance owner. Skip the old
				// opportunistic runtime DML; capacity remains conservatively held.
				expireBefore: async () => 0,
				// The admission LOGIN has no post-dispatch settlement authority.
				// Preserve the dispatched ceiling for the recovery owner.
				forfeitDispatched: async () => {
					throw new PostgresOrdinaryBudgetAdmissionUnsupportedTransitionError();
				},
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
