import assert from 'node:assert/strict';
import test from 'node:test';
import {
	GATEWAY_POSTGRES_SEARCH_PATH,
	initializeGatewayPostgresSession,
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
