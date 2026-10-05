import assert from 'node:assert/strict';
import test from 'node:test';
import type { AdminKeyMutationWithAudit } from '../storage/gateway-repository-interfaces';
import type { MySqlDatabaseClient, PostgresDatabaseClient } from '../storage/database-client';
import { usersTable as myUsersTable } from '../storage/drizzle/schema.mysql';
import { usersTable as pgUsersTable } from '../storage/drizzle/schema.pg';
import { snapshotToJson, userRowToSnapshot } from './user-audit-snapshot';
import { createMySqlApiKeysRepository } from './mysql/api-keys.impl';
import { createPostgresApiKeysRepository } from './postgres/api-keys.impl';

const userSnapshot = userRowToSnapshot({
	id: 'u1', email: 'user@example.test',
	budget_max: 10, budget_base: 10, budget_spent: 3,
	budget_period: 'none', budget_reset_at: null,
	budget_epoch: 0, budget_reserved_micros: 0,
	status: 'active', metadata: null, charged_cost_factors: null,
	external_system: null, external_user_id: null,
	created_at: '', updated_at: '',
});
const mutation: AdminKeyMutationWithAudit = {
	id: 'k1',
	expected: { userId: 'u1', workspaceId: 'w1', name: 'before', status: 'active', metadata: '{}' },
	patch: { name: 'after', status: 'revoked', metadata: '{"team":"ops"}' },
	expectedUserSnapshot: userSnapshot,
	audit: {
		id: 'a1', userId: 'u1', apiKeyId: 'k1', eventType: 'key_revoked',
		actorType: 'admin', actorId: 'admin:test', source: 'admin_keys',
		reasonCode: 'admin_key_revoked',
		beforeUserSnapshot: snapshotToJson(userSnapshot),
		afterUserSnapshot: snapshotToJson(userSnapshot),
		changePayload: '{"status":{"from":"active","to":"revoked"}}',
	},
};

function transactionFixture(userTable: object) {
	let user = {
		id: 'u1', email: 'user@example.test',
		budgetMax: '10.000000', budgetBase: '10.000000', budgetSpent: '3.000000',
		budgetPeriod: 'none', budgetResetAt: null,
		budgetEpoch: 0, budgetReservedMicros: 0,
		status: 'active', metadata: null, chargedCostFactors: null,
		externalSystem: null, externalUserId: null,
	};
	let key = { userId: 'u1', workspaceId: 'w1', name: 'before', status: 'active', metadata: '{}' };
	let auditCount = 0;
	let failAudit = false;
	let skipAudit = false;
	let locks: string[] = [];
	let writes: string[] = [];
	const drizzle = {
		async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
			let stagedKey = { ...key };
			let stagedAudit = 0;
			locks = [];
			writes = [];
			const tx = {
				select: () => ({
					from: (table: object) => {
						const kind = table === userTable ? 'user' : 'key';
						const lock = async (mode: string) => {
							assert.equal(mode, 'update');
							locks.push(kind);
							return kind === 'user' ? [{ ...user }] : [{ ...key }];
						};
						const query = { for: lock, limit: () => ({ for: lock }) };
						return { where: () => query };
					},
				}),
				update: () => ({
					set: (patch: Record<string, unknown>) => ({
						where: () => {
							const pending = Promise.resolve().then(() => {
								writes.push('key');
								stagedKey = { ...stagedKey, ...patch };
								return [{ id: 'k1' }];
							});
							return Object.assign(pending, { returning: () => pending });
						},
					}),
				}),
				insert: () => ({
					values: () => {
						const insert = Promise.resolve().then(() => {
							writes.push('audit');
							if (failAudit) throw new Error('injected audit failure');
							if (!skipAudit) stagedAudit++;
							return [{ affectedRows: skipAudit ? 0 : 1 }];
						});
						return Object.assign(insert, { returning: () => insert.then(() => skipAudit ? [] : [{ id: 'a1' }]) });
					},
				}),
			};
			const result = await fn(tx);
			key = stagedKey;
			auditCount += stagedAudit;
			return result;
		},
	};
	return {
		drizzle,
		setUserSpent: (value: string) => { user = { ...user, budgetSpent: value }; },
		failAudit: (value: boolean) => { failAudit = value; },
		skipAudit: (value: boolean) => { skipAudit = value; },
		setWorkspace: (value: string) => { key = { ...key, workspaceId: value }; },
		key: () => key, auditCount: () => auditCount,
		locks: () => locks, writes: () => writes,
	};
}

for (const driver of ['mysql', 'postgres'] as const) {
	test(`${driver} Key transaction locks user before Key, rejects stale user, and rolls back audit failures`, async () => {
		const state = transactionFixture(driver === 'mysql' ? myUsersTable : pgUsersTable);
		const repo = driver === 'mysql'
			? createMySqlApiKeysRepository({ driver, raw: {}, drizzle: state.drizzle } as unknown as MySqlDatabaseClient)
			: createPostgresApiKeysRepository({ driver, raw: {}, drizzle: state.drizzle } as unknown as PostgresDatabaseClient);
		const mutate = repo.applyAdminKeyMutationWithAudit;
		assert.ok(mutate);

		state.setUserSpent('4.000000');
		assert.equal(await mutate(mutation), 'conflict');
		assert.deepEqual(state.locks(), ['user']);
		assert.deepEqual(state.writes(), []);
		assert.equal(state.auditCount(), 0);

		state.setUserSpent('3.000000');
		state.setWorkspace('moved');
		assert.equal(await mutate(mutation), 'conflict');
		assert.deepEqual(state.writes(), []);
		state.setWorkspace('w1');
		state.failAudit(true);
		await assert.rejects(() => mutate(mutation), /injected audit failure/u);
		assert.deepEqual(state.locks(), ['user', 'key']);
		assert.deepEqual(state.writes(), ['key', 'audit']);
		assert.equal(state.key().name, 'before');
		assert.equal(state.auditCount(), 0);

		state.failAudit(false);
		state.skipAudit(true);
		await assert.rejects(() => mutate(mutation), /audit was not inserted/u);
		assert.equal(state.key().name, 'before'); assert.equal(state.auditCount(), 0);
		state.skipAudit(false);
		assert.equal(await mutate(mutation), 'applied');
		assert.deepEqual(state.locks(), ['user', 'key']);
		assert.equal(state.key().name, 'after');
		assert.equal(state.key().status, 'revoked');
		assert.equal(state.auditCount(), 1);

		assert.equal(await mutate(mutation), 'conflict');
		assert.deepEqual(state.writes(), []);
		assert.equal(state.auditCount(), 1);
	});
}
