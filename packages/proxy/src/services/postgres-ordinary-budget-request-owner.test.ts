import assert from 'node:assert/strict';
import test from 'node:test';
import type {
	GatewayRepositories,
	GuardrailBudgetIntent,
	PostgresDatabaseClient,
} from '@octafuse/core';
import type { RouteResult } from './model-router';
import {
	openPostgresOrdinaryBudgetRequestOwner,
	PostgresOrdinaryBudgetRequestCleanupUnconfirmedError,
} from './postgres-ordinary-budget-request-owner';

const runtimeUrl = 'postgres://runtime:secret@db.example/gateway';
const admissionUrl = 'postgres://admission:secret@db.example/gateway';
const recoveryUrl = 'postgres://recovery:secret@db.example/gateway';
const now = new Date('2026-09-25T08:00:00.000Z');
const identity = Object.freeze({
	requestId: 'request-1', userId: 'user-1', apiKeyId: 'key-1', expectedBudgetEpoch: 7,
});
const guardrailIntent: GuardrailBudgetIntent = {
	workspaceId: 'workspace-1',
	assignmentId: 'assignment-1',
	guardrailId: 'guardrail-1',
	guardrailVersion: 1,
	scopeType: 'user',
	scopeId: identity.userId,
	period: 'daily',
	periodStart: '2026-09-25T00:00:00.000Z',
	periodEnd: '2026-09-26T00:00:00.000Z',
	limitMicros: 1_000_000,
};

function runtimeClient(role = 'cinatoken_gateway_runtime'): PostgresDatabaseClient {
	return { driver: 'postgres', raw: {
		unsafe: async () => [{ current_role: role, session_role: role }],
	} } as unknown as PostgresDatabaseClient;
}

function fakeSql(role: string, options: {
	failCommitOn?: number;
	failClose?: boolean;
	commitGateOn?: number;
	commitGate?: Promise<void>;
} = {}) {
	const queries: string[] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		begin: async <T>(callback: (tx: {
			unsafe: (query: string, params?: readonly unknown[]) => Promise<unknown[]>;
		}) => Promise<T>): Promise<T> => {
			begins += 1;
			const current = begins;
			const result = await callback({ unsafe: async query => {
				queries.push(query);
				if (query.startsWith('SELECT current_user')) {
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('reserve_user_budget_v350')) {
					return [{ value: { status: 'reserved', limitMicros: 1_000_000 } }];
				}
				if (query.includes('mark_user_budget_dispatched_v350')) return [{ value: true }];
				if (query.includes('release_user_budget_v350')) return [{ value: 1 }];
				if (query.includes('expire_user_budget_leases_v354')) return [{ value: 0 }];
				if (query.includes('forfeit_user_budget_dispatched_v354')) return [{ value: 1 }];
				throw new Error('Unexpected SQL');
			} });
			if (current === options.commitGateOn) await options.commitGate;
			if (current === options.failCommitOn) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => {
			closes += 1;
			return options.failClose
				? Promise.reject(new Error('close acknowledgement lost'))
				: Promise.resolve();
		},
	};
	return { sql: sql as unknown as PostgresDatabaseClient['raw'], queries,
		get begins() { return begins; }, get closes() { return closes; } };
}

function runtimeRepositories(calls: string[]): GatewayRepositories {
	return {
		userBudgets: {
			reserve: async () => { calls.push('runtime:reserve'); throw new Error('runtime ordinary DML reached'); },
			expireBefore: async () => { calls.push('runtime:expire'); throw new Error('runtime ordinary DML reached'); },
			markDispatched: async () => { calls.push('runtime:mark'); throw new Error('runtime ordinary DML reached'); },
			release: async () => { calls.push('runtime:release'); throw new Error('runtime ordinary DML reached'); },
			forfeitDispatched: async () => { calls.push('runtime:forfeit'); throw new Error('runtime ordinary DML reached'); },
		},
		guardrailBudgets: {
			reserveMany: async () => { calls.push('guardrail:reserve'); throw new Error('unexpected guardrail write'); },
			expireBefore: async () => 0,
			markDispatched: async () => { calls.push('guardrail:mark'); throw new Error('unexpected guardrail write'); },
			releaseMany: async () => 1,
			forfeitMany: async () => 1,
			extendDispatched: async () => { throw new Error('unexpected guardrail extension'); },
		},
	} as unknown as GatewayRepositories;
}

