import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { openPostgresOrdinaryBudgetRecoveryOwner,
	PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError,
} from './postgres-ordinary-budget-recovery';

const runtimeUrl = 'postgres://runtime:secret@db.example/gateway';
const recoveryUrl = 'postgres://recovery:secret@db.example/gateway';

function runtimeClient(role = 'cinatoken_gateway_runtime'): PostgresDatabaseClient {
	return { driver: 'postgres', raw: {
		unsafe: async () => [{ current_role: role, session_role: role }],
	} } as unknown as PostgresDatabaseClient;
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>(yes => { resolve = yes; });
	return { promise, resolve };
}

function fakeSql(options: {
	role?: string;
	failCommitOn?: number;
	commitGateOn?: number;
	commitGate?: ReturnType<typeof deferred>;
	failClose?: boolean;
} = {}) {
	const queries: string[] = [];
	let begins = 0;
	let closes = 0;
	const sql = {
		begin: async <T>(callback: (tx: {
			unsafe: (query: string) => Promise<unknown[]>;
		}) => Promise<T>) => {
			begins += 1;
			const current = begins;
			const result = await callback({ unsafe: async query => {
				queries.push(query);
				if (query.startsWith('SELECT current_user')) {
					const role = options.role ?? 'cinatoken_gateway_budget_recovery';
					return [{ current_role: role, session_role: role }];
				}
				if (query.includes('forfeit_user_budget_dispatched_v354')) return [{ value: 1 }];
				if (query.includes('expire_user_budget_leases_v354')) return [{ value: 2 }];
				throw new Error('Unexpected SQL');
			} });
			if (current === options.commitGateOn) await options.commitGate?.promise;
			if (current === options.failCommitOn) throw new Error('COMMIT acknowledgement lost');
			return result;
		},
		end: () => {
			closes += 1;
			return options.failClose
				? Promise.reject(new Error('close acknowledgement lost')) : Promise.resolve();
		},
	};
	return { sql: sql as unknown as PostgresDatabaseClient['raw'], queries,
		get begins() { return begins; }, get closes() { return closes; } };
}

function open(fake: ReturnType<typeof fakeSql>) {
	return openPostgresOrdinaryBudgetRecoveryOwner({
		runtimeClient: runtimeClient(),
		runtimeConnectionString: runtimeUrl,
		recoveryConnectionString: recoveryUrl,
	}, () => fake.sql);
}

test('lost forfeiture COMMIT acknowledgement rejects without an automatic replay', async () => {
	const fake = fakeSql({ failCommitOn: 2 });
	const owner = await open(fake);
	await assert.rejects(owner.recovery.forfeitDispatched('request-one',
		'2026-09-25T08:00:00.000Z', 'usage_unknown'), /COMMIT acknowledgement lost/u);
	assert.equal(fake.queries.filter(query =>
		query.includes('forfeit_user_budget_dispatched_v354')).length, 1);
	assert.equal(fake.queries.some(query => /\b(?:INSERT|UPDATE|DELETE)\b/iu.test(query)), false);
	await owner.close();
	assert.equal(fake.closes, 1);
});

test('bounded scanner and close wait for in-flight COMMIT', async () => {
	const gate = deferred();
	const fake = fakeSql({ commitGateOn: 2, commitGate: gate });
	const owner = await open(fake);
	const scan = owner.recovery.expireBefore('2026-09-25T08:00:00.000Z', 2);
	const close = owner.close();
	assert.equal(fake.closes, 0);
	gate.resolve();
	assert.equal(await scan, 2);
	await close;
	assert.equal(fake.closes, 1);
	assert.throws(() => owner.recovery.expireBefore(
		'2026-09-25T08:00:00.000Z', 2), /owner is closed/u);
});

test('wrong LOGIN closes candidate and invalid limit never reaches SQL', async () => {
	const wrong = fakeSql({ role: 'cinatoken_gateway_runtime' });
	await assert.rejects(open(wrong), /LOGIN role mismatch/u);
	assert.equal(wrong.closes, 1);
	const fake = fakeSql();
	const owner = await open(fake);
	assert.throws(() => owner.recovery.expireBefore(
		'2026-09-25T08:00:00.000Z', 101), /limit must be 1-100/u);
	assert.equal(fake.queries.some(query =>
		query.includes('expire_user_budget_leases_v354')), false);
	await owner.close();
});

test('unconfirmed close is explicit', async () => {
	const fake = fakeSql({ failClose: true });
	const owner = await open(fake);
	await assert.rejects(owner.close(),
		PostgresOrdinaryBudgetRecoveryCleanupUnconfirmedError);
	assert.equal(fake.closes, 1);
});
