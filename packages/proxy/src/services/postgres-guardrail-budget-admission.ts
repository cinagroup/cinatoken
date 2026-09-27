import postgres from 'postgres';
import type {
	GuardrailBudgetsRepository,
	PostgresDatabaseClient,
	ReserveGuardrailBudgetsParams,
	ReserveGuardrailBudgetsResult,
} from '@octafuse/core';

type AdmissionSql = PostgresDatabaseClient['raw'];
type AdmissionSqlFactory = (connectionString: string, options: { max: 1 }) => AdmissionSql;
type SqlStatement = Pick<AdmissionSql, 'unsafe'>;

const RUNTIME_LOGIN = 'cinatoken_gateway_runtime';
const ADMISSION_LOGIN = 'cinatoken_gateway_budget_admission';

export class PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError extends Error {
	constructor() {
		super('PostgreSQL Guardrail admission client cleanup was not confirmed');
		this.name = 'PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError';
	}
}

export class PostgresGuardrailBudgetAdmissionUnsupportedTransitionError extends Error {
	constructor(operation: 'extendDispatched' | 'forfeitMany' | 'expireBefore') {
		super(`PostgreSQL Guardrail admission LOGIN cannot execute ${operation}`);
		this.name = 'PostgresGuardrailBudgetAdmissionUnsupportedTransitionError';
	}
}

type SupportedAdmission = Pick<GuardrailBudgetsRepository,
	'reserveMany' | 'markDispatched' | 'releaseMany'>;

/**
 * Request-scoped, review-only port. It is deliberately not a complete
 * GuardrailBudgetsRepository: the current coordinator catches expiry errors,
 * and a direct substitution would silently skip required recovery work.
 */
export type PostgresGuardrailBudgetAdmissionOwner = {
	readonly guardrailAdmission: SupportedAdmission;
	readonly unsupported: Pick<GuardrailBudgetsRepository,
		'extendDispatched' | 'forfeitMany' | 'expireBefore'>;
	close(): Promise<void>;
};

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

function boundedId(value: string, label: string, maximum = 128): string {
	if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
		throw new TypeError(`PostgreSQL Guardrail admission ${label} must contain 1-${maximum} characters`);
	}
	return value;
}

async function requireLogin(sql: SqlStatement, expected: string): Promise<void> {
	let rows: unknown;
	try { rows = await sql.unsafe('SELECT current_user AS current_role, session_user AS session_role'); }
	catch { throw new Error(`PostgreSQL Guardrail ${expected} LOGIN preflight failed`); }
	if (!Array.isArray(rows) || rows.length !== 1
		|| rows[0]?.current_role !== expected || rows[0]?.session_role !== expected) {
		throw new Error(`PostgreSQL Guardrail ${expected} LOGIN role mismatch`);
	}
}

async function confirmedClose(sql: AdmissionSql): Promise<void> {
	try {
		const completion = sql.end({ timeout: 1 });
		if (!completion || typeof completion.then !== 'function') {
			throw new PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError();
		}
		await completion;
	} catch { throw new PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError(); }
}

function singleValue(rows: unknown): unknown {
	if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
		|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
		throw new Error('PostgreSQL Guardrail admission function response invalid');
	}
	return rows[0].value;
}

function reserveResult(value: unknown, params: ReserveGuardrailBudgetsParams): ReserveGuardrailBudgetsResult {
	if (!value || typeof value !== 'object' || !('status' in value)) {
		throw new Error('PostgreSQL Guardrail reservation response invalid');
	}
	switch (value.status) {
		case 'reserved':
		case 'idempotent':
			if ('reservationCount' in value && value.reservationCount === params.intents.length) {
				return { status: value.status, reservationCount: params.intents.length };
			}
			break;
		case 'blocked':
			if ('assignmentId' in value && typeof value.assignmentId === 'string'
				&& params.intents.some(intent => intent.assignmentId === value.assignmentId)) {
				return { status: 'blocked', assignmentId: value.assignmentId };
			}
			break;
		case 'stale':
			return { status: 'conflict', message: 'Guardrail budget configuration changed; retry the request' };
		case 'conflict':
			return { status: 'conflict', message: 'Guardrail budget reservation conflicts with current state' };
	}
	throw new Error('PostgreSQL Guardrail reservation response invalid');
}

/**
 * Explicit, request-scoped candidate for the v351 function-only LOGIN.
 * No route, Worker, or coordinator opens this by default. Its caller must
 * close() in a request finally block and must not retry an unknown COMMIT.
 */
