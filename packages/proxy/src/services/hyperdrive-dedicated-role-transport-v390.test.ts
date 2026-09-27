import assert from 'node:assert/strict';
import test from 'node:test';
import type { PostgresDatabaseClient } from '@octafuse/core';
import { createHyperdriveDedicatedRoleTransportV390 } from './hyperdrive-dedicated-role-transport-v390';
import { createPostgresCompleteTextNoFetchRecoveryV389 } from './postgres-complete-text-no-fetch-recovery-v389';

const role = 'cinatoken_gateway_complete_text_recovery_worker';
const original = 'postgres://generated-transport-user:ephemeral%40password@binding.invalid:5432/db?sslmode=disable';

test('Hyperdrive factory opens exact binding credentials while the role alias stays in memory', () => {
	const opens: unknown[] = [];
	const sql = { end: async () => {} } as unknown as PostgresDatabaseClient['raw'];
	const binding = { connectionString: original };
	const transport = createHyperdriveDedicatedRoleTransportV390(binding, role, (url, options) => {
		opens.push({ url, options }); return sql;
	});
	assert.equal(new URL(transport.roleConnectionString).username, role);
	assert.equal(opens.length, 0);
	binding.connectionString = 'postgres://swapped:secret@elsewhere/db';
	assert.equal(transport.createSql(transport.roleConnectionString, { max: 1 }), sql);
	assert.deepEqual(opens, [{ url: original, options: { max: 1, prepare: false, fetch_types: false,
		connect_timeout: 3, idle_timeout: 0, max_lifetime: 0, backoff: false } }]);
	assert.throws(() => transport.createSql(original, { max: 1 }), /transport key differs/u);
	assert.throws(() => transport.createSql(transport.roleConnectionString, { max: 2 } as never), /transport key differs/u);
	assert.equal(opens.length, 1);
});

test('unapproved origin roles and malformed binding URLs fail before opening a socket', () => {
	for (const url of ['https://u:p@db/name', 'postgres://u@db/name', 'postgres://u:p@db/',
		'postgres://u:p@db/name?options=role', 'postgres://u:p@db/name#secret']) {
		assert.throws(() => createHyperdriveDedicatedRoleTransportV390({ connectionString: url }, role), /invalid/u);
	}
	assert.throws(() => createHyperdriveDedicatedRoleTransportV390({ connectionString: original },
		'cinatoken_gateway_migrator'), /invalid/u);
});

test('binding alias cannot bypass the direct client actual origin LOGIN verification', async () => {
	for (const actualRole of [role, 'cinatoken_gateway_runtime']) {
		let statements = 0, committed = false, closed = false;
		const transport = createHyperdriveDedicatedRoleTransportV390({ connectionString: original }, role, url => {
			assert.equal(url, original);
			return {
				async begin(run: (tx: { unsafe(query: string): Promise<unknown> }) => Promise<unknown>) {
					const result = await run({ async unsafe(query) {
						if (query.startsWith('SELECT current_user')) return [{ current_role: actualRole,
							session_role: actualRole, transaction_isolation: 'read committed' }];
						if (query.startsWith('SET LOCAL')) return [];
						statements++; return [{ value: { status: 'scanned', enqueued: 0 } }];
					} });
					committed = true; return result;
				},
				async end() { closed = true; },
			} as unknown as PostgresDatabaseClient['raw'];
		});
		const urls = { workerConnectionString: transport.roleConnectionString,
			observerConnectionString: 'postgres://cinatoken_gateway_complete_text_recovery_observer:p@db/name',
			resolverConnectionString: 'postgres://cinatoken_gateway_complete_text_no_fetch_resolver:p@db/name',
			closerConnectionString: 'postgres://cinatoken_gateway_complete_text_platform_closer:p@db/name' };
		const client = createPostgresCompleteTextNoFetchRecoveryV389(urls, transport.createSql);
		if (actualRole === role) assert.equal((await client.scan(1)).enqueued, 0);
		else await assert.rejects(client.scan(1), /LOGIN mismatch/u);
		assert.equal(statements, actualRole === role ? 1 : 0);
		assert.equal(committed, actualRole === role); assert.equal(closed, true);
	}
});
