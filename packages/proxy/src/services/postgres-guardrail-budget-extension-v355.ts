import postgres from 'postgres';
import type {
	ExtendDispatchedGuardrailBudgetsParams,
	GuardrailBudgetsRepository,
	PostgresDatabaseClient,
	ReserveGuardrailBudgetsResult,
} from '@octafuse/core';
import {
	openPostgresGuardrailBudgetLifecycleOwnerV353,
	type PostgresGuardrailBudgetLifecycleOwnerV353,
} from './postgres-guardrail-budget-lifecycle-v353';

type AdmissionSql = PostgresDatabaseClient['raw'];

async function confirmedEnd(sql: AdmissionSql): Promise<void> {
	const completion = sql.end({ timeout: 1 });
	if (!completion || typeof completion.then !== 'function') {
		throw new Error('PostgreSQL Guardrail extension client cleanup unconfirmed');
	}
	await completion;
}

/** Explicit default-off owner; no route or coordinator creates it today. */
export type PostgresGuardrailBudgetExtensionOwnerV355 = {
	readonly lifecycle: PostgresGuardrailBudgetLifecycleOwnerV353;
	readonly extendDispatched: GuardrailBudgetsRepository['extendDispatched'];
	close(): Promise<void>;
};

export async function openPostgresGuardrailBudgetExtensionOwnerV355(
	params: {
		runtimeClient: PostgresDatabaseClient;
		runtimeConnectionString: string;
		admissionConnectionString: string;
		requestId: string;
		userId: string;
		apiKeyId: string;
	},
	createSql: (connectionString: string, options: { max: 1 }) => AdmissionSql = postgres,
): Promise<PostgresGuardrailBudgetExtensionOwnerV355> {
	// Preserve the authenticated owner and connection choice across the
	// asynchronous lifecycle/client preflights.
	params = Object.freeze({ ...params });
	const lifecycle = await openPostgresGuardrailBudgetLifecycleOwnerV353(params, createSql);
	let sql: AdmissionSql;
	try { sql = createSql(params.admissionConnectionString, { max: 1 }); }
	catch (error) { await lifecycle.close(); throw error; }
	if (sql === params.runtimeClient.raw) {
		await lifecycle.close();
		throw new Error('PostgreSQL Guardrail extension client must differ from runtime');
	}
	const requireDirectLogin = async (tx: Pick<AdmissionSql, 'unsafe'>): Promise<void> => {
		const rows = await tx.unsafe('SELECT current_user AS current_role, session_user AS session_role');
		if (rows.length !== 1 || rows[0]?.current_role !== 'cinatoken_gateway_budget_admission'
			|| rows[0]?.session_role !== 'cinatoken_gateway_budget_admission') {
			throw new Error('PostgreSQL Guardrail extension LOGIN role mismatch');
		}
	};
	try { await sql.begin(async tx => { await requireDirectLogin(tx); }); }
	catch (error) {
		const cleanup = await Promise.allSettled([
			Promise.resolve().then(() => confirmedEnd(sql)),
			Promise.resolve().then(() => lifecycle.close()),
		]);
		if (cleanup.some(completion => completion.status === 'rejected')) {
			throw new Error('PostgreSQL Guardrail extension preflight cleanup unconfirmed',
				{ cause: error });
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
		if (state !== 'open') throw new Error('PostgreSQL Guardrail extension owner is closed');
		const operation = transactional.begin(async tx => {
			await requireDirectLogin(tx);
			return fn(tx);
		}).finally(() => { inFlight.delete(operation); });
		inFlight.add(operation);
		return operation;
	};
	const result = (rows: unknown, values: ExtendDispatchedGuardrailBudgetsParams): ReserveGuardrailBudgetsResult => {
		if (!Array.isArray(rows) || rows.length !== 1 || !rows[0]
			|| typeof rows[0] !== 'object' || !('value' in rows[0])) {
			throw new Error('PostgreSQL Guardrail extension response invalid');
		}
		const value = rows[0].value;
		if (!value || typeof value !== 'object' || !('status' in value)) {
			throw new Error('PostgreSQL Guardrail extension response invalid');
		}
		switch (value.status) {
			case 'reserved':
			case 'idempotent':
				// The SQL must attest that its shortest committed lease covers this
				// exact dispatch request. In particular, a Key-only idempotent
				// result is not permission to send past the existing route lease.
				if ('reservationCount' in value && value.reservationCount === values.intents.length
					&& 'leaseExpiresAt' in value && typeof value.leaseExpiresAt === 'string'
					&& Number.isFinite(Date.parse(values.expiresAtIso))
					&& Number.isFinite(Date.parse(value.leaseExpiresAt))
					&& Date.parse(value.leaseExpiresAt) >= Date.parse(values.expiresAtIso)) {
					return { status: value.status, reservationCount: values.intents.length };
				}
				break;
			case 'blocked':
				if ('assignmentId' in value && typeof value.assignmentId === 'string'
					&& values.intents.some(intent => intent.assignmentId === value.assignmentId)) {
					return { status: 'blocked', assignmentId: value.assignmentId };
				}
				break;
			case 'stale':
				return { status: 'conflict', message: 'Guardrail budget configuration changed; retry the request' };
			case 'conflict':
				return { status: 'conflict', message: 'Guardrail extension conflicts with current state' };
		}
		throw new Error('PostgreSQL Guardrail extension response invalid');
	};
	return {
		lifecycle,
		extendDispatched(values) {
			if (values.requestId !== params.requestId) {
				throw new Error('PostgreSQL Guardrail extension request identity differs');
			}
			const submitted: ExtendDispatchedGuardrailBudgetsParams = {
				requestId: params.requestId,
				intents: values.intents.map(intent => ({ ...intent })),
				reservedMicros: values.reservedMicros,
				nowIso: values.nowIso,
				expiresAtIso: values.expiresAtIso,
			};
			return run(async tx => result(await tx.unsafe(`SELECT
				cinatoken_gateway.extend_guardrail_budgets_dispatched_v355(
					$1,$2,$3,$4::jsonb,$5::bigint,$6::timestamptz,$7::timestamptz
				) AS value`, [params.requestId,params.userId,params.apiKeyId,
					sql.json(submitted.intents),submitted.reservedMicros,
					submitted.nowIso,submitted.expiresAtIso]), submitted));
		},
		close() {
			closing ??= (async () => {
				state = 'closing';
				await Promise.allSettled([...inFlight]);
				const completions = await Promise.allSettled([
					Promise.resolve().then(() => confirmedEnd(sql)),
					Promise.resolve().then(() => lifecycle.close()),
				]);
				if (completions.some(completion => completion.status === 'rejected')) {
					throw new Error('PostgreSQL Guardrail extension client cleanup unconfirmed');
				}
			})();
			return closing;
		},
	};
}
