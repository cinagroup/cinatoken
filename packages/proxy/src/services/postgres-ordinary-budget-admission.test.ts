import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayRepositories, PostgresDatabaseClient } from '@octafuse/core';
import type { RouteResult } from './model-router';
import { createRouteAwareBudgetAdmission, RequestBudgetAdmissionError } from './request-budget-admission';
import {
	openPostgresOrdinaryBudgetAdmissionOwner,
	PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError,
	PostgresOrdinaryBudgetAdmissionUnsupportedTransitionError,
} from './postgres-ordinary-budget-admission';

const runtimeUrl = 'postgres://runtime:secret@db.example/gateway';
const admissionUrl = 'postgres://admission:secret@db.example/gateway';
const now = new Date('2026-09-25T08:00:00.000Z');

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function runtimeClient(role = 'cinatoken_gateway_runtime'): PostgresDatabaseClient {
	return { driver: 'postgres', raw: {
		unsafe: async () => [{ current_role: role, session_role: role }],
	} } as unknown as PostgresDatabaseClient;
}

function fakeAdmissionSql(options: {
	role?: string;
	reserveValue?: unknown;
	releaseValue?: unknown;
	commitFailureOn?: number;
	commitGateOn?: number;
	commitGate?: ReturnType<typeof deferred<void>>;
	close?: () => unknown;
} = {}) {
	const queries: string[] = [];
	const parameters: unknown[][] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		begin: async <T>(callback: (tx: { unsafe: (query: string, params?: readonly unknown[]) => Promise<unknown[]> }) => Promise<T>) => {
			begins += 1;
			const current = begins;
			const result = await callback({
				unsafe: async (query, params = []) => {
					queries.push(query);
					parameters.push([...params]);
					if (query.startsWith('SELECT current_user')) {
						const role = options.role ?? 'cinatoken_gateway_budget_admission';
						return [{ current_role: role, session_role: role }];
					}
					if (query.includes('reserve_user_budget_v350')) {
						return [{ value: options.reserveValue ?? { status: 'reserved', limitMicros: 1_000_000 } }];
					}
					if (query.includes('mark_user_budget_dispatched_v350')) return [{ value: true }];
					if (query.includes('release_user_budget_v350')) return [{ value: options.releaseValue ?? 1 }];
					throw new Error('Unexpected SQL');
				},
			});
			if (options.commitGateOn === current) await options.commitGate?.promise;
			if (options.commitFailureOn === current) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => {
			closes += 1;
			return options.close?.() ?? Promise.resolve();
		},
	};
	return {
		sql: sql as unknown as PostgresDatabaseClient['raw'],
		queries, parameters,
		get begins() { return begins; },
		get closes() { return closes; },
	};
}

function requestParams() {
	return {
		ordinary: {
			requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1',
			budgetMax: 1, expectedBudgetEpoch: 7, estimatedChargedCost: 0.25, now,
		},
		guardrail: { intents: [], reservedMicros: 0, now },
		privateByokGatewayKey: { includeInLimit: false, reservedMicros: 0 },
	};
}

function fakeRuntimeRepositories(calls: string[]): GatewayRepositories {
	return {
		userBudgets: {
			reserve: async () => { calls.push('runtime:reserve'); throw new Error('ordinary runtime DML reached'); },
			expireBefore: async () => { calls.push('runtime:expire'); throw new Error('ordinary runtime DML reached'); },
			markDispatched: async () => { calls.push('runtime:mark'); throw new Error('ordinary runtime DML reached'); },
			release: async () => { calls.push('runtime:release'); throw new Error('ordinary runtime DML reached'); },
			forfeitDispatched: async () => { calls.push('runtime:forfeit'); throw new Error('ordinary runtime DML reached'); },
		},
		guardrailBudgets: {
			reserveMany: async () => { calls.push('guardrail:reserve'); return { status: 'reserved', reservationCount: 0 }; },
			markDispatched: async () => { calls.push('guardrail:mark'); return true; },
			releaseMany: async () => 1,
			forfeitMany: async () => 1,
			extendDispatched: async () => { throw new Error('unexpected guardrail extension'); },
			expireBefore: async () => 0,
		},
	} as unknown as GatewayRepositories;
}

