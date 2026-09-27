import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageCapacityFixture } from './image-capacity-fixture';
import { drainNodeBackgroundWork } from '../runtime/schedule-background-work';

for (const operation of ['generations', 'edits'] as const) {
	test(`real Images ${operation} route uses the composed transport without changing global fetch`, async t => {
		let sends = 0, nativeSends = 0;
		t.mock.method(globalThis, 'fetch', async () => { nativeSends++; throw new Error('Unexpected native network'); });
		const f = await createImageCapacityFixture({ upstreamOrigin: 'http://127.0.0.1:12345', concurrency: 1, operation,
			imageFetch: async (url, init) => {
				sends++;
				assert.equal(String(url), `http://127.0.0.1:12345/v1/images/${operation}`);
				assert.equal(init?.redirect, 'manual'); assert.equal(init?.method, 'POST');
				assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer synthetic-provider-key');
				assert.ok(init?.signal); assert.equal(init.signal.aborted, false);
				assert.ok(init.body instanceof ReadableStream);
				let bytes = 0; for await (const chunk of init.body) bytes += chunk.byteLength;
				assert.equal(bytes, Number(new Headers(init.headers).get('Content-Length')));
				return Response.json({ data: [{ b64_json: 'AQID' }], usage: { input_tokens: 3, output_tokens: 7 } });
			},
		});
		f.releaseAccounting();
		const form = new FormData(); form.set('model', 'image-model'); form.set('prompt', 'test');
		form.set('image', new Blob(['synthetic'], { type: 'image/png' }), 'test.png');
		const body = operation === 'edits' ? form : JSON.stringify({ model: 'image-model', prompt: 'test', fetchImpl: 'client-cannot-select-transport' });
		try {
			const response = await f.app.request(`/v1/images/${operation}`, { method: 'POST', body,
				headers: { Authorization: 'Bearer synthetic-client-key', ...(operation === 'generations' ? { 'Content-Type': 'application/json' } : {}) } }, { REQUEST_BODY_LOGGING: 'off' });
			assert.equal(response.status, 200); const result = await response.json() as { data: unknown[] };
			assert.equal(result.data.length, 1);
			await drainNodeBackgroundWork();
			assert.equal(sends, 1); assert.equal(nativeSends, 0);
			assert.equal(f.stats.batchesStarted, f.stats.batchesCompleted);
			assert.equal(f.pool.snapshot().requests, 0);
		} finally { f.releaseAccounting(); await drainNodeBackgroundWork(); }
	});
}
