import assert from 'node:assert/strict';
import test from 'node:test';
import {
	GATEWAY_POSTGRES_SEARCH_PATH,
	initializeGatewayPostgresSession,
	isTransientPostgresConnectionError,
	resolvePostgresFactory,
} from './client-postgres';

test('initializes the gateway search_path with an explicit session statement', async () => {
	const statements: string[] = [];
	await initializeGatewayPostgresSession({
		async unsafe(query: string): Promise<void> {
			statements.push(query);
		},
	});
	assert.deepEqual(statements, [`SET search_path TO ${GATEWAY_POSTGRES_SEARCH_PATH}`]);
});

test('normalizes direct and nested postgres default exports', () => {
	const factory = (() => undefined) as unknown as Parameters<typeof resolvePostgresFactory>[0];
	assert.equal(resolvePostgresFactory(factory), factory);
	assert.equal(resolvePostgresFactory({ default: factory }), factory);
	assert.equal(resolvePostgresFactory({ default: { default: factory } }), factory);
	assert.throws(() => resolvePostgresFactory({ default: {} }), /callable factory/);
});

test('recognizes only bounded Postgres connection lifecycle failures as transient', () => {
	assert.equal(isTransientPostgresConnectionError({ code: 'CONNECTION_CLOSED' }), true);
	assert.equal(isTransientPostgresConnectionError(new Error('write CONNECTION_DESTROYED hyperdrive.local:5432')), true);
	assert.equal(isTransientPostgresConnectionError({ cause: { code: 'CONNECTION_ENDED' } }), true);
	assert.equal(isTransientPostgresConnectionError(new Error('syntax error at or near "window"')), false);
	assert.equal(isTransientPostgresConnectionError({ code: '23505' }), false);
});
