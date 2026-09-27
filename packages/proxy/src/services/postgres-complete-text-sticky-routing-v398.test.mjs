import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresCompleteTextStickyRoutingV398, PostgresStickyCleanupUnconfirmedV398 } from './postgres-complete-text-sticky-routing-v398.ts';
const role = 'cinatoken_gateway_complete_text_sticky_router';
const url = `postgres://${role}:fixture@127.0.0.1:5432/postgres?sslmode=disable`;
const context = { quoteId: '11111111-1111-4111-8111-111111111111', requestId: 'request', finalBodySha256: 'a'.repeat(64),
	routingEpoch: '1', candidateIndex: 0, routePoolId: 'pool', affinityHash: 'b'.repeat(64), sessionControlled: true, successPolicy: 'stream_success' };
const token = '22222222-2222-4222-8222-222222222222';
function fixture(options = {}) {
	let calls = 0, closed = 0, args, commit = false;
	const factory = () => ({ begin: async work => {
		const result = await work({ unsafe: async (sql, values) => {
			calls++;
			if (sql.startsWith('SELECT current_user')) return [{ current_role: options.wrongRole ?? role, session_role: role, isolation: 'read committed' }];
			if (sql.startsWith('SET LOCAL')) return [];
			args = values; return [{ value: options.value ?? { status: 'sticky_mutated', changed: true } }];
		} });
		if (options.commitError) throw new Error('COMMIT acknowledgement lost');
		commit = true; return result;
	}, end: async () => { closed++; if (options.closeError) throw new Error('close lost'); } });
	return { factory, state: () => ({ calls, closed, args, commit }) };
}
const bind = port => port.routePoolSticky.tryBind({ routePoolId: 'pool', affinityHash: context.affinityHash, routeTargetId: 'target',
	bindingToken: token, poolEpoch: 0, expiresAt: '2099-01-01T00:00:00Z', nowIso: '2000-01-01T00:00:00Z' });
test('sticky CAS result waits for transaction and close, sends no caller clock/epoch expiry', async () => {
	const f = fixture(); const port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context }, f.factory);
	assert.equal(await bind(port), true);
	assert.equal(f.state().commit, true); assert.equal(f.state().closed, 1);
	assert.deepEqual(f.state().args, [context.quoteId, context.requestId, context.finalBodySha256, '1', 0, 'pool', context.affinityHash,
		true, 'stream_success', 'bind', 'target', token, null]);
});
test('read binding returns only exact safe fields and rejects extra raw data', async () => {
	const binding = { route_pool_id: 'pool', affinity_hash: context.affinityHash, route_target_id: 'target', binding_token: token,
		pool_epoch: 0, expires_at: '2026-09-27T01:00:00Z', created_at: '2026-09-27T00:00:00Z', updated_at: '2026-09-27T00:00:00Z' };
	for (const extra of [false, true]) {
		const f = fixture({ value: { status: 'sticky_checked', binding: { ...binding, ...(extra ? { providerApiKey: 'secret' } : {}) } } });
		const port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context }, f.factory);
		if (extra) await assert.rejects(port.routePoolSticky.getBinding('pool', context.affinityHash), TypeError);
		else assert.deepEqual(await port.routePoolSticky.getBinding('pool', context.affinityHash), binding);
		assert.equal(f.state().closed, 1);
	}
});
test('context capture prevents post-construction mutation and mismatched access never opens SQL', async () => {
	const mutable = { ...context }, f = fixture();
	const port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context: mutable }, f.factory);
	mutable.routePoolId = 'changed'; mutable.routingEpoch = '2';
	assert.equal(await bind(port), true); assert.equal(f.state().args[3], '1');
	await assert.rejects(port.routePoolSticky.getBinding('changed', context.affinityHash));
	assert.equal(f.state().closed, 1);
});
test('wrong real LOGIN and unknown result never return a sticky success', async () => {
	for (const options of [{ wrongRole: 'cinatoken_gateway_runtime' }, { value: { status: 'sticky_mutated', changed: true, extra: 1 } }]) {
		const f = fixture(options), port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context }, f.factory);
		await assert.rejects(bind(port), TypeError); assert.equal(f.state().closed, 1);
	}
});
test('physical commit or cleanup acknowledgement failure never retries or releases a result', async () => {
	for (const options of [{ commitError: true }, { closeError: true }]) {
		const f = fixture(options), port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context }, f.factory);
		await assert.rejects(bind(port), options.closeError ? PostgresStickyCleanupUnconfirmedV398 : /COMMIT/u);
		assert.equal(f.state().closed, 1); assert.equal(f.state().calls, 4);
	}
});
test('abort before use prevents owned SQL work', async () => {
	const controller = new AbortController(); const f = fixture();
	const port = createPostgresCompleteTextStickyRoutingV398({ stickyConnectionString: url, context, signal: controller.signal }, f.factory);
	controller.abort(); await assert.rejects(bind(port)); assert.equal(f.state().calls, 0);
});
