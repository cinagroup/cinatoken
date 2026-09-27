import postgres from 'postgres';
import type {
	PostgresDatabaseClient,
	ReserveGuardrailBudgetsParams,
	ReserveGuardrailBudgetsResult,
} from '@octafuse/core';
import {
	openPostgresGuardrailBudgetAdmissionOwner,
	type PostgresGuardrailBudgetAdmissionOwner,
} from './postgres-guardrail-budget-admission';

type AdmissionSql = PostgresDatabaseClient['raw'];

export class PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError extends Error {
	constructor(cause: unknown) {
		super('PostgreSQL Guardrail lifecycle client cleanup unconfirmed', { cause });
		this.name = 'PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError';
	}
}

export type PostgresGuardrailBudgetLifecycleOwnerV353 = {
	/** DB-clock recovery must succeed before a new v351 reservation. */
	reserveAfterRecovery(values: ReserveGuardrailBudgetsParams): Promise<ReserveGuardrailBudgetsResult>;
	/** v351 request-scoped mark and pre-send release. */
	readonly admission: PostgresGuardrailBudgetAdmissionOwnerV353Port;
	/** No raw DML and no caller-supplied expiry clock. */
	forfeitDispatched(reason: string): Promise<number>;
	recoverExpired(limit: number): Promise<number>;
	close(): Promise<void>;
};

type PostgresGuardrailBudgetAdmissionOwnerV353Port = {
	readonly markDispatched: PostgresGuardrailBudgetAdmissionOwner['guardrailAdmission']['markDispatched'];
	readonly releaseMany: PostgresGuardrailBudgetAdmissionOwner['guardrailAdmission']['releaseMany'];
	readonly extendDispatched: PostgresGuardrailBudgetAdmissionOwner['unsupported']['extendDispatched'];
};

/**
 * Default-off v353 candidate. The v351 base owner remains a narrow port, and
 * extension is still explicitly unsupported. No coordinator opens this port.
 * A request owner may forfeit only its fixed request ID. Recovery is a
 * separate database-clock operation that may be run by a bounded worker.
 */
