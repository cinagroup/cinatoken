import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { drainNodeBackgroundWork } from '../runtime/schedule-background-work';
import { createImageCapacityFixture } from './image-capacity-fixture';

for (const first of ['response', 'accounting', 'cancel'] as const) {
	it(`real Images route: ${first} does not release another owner's reservation`, async t => {
		const f = await createImageCapacityFixture({ upstreamOrigin: 'http://127.0.0.1:1', concurrency: 1, operation: 'generations' });
		let sends = 0;
		t.mock.method(globalThis, 'fetch', async () => { sends++; return Response.json({ data: [{ b64_json: 'AQID' }], usage: { input_tokens: 3, output_tokens: 7 } }); });
		t.mock.method(console, 'log', () => {});
		const errors: unknown[][] = [];
		t.mock.method(console, 'error', (...args: unknown[]) => { errors.push(args); });
		let response: Response | undefined;
		t.after(async () => {
			f.releaseAccounting(); await response?.body?.cancel().catch(() => {}); await drainNodeBackgroundWork(); assert.deepEqual(errors, []);
		});
		response = await f.app.fetch(new Request('http://gateway.invalid/v1/images/generations', {
			method: 'POST', headers: { Authorization: 'Bearer synthetic-client-key', 'Content-Type': 'application/json' },
			body: JSON.stringify({ model: 'image-model', prompt: 'test' }),
		}), { REQUEST_BODY_LOGGING: 'off' });
		assert.equal(response.status, 200);
		const end = performance.now() + 3000;
		while (f.stats.batchesStarted !== 1) { assert.ok(performance.now() < end); await nextTurn(); }
		assert.ok(f.stats.auth > 0); assert.ok(f.stats.models > 0); assert.ok(f.stats.guardrail > 0);
		if (first === 'accounting') { f.releaseAccounting(); await drainNodeBackgroundWork(); }
		else if (first === 'cancel') await response.body!.cancel();
		else assert.equal((await response.json() as { usage: { total_tokens: number } }).usage.total_tokens, 10);
		assert.equal(f.pool.snapshot().requests, 1);
		const before = { ...f.stats };
		const denied = await f.app.fetch(new Request('http://gateway.invalid/api/v1/images/generations', { method: 'POST', body: '{}' }));
		assert.equal(denied.status, 503); assert.equal(denied.headers.get('X-OctaFuse-Error-Code'), 'gateway.capacity_unavailable');
		await denied.body?.cancel(); assert.deepEqual(f.stats, before); assert.equal(sends, 1);
		if (first === 'accounting') { await response.body!.cancel(); await drainNodeBackgroundWork(); }
		else { f.releaseAccounting(); await drainNodeBackgroundWork(); }
		assert.equal(f.stats.batchesCompleted, 1); assert.equal(f.pool.snapshot().requests, 0);
	});
}
