import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { openPostgresGuardrailBudgetAdmissionOwner,
	PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError,
} from './postgres-guardrail-budget-admission';

const runtimeUrl = 'postgres://runtime:secret@db.example/gateway';
const admissionUrl = 'postgres://admission:secret@db.example/gateway';

function runtimeClient(role = 'cinatoken_gateway_runtime'): PostgresDatabaseClient {
	return { driver: 'postgres', raw: {
		unsafe: async () => [{ current_role: role, session_role: role }],
	} } as unknown as PostgresDatabaseClient;
}

function fakeSql(options: { failCommitOn?: number; failClose?: boolean; role?: string } = {}) {
	const queries: string[] = [];
	const parameters: unknown[][] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		json: (value: unknown) => ({ value }),
		begin: async <T>(callback: (tx: { unsafe: (query: string, values?: unknown[]) => Promise<unknown[]> }) => Promise<T>) => {
			begins += 1;
			const result = await callback({ unsafe: async (query, values) => {
				queries.push(query);
				if (values) parameters.push(values);
				if (query.startsWith('SELECT current_user')) {
					const role = options.role ?? 'cinatoken_gateway_budget_admission';
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('reserve_guardrail_budgets_v351')) {
					return [{ value: { status: 'reserved', reservationCount: 1 } }];
				}
				throw new Error('Unexpected SQL');
			} });
			if (begins === options.failCommitOn) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => { closes += 1; return options.failClose
			? Promise.reject(new Error('close acknowledgement lost')) : Promise.resolve(); },
	};
	return { sql: sql as unknown as PostgresDatabaseClient['raw'], queries, parameters,
		get begins() { return begins; }, get closes() { return closes; } };
}

function params() {
	return {
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
		requestId: 'request-one', userId: 'user-one', apiKeyId: 'key-one',
	};
}

function reserveParams() {
	return {
		requestId: 'request-one', reservedMicros: 100_000,
		intents: [{ workspaceId: 'workspace-one',
			assignmentId: 'gateway-key-limit:key-one',
			guardrailId: 'gateway-key-limit:key-one', guardrailVersion: 1,
			scopeType: 'api_key' as const, scopeId: 'key-one', period: 'daily' as const,
			periodStart: '2026-09-25T00:00:00.000Z',
			periodEnd: '2026-09-26T00:00:00.000Z',limitMicros: 1_000_000 }],
		nowIso: '2026-09-25T01:00:00.000Z',
		expiresAtIso: '2026-09-25T01:02:00.000Z',
	};
}

test('lost reserve COMMIT acknowledgement is surfaced without replay or raw DML', async () => {
	const fake = fakeSql({ failCommitOn: 2 });
	const owner = await openPostgresGuardrailBudgetAdmissionOwner(params(), () => fake.sql);
	await assert.rejects(owner.guardrailAdmission.reserveMany(reserveParams()),
		/COMMIT acknowledgement lost/u);
	assert.equal(fake.queries.filter(query => query.includes('reserve_guardrail_budgets_v351')).length, 1);
	assert.equal(fake.queries.some(query => /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(query)), false);
	await owner.close();
	assert.equal(fake.closes, 1);
});

test('reserve uses the call-time policy and amount while LOGIN check is pending', async () => {
	const fake = fakeSql();
	const owner = await openPostgresGuardrailBudgetAdmissionOwner(params(), () => fake.sql);
	const submitted = reserveParams();
	const expectedIntent = { ...submitted.intents[0]! };
	const reservation = owner.guardrailAdmission.reserveMany(submitted);
	submitted.intents[0]!.assignmentId = 'mutated-assignment';
	submitted.intents.push({ ...expectedIntent, assignmentId: 'extra-assignment' });
	submitted.reservedMicros = 900_000;
	assert.deepEqual(await reservation, { status: 'reserved', reservationCount: 1 });
	assert.deepEqual(fake.parameters[0]?.[3], { value: [expectedIntent] });
	assert.equal(fake.parameters[0]?.[4], 100_000);
	await owner.close();
});

test('role mismatch closes candidate and no function is invoked', async () => {
	const fake = fakeSql({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(openPostgresGuardrailBudgetAdmissionOwner(params(), () => fake.sql),
		/LOGIN role mismatch/u);
	assert.equal(fake.closes, 1);
	assert.equal(fake.queries.some(query => query.includes('reserve_guardrail_budgets_v351')), false);
});

test('unconfirmed client close is explicit', async () => {
	const fake = fakeSql({ failClose: true });
	const owner = await openPostgresGuardrailBudgetAdmissionOwner(params(), () => fake.sql);
	await assert.rejects(owner.close(), PostgresGuardrailBudgetAdmissionCleanupUnconfirmedError);
	assert.equal(fake.closes, 1);
});
