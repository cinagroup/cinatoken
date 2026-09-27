import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import {
	openPostgresGuardrailBudgetLifecycleOwnerV353,
	PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError,
} from './postgres-guardrail-budget-lifecycle-v353';

function fakeConnection(kind: 'base' | 'lifecycle', options: {
	commitLostOn?: number;
	recoveryFailure?: boolean;
	role?: string;
	failClose?: boolean;
	closeWithoutPromise?: boolean;
	throwOnClose?: boolean;
} = {}) {
	const queries: string[] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		json: (value: unknown) => value,
		begin: async <T>(callback: (tx: {
			unsafe: (query: string, values?: unknown[]) => Promise<unknown[]>;
		}) => Promise<T>) => {
			begins += 1;
			const result = await callback({ unsafe: async query => {
				queries.push(query);
				if (query.startsWith('SELECT current_user')) {
					const role = options.role ?? 'cinatoken_gateway_budget_admission';
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('expire_guardrail_budgets_v353')) {
					if (options.recoveryFailure) throw new Error('recovery failed');
					return [{ value: 0 }];
				}
				if (query.includes('reserve_guardrail_budgets_v351')) {
					return [{ value: { status: 'reserved', reservationCount: 1 } }];
				}
				if (query.includes('forfeit_guardrail_budgets_v353')) return [{ value: 1 }];
				throw new Error(`Unexpected ${kind} SQL`);
			} });
			if (begins === options.commitLostOn) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => {
			closes += 1;
			if (options.throwOnClose) throw new Error('close threw');
			if (options.closeWithoutPromise) return undefined;
			return options.failClose
				? Promise.reject(new Error('close acknowledgement lost')) : Promise.resolve();
		},
	};
	return { sql: sql as unknown as PostgresDatabaseClient['raw'], queries,
		get begins() { return begins; }, get closes() { return closes; } };
}

function setup(
	options: Parameters<typeof fakeConnection>[1] = {},
	baseOptions: Parameters<typeof fakeConnection>[1] = {},
) {
	const base = fakeConnection('base', baseOptions);
	const lifecycle = fakeConnection('lifecycle', options);
	let opens = 0;
	const factory = () => (++opens === 1 ? base.sql : lifecycle.sql);
	const runtimeRole = 'cinatoken_gateway_runtime';
	const params = {
		runtimeClient: { driver: 'postgres', raw: {
			unsafe: async () => [{ current_role: runtimeRole, session_role: runtimeRole }],
		} } as unknown as PostgresDatabaseClient,
		runtimeConnectionString: 'postgres://runtime:secret@db.example/gateway',
		admissionConnectionString: 'postgres://admission:secret@db.example/gateway',
		requestId: 'request-one', userId: 'user-one', apiKeyId: 'key-one',
	};
	const reserve = {
		requestId: 'request-one', reservedMicros: 100_000,
		intents: [{ workspaceId: 'workspace-one',
			assignmentId: 'gateway-key-limit:key-one', guardrailId: 'gateway-key-limit:key-one',
			guardrailVersion: 1, scopeType: 'api_key' as const, scopeId: 'key-one',
			period: 'daily' as const, periodStart: '2026-09-25T00:00:00.000Z',
			periodEnd: '2026-09-26T00:00:00.000Z', limitMicros: 1_000_000 }],
		nowIso: '2026-09-25T01:00:00.000Z',
		expiresAtIso: '2026-09-25T01:02:00.000Z',
	};
	return { base, lifecycle, factory, params, reserve };
}

test('recovery acknowledgement is required before reserve and no raw DML runs', async () => {
	const fixture = setup({ recoveryFailure: true });
	const owner = await openPostgresGuardrailBudgetLifecycleOwnerV353(fixture.params, fixture.factory);
	await assert.rejects(owner.reserveAfterRecovery(fixture.reserve), /recovery failed/u);
	assert.equal(fixture.base.queries.some(query => query.includes('reserve_guardrail_budgets_v351')), false);
	assert.equal([...fixture.base.queries, ...fixture.lifecycle.queries].some(
		query => /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(query)), false);
	await owner.close();
});

test('unknown forfeit COMMIT is surfaced once and owner never replays it', async () => {
	const fixture = setup({ commitLostOn: 2 });
	const owner = await openPostgresGuardrailBudgetLifecycleOwnerV353(fixture.params, fixture.factory);
	await assert.rejects(owner.forfeitDispatched('usage_unknown'), /COMMIT acknowledgement lost/u);
	assert.equal(fixture.lifecycle.queries.filter(query =>
		query.includes('forfeit_guardrail_budgets_v353')).length, 1);
	await owner.close();
	assert.equal(fixture.base.closes, 1);
	assert.equal(fixture.lifecycle.closes, 1);
});

test('lifecycle role mismatch closes both direct-login clients', async () => {
	const fixture = setup({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(openPostgresGuardrailBudgetLifecycleOwnerV353(
		fixture.params, fixture.factory), /LOGIN role mismatch/u);
	assert.equal(fixture.base.closes, 1);
	assert.equal(fixture.lifecycle.closes, 1);
});

test('preflight failure surfaces unconfirmed cleanup after attempting both clients', async () => {
	const fixture = setup(
		{ role: 'cinatoken_gateway_runtime', failClose: true },
		{ failClose: true },
	);
	await assert.rejects(openPostgresGuardrailBudgetLifecycleOwnerV353(
		fixture.params, fixture.factory),
		PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError);
	assert.equal(fixture.base.closes, 1);
	assert.equal(fixture.lifecycle.closes, 1);
});

test('close requires a thenable acknowledgement and still closes the base client', async () => {
	for (const lifecycleOptions of [
		{ closeWithoutPromise: true },
		{ throwOnClose: true },
	]) {
		const fixture = setup(lifecycleOptions);
		const owner = await openPostgresGuardrailBudgetLifecycleOwnerV353(
			fixture.params, fixture.factory);
		await assert.rejects(owner.close(),
			PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError);
		assert.equal(fixture.base.closes, 1);
		assert.equal(fixture.lifecycle.closes, 1);
		await assert.rejects(owner.close(),
			PostgresGuardrailBudgetLifecycleCleanupUnconfirmedError);
		assert.equal(fixture.base.closes, 1);
		assert.equal(fixture.lifecycle.closes, 1);
	}
});