export async function openPostgresGuardrailBudgetLifecycleOwnerV353(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		admissionConnectionString: string;
		requestId: string;
		userId: string;
		apiKeyId: string;
	},
	createSql: (connectionString: string, options: { max: 1 }) => AdmissionSql = postgres,
): Promise<PostgresGuardrailBudgetLifecycleOwnerV353> {
	const requestId = params.requestId;
	const admissionConnectionString = params.admissionConnectionString;
	const base = await openPostgresGuardrailBudgetAdmissionOwner(params, createSql);
	let sql: AdmissionSql;
	try { sql = createSql(admissionConnectionString, { max: 1 }); }
	catch (error) { await base.close(); throw error; }
	if (sql === params.runtimeClient.raw) {
		await base.close();
		throw new Error('PostgreSQL Guardrail lifecycle client must be distinct from runtime');
	}
	const requireDirectLogin = async (tx: Pick<AdmissionSql, 'unsafe'>): Promise<void> => {
		const rows = await tx.unsafe('SELECT current_user AS current_role, session_user AS session_role');
		if (rows.length !== 1 || rows[0]?.current_role !== 'cinatoken_gateway_budget_admission'
			|| rows[0]?.session_role !== 'cinatoken_gateway_budget_admission') {
			throw new Error('PostgreSQL Guardrail lifecycle LOGIN role mismatch');
		}
	};
	const confirmedSqlClose = async (): Promise<void> => {
		const completion = sql.end({ timeout: 1 });
		if (!completion || typeof completion.then !== 'function') {
			throw new Error('PostgreSQL Guardrail lifecycle close acknowledgement missing');
		}
		await completion;
	};
	const closeBoth = async (): Promise<void> => {
		const results = await Promise.allSettled([
			confirmedSqlClose(),
			(async () => { await base.close(); })(),
		]);
		const failures = results.flatMap(result =>
			result.status === 'rejected' ? [result.reason] : []);
		if (failures.length > 0) {
			throw new PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError(
				new AggregateError(failures, 'One or more Guardrail lifecycle closes were unconfirmed'),
			);
		}
	};
	try { await sql.begin(async tx => { await requireDirectLogin(tx); }); }
	catch (error) {
		try { await closeBoth(); }
		catch (cleanupError) {
			throw new PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError(
				new AggregateError([error, cleanupError], 'Guardrail lifecycle preflight and cleanup failed'),
			);
		}
		throw error;
	}
	let state: 'open' | 'closing' = 'open';
	let closing: Promise<void> | undefined;
	const inFlight = new Set<Promise<unknown>>();
	const transactional = sql as unknown as {
		begin<T>(callback: (tx: Pick<AdmissionSql, 'unsafe'>) => Promise<T>): Promise<T>;
	};
	const run = <T>(fn: (tx: Pick<AdmissionSql, 'unsafe'>) => Promise<T>): Promise<T> => {
		if (state !== 'open') throw new Error('PostgreSQL Guardrail lifecycle owner is closed');
		const operation = transactional.begin(async tx => {
			await requireDirectLogin(tx);
			return fn(tx);
		}).finally(() => { inFlight.delete(operation); });
		inFlight.add(operation);
		return operation;
	};
	const scalarCount = (rows: unknown, operation: string, maximum: number): number => {
		if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.value !== 'number'
			|| !Number.isInteger(rows[0].value) || rows[0].value < 0 || rows[0].value > maximum) {
			throw new Error(`PostgreSQL Guardrail ${operation} response invalid`);
		}
		return rows[0].value;
	};
	const recoverExpired = (limit: number): Promise<number> => {
		if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
			throw new TypeError('PostgreSQL Guardrail recovery limit must be 1-50');
		}
		return run(async tx => scalarCount(await tx.unsafe(
			'SELECT cinatoken_gateway.expire_guardrail_budgets_v353($1::integer) AS value',
			[limit],
		), 'recovery', limit));
	};
	return {
		admission: {
			markDispatched: base.guardrailAdmission.markDispatched,
			releaseMany: base.guardrailAdmission.releaseMany,
			extendDispatched: base.unsupported.extendDispatched,
		},
		async reserveAfterRecovery(values) {
			if (state !== 'open') throw new Error('PostgreSQL Guardrail lifecycle owner is closed');
			if (values.requestId !== requestId) {
				throw new Error('PostgreSQL Guardrail lifecycle request identity differs');
			}
			const submitted: ReserveGuardrailBudgetsParams = {
				requestId,
				intents: values.intents.map(intent => ({ ...intent })),
				reservedMicros: values.reservedMicros,
				settlementBasis: values.settlementBasis,
				nowIso: values.nowIso,
				expiresAtIso: values.expiresAtIso,
			};
			for (let pass = 0; pass < 4; pass += 1) {
				const recovered = await recoverExpired(50);
				if (recovered < 50) return base.guardrailAdmission.reserveMany(submitted);
			}
			throw new Error('PostgreSQL Guardrail recovery backlog was not drained');
		},
		forfeitDispatched(reason) {
			if (typeof reason !== 'string' || reason.length < 1 || reason.length > 128
				|| reason === 'guardrail_budget_admission_rejected') {
				throw new TypeError('PostgreSQL Guardrail forfeit reason invalid');
			}
			return run(async tx => scalarCount(await tx.unsafe(
				'SELECT cinatoken_gateway.forfeit_guardrail_budgets_v353($1,$2) AS value',
				[requestId, reason],
			), 'forfeit', 7));
		},
		recoverExpired,
		close() {
			closing ??= (async () => {
				state = 'closing';
				await Promise.allSettled([...inFlight]);
				await closeBoth();
			})();
			return closing;
		},
	};
}
