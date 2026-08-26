import assert from 'node:assert/strict';
import test from 'node:test';
import { workerApp } from './workers';

test('maintenance mode rejects traffic before a database binding is resolved', async () => {
	const response = await workerApp.fetch(
		new Request('https://api.cinatoken.com/v1/models'),
		{ CINATOKEN_MAINTENANCE_MODE: 'true' },
		{} as ExecutionContext,
	);
	assert.equal(response.status, 503);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('retry-after'), '60');
	assert.deepEqual(await response.json(), {
		error: {
			message: 'CinaToken is temporarily unavailable for scheduled maintenance.',
			type: 'maintenance_mode',
		},
	});
});