export async function openPostgresGuardrailBudgetAdmissionOwner(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		admissionConnectionString: string;
		requestId: string;
		userId: string;
		apiKeyId: string;
	},
	createSql: AdmissionSqlFactory = postgres,
): Promise<PostgresGuardrailBudgetAdmissionOwner> {
	if (params.runtimeClient.driver !== 'postgres') {
		throw new TypeError('PostgreSQL Guardrail admission requires PostgreSQL runtime storage');
	}
	const requestId = boundedId(params.requestId, 'requestId');
	const userId = boundedId(params.userId, 'userId', 512);
	const apiKeyId = boundedId(params.apiKeyId, 'apiKeyId', 512);
	const runtimeConnectionString = validConnectionString(params.runtimeConnectionString, 'runtime');
	const admissionConnectionString = validConnectionString(params.admissionConnectionString, 'admission');
	if (runtimeConnectionString === admissionConnectionString) {
		throw new TypeError('PostgreSQL Guardrail runtime and admission connections must be distinct');
	}
	await requireLogin(params.runtimeClient.raw, RUNTIME_LOGIN);
	let sql: AdmissionSql;
	try { sql = createSql(admissionConnectionString, { max: 1 }); }
	catch { throw new Error('PostgreSQL Guardrail admission client open failed'); }
	if (sql === params.runtimeClient.raw) {
		throw new TypeError('PostgreSQL Guardrail runtime and admission clients must be distinct');
	}
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T>;
	};
	const statement = async <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> =>
		transactional.begin(async tx => {
			await requireLogin(tx, ADMISSION_LOGIN);
			return callback(tx);
		});
	try { await statement(async () => undefined); }
	catch (error) { await confirmedClose(sql); throw error; }

	let state: 'open' | 'closing' = 'open';
	let closing: Promise<void> | undefined;
	const inFlight = new Set<Promise<unknown>>();
	const run = <T>(callback: (tx: SqlStatement) => Promise<T>): Promise<T> => {
		if (state !== 'open') throw new Error('PostgreSQL Guardrail admission owner is closed');
		const operation = statement(callback).finally(() => { inFlight.delete(operation); });
		inFlight.add(operation);
		return operation;
	};
	const sameRequest = (value: string): void => {
		if (value !== requestId) throw new Error('PostgreSQL Guardrail admission request identity differs');
	};
	const unsupported = (operation: 'extendDispatched' | 'forfeitMany' | 'expireBefore') => {
		throw new PostgresGuardrailBudgetAdmissionUnsupportedTransitionError(operation);
	};
	return {
		guardrailAdmission: {
			reserveMany: values => {
				sameRequest(values.requestId);
				// A queued BEGIN/role check must not observe later caller mutations.
				const submitted: ReserveGuardrailBudgetsParams = {
					requestId,
					intents: values.intents.map(intent => ({ ...intent })),
					reservedMicros: values.reservedMicros,
					settlementBasis: values.settlementBasis,
					nowIso: values.nowIso,
					expiresAtIso: values.expiresAtIso,
				};
				return run(async tx => reserveResult(singleValue(await tx.unsafe(`SELECT
					cinatoken_gateway.reserve_guardrail_budgets_v351(
						$1,$2,$3,$4::jsonb,$5::bigint,$6,$7::timestamptz,$8::timestamptz
					) AS value`, [requestId,userId,apiKeyId,sql.json(submitted.intents),
						submitted.reservedMicros,submitted.settlementBasis ?? 'charged',
						submitted.nowIso,submitted.expiresAtIso])), submitted));
			},
			markDispatched: (value, nowIso, expiresAtIso) => {
				sameRequest(value);
				return run(async tx => {
					const result = singleValue(await tx.unsafe(`SELECT
						cinatoken_gateway.mark_guardrail_budgets_dispatched_v351(
							$1,$2::timestamptz,$3::timestamptz) AS value`,
						[requestId,nowIso,expiresAtIso]));
					if (typeof result !== 'boolean') {
						throw new Error('PostgreSQL Guardrail dispatch response invalid');
					}
					return result;
				});
			},
			releaseMany: (value, nowIso, reason) => {
				sameRequest(value);
				if (reason === 'guardrail_budget_admission_rejected') {
					throw new Error('Guardrail denial receipt requires buyer settlement LOGIN');
				}
				return run(async tx => {
					const result = singleValue(await tx.unsafe(`SELECT
						cinatoken_gateway.release_guardrail_budgets_v351(
							$1,$2::timestamptz,$3) AS value`,
						[requestId,nowIso,reason]));
					if (typeof result !== 'number' || !Number.isInteger(result)
						|| result < 0 || result > 7) {
						throw new Error('PostgreSQL Guardrail release response invalid');
					}
					return result;
				});
			},
		},
		unsupported: {
			extendDispatched: async () => unsupported('extendDispatched'),
			forfeitMany: async () => unsupported('forfeitMany'),
			expireBefore: async () => unsupported('expireBefore'),
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