test('explicit ordinary admission owner uses a distinct LOGIN and v350 functions through acknowledged transactions', async () => {
	const runtime = runtimeClient();
	const fake = fakeAdmissionSql();
	const created: Array<{ url: string; max: number }> = [];
	const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtime, runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
	}, (url, options) => {
		created.push({ url, max: options.max });
		return fake.sql;
	});
	assert.deepEqual(created, [{ url: admissionUrl, max: 1 }]);
	const calls: string[] = [];
	const admission = await createRouteAwareBudgetAdmission(fakeRuntimeRepositories(calls), requestParams(), {
		ordinaryBudgetRepositories: owner.ordinaryBudgetRepositories,
	});
	await admission.beforeUpstreamDispatch({ providerKeyId: 'provider-1' } as RouteResult);
	assert.equal(admission.ordinaryLease.state, 'dispatched');
	assert.deepEqual(calls, []);
	assert.equal(fake.queries.filter(query => query.includes('reserve_user_budget_v350')).length, 1);
	assert.equal(fake.queries.filter(query => query.includes('mark_user_budget_dispatched_v350')).length, 1);
	assert.equal(fake.queries.filter(query => query.startsWith('SELECT current_user')).length, 3);
	assert.deepEqual(fake.parameters.find((_, i) => fake.queries[i].includes('reserve_user_budget_v350')),
		['request-1', 'user-1', 'key-1', 7, 250_000, now.toISOString(),
			new Date(now.getTime() + 120_000).toISOString()]);
	await assert.rejects(admission.ordinaryLease.forfeitPostDispatchUnknown('unknown'), {
		name: 'OrdinaryBudgetLifecycleError', code: 'forfeit_persistence_failed',
		cause: new PostgresOrdinaryBudgetAdmissionUnsupportedTransitionError(),
	});
	assert.equal(admission.ordinaryLease.state, 'dispatched');
	await owner.close();
	assert.equal(fake.closes, 1);
	assert.throws(() => owner.ordinaryBudgetRepositories.userBudgets.reserve({
		requestId: 'later', userId: 'user-1', apiKeyId: 'key-1', expectedBudgetEpoch: 7,
		reservedMicros: 1, nowIso: now.toISOString(), expiresAtIso: new Date(now.getTime() + 1_000).toISOString(),
	}), /owner is closed/);
});

test('blocked budget and unknown reserve COMMIT both stop before Guardrail and upstream dispatch', async () => {
	for (const [label, fake] of [
		['blocked', fakeAdmissionSql({ reserveValue: { status: 'blocked', remainingMicros: 0 } })],
		['commit-unknown', fakeAdmissionSql({ commitFailureOn: 2 })],
	] as const) {
		const calls: string[] = [];
		const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
			runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
			admissionConnectionString: admissionUrl,
		}, () => fake.sql);
		const admission = await createRouteAwareBudgetAdmission(fakeRuntimeRepositories(calls), requestParams(), {
			ordinaryBudgetRepositories: owner.ordinaryBudgetRepositories,
		});
		await assert.rejects(admission.beforeUpstreamDispatch({ providerKeyId: 'provider-1' } as RouteResult),
			label === 'blocked' ? RequestBudgetAdmissionError : {
				name: 'OrdinaryBudgetLifecycleError', code: 'reserve_persistence_failed',
				cause: new Error('COMMIT acknowledgement lost'),
			});
		assert.deepEqual(calls, [], label);
		assert.equal(fake.queries.filter(query => query.includes('reserve_user_budget_v350')).length, 1, label);
		assert.equal(fake.queries.filter(query => query.includes('mark_user_budget_dispatched_v350')).length, 0, label);
		await owner.close();
	}
});