function requestParams() {
	return {
		ordinary: {
			...identity, budgetMax: 1, estimatedChargedCost: 0.25, now,
		},
		guardrail: { intents: [], reservedMicros: 0, now },
		privateByokGatewayKey: { includeInLimit: false, reservedMicros: 0 },
	};
}

async function open(
	admission: ReturnType<typeof fakeSql>,
	recovery: ReturnType<typeof fakeSql>,
) {
	return openPostgresOrdinaryBudgetRequestOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl, recoveryConnectionString: recoveryUrl,
		identity,
	}, { admission: () => admission.sql, recovery: () => recovery.sql });
}

test('request-fixed composition uses independent LOGINs for expiry, reserve, dispatch and forfeit', async () => {
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission');
	const recoverySql = fakeSql('cinatoken_gateway_budget_recovery');
	const owner = await open(admissionSql, recoverySql);
	const calls: string[] = [];
	const admission = await owner.createAdmission(runtimeRepositories(calls), requestParams());
	await admission.beforeUpstreamDispatch({ providerKeyId: 'provider-1' } as RouteResult);
	assert.equal(admission.ordinaryLease.state, 'dispatched');
	await admission.ordinaryLease.forfeitPostDispatchUnknown('usage_unknown');
	assert.equal(admission.ordinaryLease.state, 'forfeited');
	assert.deepEqual(calls, []);
	assert.equal(recoverySql.queries.filter(query =>
		query.includes('expire_user_budget_leases_v354')).length, 1);
	assert.equal(recoverySql.queries.filter(query =>
		query.includes('forfeit_user_budget_dispatched_v354')).length, 1);
	assert.equal(admissionSql.queries.filter(query =>
		query.includes('reserve_user_budget_v350')).length, 1);
	assert.equal(admissionSql.queries.filter(query =>
		query.includes('mark_user_budget_dispatched_v350')).length, 1);
	await owner.close();
	assert.equal(admissionSql.closes, 1);
	assert.equal(recoverySql.closes, 1);
	await assert.rejects(owner.createAdmission(runtimeRepositories([]), requestParams()),
		/owner is closed/u);
});

test('recovery COMMIT uncertainty fails closed before reserve or upstream dispatch without replay', async () => {
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission');
	const recoverySql = fakeSql('cinatoken_gateway_budget_recovery', { failCommitOn: 2 });
	const owner = await open(admissionSql, recoverySql);
	const calls: string[] = [];
	const admission = await owner.createAdmission(runtimeRepositories(calls), {
		...requestParams(),
		guardrail: { intents: [guardrailIntent], reservedMicros: 250_000, now },
	});
	let upstreamFetches = 0;
	const dispatch = async (): Promise<void> => {
		await admission.beforeUpstreamDispatch({ providerKeyId: 'provider-1' } as RouteResult);
		upstreamFetches += 1;
	};
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await assert.rejects(dispatch(), {
			name: 'OrdinaryBudgetLifecycleError', code: 'recovery_persistence_failed',
			cause: new Error('COMMIT acknowledgement lost'),
		});
	}
	assert.equal(upstreamFetches, 0);
	assert.deepEqual(calls, []);
	assert.equal(recoverySql.queries.filter(query =>
		query.includes('expire_user_budget_leases_v354')).length, 1);
	assert.equal(admissionSql.queries.filter(query =>
		query.includes('reserve_user_budget_v350')).length, 0);
	assert.equal(admission.ordinaryLease.state, 'unmetered');
	await owner.close();
});

