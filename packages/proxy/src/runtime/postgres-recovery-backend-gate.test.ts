import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequestCapacityPool } from '../services/request-capacity';
import { createNodeApp } from './node';
import { createWorkerApp } from './workers';

function recoveryOptions() {
	const pool = createRequestCapacityPool({ maxRequests: 1, maxReservedBytes: 1 });
	let opens = 0;
	return {
		options: {
			httpCapacity: { pool, reservedBytesPerRequest: 1 },
			postgresImageRecovery: {
				maxAttempts: 1 as const,
				async open(): Promise<never> {
					opens++;
					throw new Error('Recovery producer must not open during backend validation');
				},
			},
		},
		pool,
		get opens() { return opens; },
	};
}

test('Node rejects an explicitly selected PostgreSQL recovery mode at construction with MySQL', () => {
	const previousDriver = process.env.DATABASE_DRIVER;
	const previousUrl = process.env.DATABASE_URL;
	const fixture = recoveryOptions();
	try {
		process.env.DATABASE_DRIVER = 'mysql';
		process.env.DATABASE_URL = 'mysql://local:local@127.0.0.1/recovery_gate';
		assert.throws(() => createNodeApp(fixture.options),
			/PostgreSQL Images recovery requires a PostgreSQL Node database driver/);
		assert.equal(fixture.opens, 0);
		assert.equal(fixture.pool.snapshot().requests, 0);

		// The driver restriction belongs to this explicit recovery mode.
		assert.doesNotThrow(() => createNodeApp());
		process.env.DATABASE_DRIVER = 'postgres';
		process.env.DATABASE_URL = 'postgres://local:local@127.0.0.1/recovery_gate';
		assert.doesNotThrow(() => createNodeApp(fixture.options));
	} finally {
		if (previousDriver === undefined) delete process.env.DATABASE_DRIVER;
		else process.env.DATABASE_DRIVER = previousDriver;
		if (previousUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = previousUrl;
	}
});

test('Worker rejects D1 binding before storage or a producer opens when PostgreSQL recovery is selected', async () => {
	const fixture = recoveryOptions();
	const bindings = {
		DB: {} as D1Database,
		SHARED_KEY_ENCRYPTION_SECRET: 'synthetic-encryption-secret-for-local-test-only',
	};
	const request = () => new Request('https://api.cinatoken.com/');
	const ordinary = await createWorkerApp().fetch(request(), bindings, {} as ExecutionContext);
	assert.equal(ordinary.status, 200);
	await ordinary.text();

	const response = await createWorkerApp(fixture.options).fetch(request(), bindings, {} as ExecutionContext);
	assert.equal(response.status, 500);
	await response.text();
	assert.equal(fixture.opens, 0);
	assert.equal(fixture.pool.snapshot().requests, 0);
});
