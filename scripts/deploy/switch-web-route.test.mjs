import assert from 'node:assert/strict';
import test from 'node:test';
import { productionWebRoute, switchWebRoute } from './switch-web-route.mjs';

const version = '12345678-1234-1234-1234-123456789abc';
function fixture({ owner = 'cinatoken-admin', deployedVersion = version, drift = false } = {}) {
	let routeReads = 0;
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push({ url, method: init.method ?? 'GET', body: init.body });
		if (url.endsWith('/deployments'))
			return Response.json({ success: true, result: { deployments: [{ versions: [{ version_id: deployedVersion, percentage: 100 }] }] } });
		if (init.method === 'PUT') owner = JSON.parse(init.body).script;
		else if (++routeReads === 2 && drift) owner = 'unexpected-owner';
		return Response.json({
			success: true,
			result: { id: productionWebRoute.routeId, pattern: productionWebRoute.pattern, script: owner, request_limit_fail_open: false },
		});
	};
	return { fetchImpl, calls };
}

test('preflight performs no mutation and binds the reviewed Web deployment', async () => {
	const mock = fixture();
	const result = await switchWebRoute({ to: 'web', expectedVersion: version, token: 'test-only', fetchImpl: mock.fetchImpl });
	assert.equal(result.apply, false);
	assert.equal(result.to, 'cinatoken-web');
	assert(mock.calls.every((call) => call.method === 'GET'));
});

for (const [name, options, message] of [
	['unexpected route owner', { owner: 'third-party-worker' }, /Current route owner changed/],
	['changed Worker deployment', { deployedVersion: '87654321-1234-1234-1234-123456789abc' }, /Target deployment changed/],
	['route drift during preflight', { drift: true }, /Route changed during preflight/],
])
	test(`${name} stops before writing any route`, async () => {
		const mock = fixture(options);
		await assert.rejects(switchWebRoute({ to: 'web', expectedVersion: version, apply: true, token: 'test-only', fetchImpl: mock.fetchImpl }), message);
		assert(mock.calls.every((call) => call.method === 'GET'));
	});

test('activation replaces only the exact existing frontend route and verifies readback', async () => {
	const mock = fixture();
	const result = await switchWebRoute({ to: 'web', expectedVersion: version, apply: true, token: 'test-only', fetchImpl: mock.fetchImpl });
	const writes = mock.calls.filter((call) => call.method === 'PUT');
	assert.equal(writes.length, 1);
	assert(writes[0].url.endsWith(`/zones/${productionWebRoute.zoneId}/workers/routes/${productionWebRoute.routeId}`));
	assert.deepEqual(JSON.parse(writes[0].body), { pattern: 'cinatoken.com/*', script: 'cinatoken-web' });
	assert.equal(result.after.script, 'cinatoken-web');
});

test('rollback uses the original Admin deployment without redeploying or changing financial state', async () => {
	const mock = fixture({ owner: 'cinatoken-web' });
	const result = await switchWebRoute({ to: 'admin', expectedVersion: version, apply: true, token: 'test-only', fetchImpl: mock.fetchImpl });
	assert.equal(result.after.script, 'cinatoken-admin');
	assert(mock.calls.every((call) => call.url.includes('/workers/routes/') || call.url.endsWith('/workers/scripts/cinatoken-admin/deployments')));
});