test('request identity mismatch and shared connection reject before an admission write', async () => {
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission');
	const recoverySql = fakeSql('cinatoken_gateway_budget_recovery');
	const owner = await open(admissionSql, recoverySql);
	await assert.rejects(owner.createAdmission(runtimeRepositories([]), {
		...requestParams(), ordinary: { ...requestParams().ordinary, userId: 'another-user' },
	}), /identity mismatch/u);
	assert.throws(() => owner.ordinaryBudgetRepositories.userBudgets.reserve({
		requestId: identity.requestId, userId: identity.userId, apiKeyId: identity.apiKeyId,
		expectedBudgetEpoch: identity.expectedBudgetEpoch + 1,
		reservedMicros: 1, nowIso: now.toISOString(), expiresAtIso: now.toISOString(),
	}), /identity mismatch/u);
	assert.equal(admissionSql.queries.some(query => query.includes('reserve_user_budget_v350')), false);
	await owner.close();

	let created = 0;
	await assert.rejects(openPostgresOrdinaryBudgetRequestOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl, recoveryConnectionString: admissionUrl,
		identity,
	}, { admission: () => { created += 1; return admissionSql.sql; } }),
	/Connections must be distinct|connections must be distinct/u);
	assert.equal(created, 0);
});

test('partial open failure confirms admission cleanup and rejects a shared physical client', async () => {
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission');
	await assert.rejects(openPostgresOrdinaryBudgetRequestOwner({
		runtimeClient: runtimeClient(), runtimeConnectionString: runtimeUrl,
		admissionConnectionString: admissionUrl, recoveryConnectionString: recoveryUrl,
		identity,
	}, { admission: () => admissionSql.sql, recovery: () => admissionSql.sql }),
		/recovery client open failed/u);
	assert.equal(admissionSql.closes, 1);
	const admissionSql2 = fakeSql('cinatoken_gateway_budget_admission');
	const wrongRecovery = fakeSql('cinatoken_gateway_runtime');
	await assert.rejects(open(admissionSql2, wrongRecovery), /LOGIN role mismatch/u);
	assert.equal(admissionSql2.closes, 1);
	assert.equal(wrongRecovery.closes, 1);
});

test('close attempts both LOGIN clients and exposes unconfirmed cleanup', async () => {
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission', { failClose: true });
	const recoverySql = fakeSql('cinatoken_gateway_budget_recovery');
	const owner = await open(admissionSql, recoverySql);
	await assert.rejects(owner.close(), PostgresOrdinaryBudgetRequestCleanupUnconfirmedError);
	assert.equal(admissionSql.closes, 1);
	assert.equal(recoverySql.closes, 1);
	await assert.rejects(owner.close(), PostgresOrdinaryBudgetRequestCleanupUnconfirmedError);
	assert.equal(admissionSql.closes, 1);
	assert.equal(recoverySql.closes, 1);
});

test('close waits for an in-flight admission COMMIT', async () => {
	let releaseCommit!: () => void;
	const commitGate = new Promise<void>(resolve => { releaseCommit = resolve; });
	const admissionSql = fakeSql('cinatoken_gateway_budget_admission', {
		commitGateOn: 2, commitGate,
	});
	const recoverySql = fakeSql('cinatoken_gateway_budget_recovery');
	const owner = await open(admissionSql, recoverySql);
	const reservation = owner.ordinaryBudgetRepositories.userBudgets.reserve({
		...identity, reservedMicros: 250_000,
		nowIso: now.toISOString(), expiresAtIso: new Date(now.getTime() + 120_000).toISOString(),
	});
	const close = owner.close();
	assert.equal(admissionSql.closes, 0);
	releaseCommit();
	await reservation;
	await close;
	assert.equal(admissionSql.closes, 1);
	assert.equal(recoverySql.closes, 1);
});
