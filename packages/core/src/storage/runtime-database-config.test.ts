import assert from 'node:assert/strict';
import test from 'node:test';
import type { D1Database } from '@cloudflare/workers-types';
import {
	isGatewayMaintenanceMode,
	resolveWorkerDatabaseConfig,
	type HyperdriveBinding,
} from './runtime-database-config';

const db = {} as D1Database;
const hyperdrive = {
	connectionString: 'postgres://gateway@example.internal/cinaauth',
} as HyperdriveBinding;

test('maintenance mode requires an explicit true value', () => {
	assert.equal(isGatewayMaintenanceMode('true'), true);
	assert.equal(isGatewayMaintenanceMode(' TRUE '), true);
	assert.equal(isGatewayMaintenanceMode(undefined), false);
	assert.equal(isGatewayMaintenanceMode('false'), false);
	assert.equal(isGatewayMaintenanceMode('1'), false);
});

test('Workers remain on D1 when both bindings exist and no driver is selected', () => {
	assert.deepEqual(resolveWorkerDatabaseConfig({ DB: db, HYPERDRIVE: hyperdrive }), {
		driver: 'd1',
		db,
	});
});

test('Workers use only the Hyperdrive connection string for explicit Postgres mode', () => {
	assert.deepEqual(
		resolveWorkerDatabaseConfig({
			DB: db,
			HYPERDRIVE: hyperdrive,
			DATABASE_DRIVER: 'postgres',
		}),
		{
			driver: 'postgres',
			connectionString: hyperdrive.connectionString,
		},
	);
});

test('Workers fail closed when Postgres is selected without Hyperdrive', () => {
	assert.throws(
		() => resolveWorkerDatabaseConfig({ DB: db, DATABASE_DRIVER: 'postgres' }),
		/require Hyperdrive binding "HYPERDRIVE"/,
	);
});

test('Workers reject implicit Postgres and unsupported MySQL paths', () => {
	assert.throws(() => resolveWorkerDatabaseConfig({ HYPERDRIVE: hyperdrive }), /require D1 binding "DB"/);
	assert.throws(
		() => resolveWorkerDatabaseConfig({ HYPERDRIVE: hyperdrive, DATABASE_DRIVER: 'mysql' }),
		/do not support MySQL/,
	);
});