test('definite no-claim release uses the admission LOGIN and does not mark dispatch', async () => {
	const fake = fakeAdmissionSql();
	const calls: string[] = [];
	const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
	}, () => fake.sql);
	const admission = await createRouteAwareBudgetAdmission(fakeRuntimeRepositories(calls), requestParams(), {
		ordinaryBudgetRepositories: owner.ordinaryBudgetRepositories,
	});
	const ticket = await admission.prepareSingleGrant({ providerKeyId: 'provider-1' } as RouteResult);
	await ticket.releaseAfterDefiniteNoClaim();
	assert.equal(admission.ordinaryLease.state, 'unmetered');
	assert.deepEqual(calls, []);
	assert.equal(fake.queries.filter(query => query.includes('release_user_budget_v350')).length, 1);
	assert.equal(fake.queries.filter(query => query.includes('mark_user_budget_dispatched_v350')).length, 0);
	assert.equal(fake.queries.filter(query => query.startsWith('SELECT current_user')).length, 3);
	await owner.close();
});

test('unknown dispatch-mark COMMIT prevents dispatch and retains the conservative ceiling', async () => {
	const fake = fakeAdmissionSql({ commitFailureOn: 3, releaseValue: 0 });
	const calls: string[] = [];
	const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
	}, () => fake.sql);
	const admission = await createRouteAwareBudgetAdmission(fakeRuntimeRepositories(calls), requestParams(), {
		ordinaryBudgetRepositories: owner.ordinaryBudgetRepositories,
	});
	await assert.rejects(admission.beforeUpstreamDispatch({ providerKeyId: 'provider-1' } as RouteResult), {
		name: 'OrdinaryBudgetLifecycleError', code: 'dispatch_persistence_failed',
	});
	assert.equal(admission.ordinaryLease.state, 'reserved');
	assert.deepEqual(calls, []);
	assert.equal(fake.queries.filter(query => query.includes('mark_user_budget_dispatched_v350')).length, 1);
	assert.equal(fake.queries.filter(query => query.includes('release_user_budget_v350')).length, 1);
	await owner.close();
});

test('role mismatch and shared origin fail before function invocation and confirm cleanup', async () => {
	const wrong = fakeAdmissionSql({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
	}, () => wrong.sql), /LOGIN role mismatch/);
	assert.equal(wrong.closes, 1);
	assert.equal(wrong.queries.some(query => query.includes('reserve_user_budget_v350')), false);
	let creations = 0;
	await assert.rejects(openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: runtimeUrl,
	}, () => { creations += 1; return wrong.sql; }), /must be distinct/);
	assert.equal(creations, 0);
	await assert.rejects(openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient('cinatoken_gateway_budget_admission'),
		runtimeConnectionString: runtimeUrl, admissionConnectionString: admissionUrl,
	}, () => { creations += 1; return wrong.sql; }), /runtime LOGIN role mismatch/);
	assert.equal(creations, 0);
});

test('request close waits for in-flight COMMIT and exposes unconfirmed cleanup', async () => {
	const commitGate = deferred<void>();
	const fake = fakeAdmissionSql({ commitGateOn: 2, commitGate,
		close: () => Promise.reject(new Error('cleanup acknowledgement lost')) });
	const owner = await openPostgresOrdinaryBudgetAdmissionOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl,
	}, () => fake.sql);
	const reservation = owner.ordinaryBudgetRepositories.userBudgets.reserve({
		requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1', expectedBudgetEpoch: 7,
		reservedMicros: 250_000, nowIso: now.toISOString(),
		expiresAtIso: new Date(now.getTime() + 120_000).toISOString(),
	});
	const close = owner.close();
	let closed = false;
	void close.finally(() => { closed = true; }).catch(() => undefined);
	await Promise.resolve();
	assert.equal(closed, false);
	assert.equal(fake.closes, 0);
	commitGate.resolve();
	await reservation;
	await assert.rejects(close, PostgresOrdinaryBudgetAdmissionCleanupUnconfirmedError);
	assert.equal(fake.closes, 1);
	assert.equal(closed, true);
});
