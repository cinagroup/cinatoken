import assert from 'node:assert/strict';
import test from 'node:test';
import type { GatewayDatabaseClient } from './database-client';
import { listAccessibleWorkspacesForSubject } from './workspaces';

test('PostgreSQL workspace listing casts the optional workspace id parameter', async () => {
	const unsafeCalls: Array<{ sql: string; params: unknown[] }> = [];
	const transaction = async (
		_strings: TemplateStringsArray,
		..._values: unknown[]
	): Promise<unknown[]> => [];
	const raw = Object.assign(transaction, {
		begin: async <T>(
			callback: (sql: typeof transaction) => Promise<T>,
		): Promise<T> => callback(transaction),
		unsafe: async <T>(sql: string, params: unknown[]): Promise<T> => {
			unsafeCalls.push({ sql, params });
			return [] as T;
		},
	});
	const client = {
		driver: 'postgres',
		raw,
		drizzle: {},
	} as unknown as GatewayDatabaseClient;

	await listAccessibleWorkspacesForSubject(client, {
		userId: 'user-1',
		subject: 'cinaauth-subject-1',
	});

	assert.equal(unsafeCalls.length, 1);
	assert.match(
		unsafeCalls[0]!.sql,
		/\(\$3::text IS NULL OR w\.id = \$3::text\)/,
	);
	assert.deepEqual(unsafeCalls[0]!.params, [
		'cinaauth-subject-1',
		'user-1',
		null,
	]);
});
