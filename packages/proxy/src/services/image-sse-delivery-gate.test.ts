import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {gateImageSseDelivery} from './image-sse-delivery-gate';

const encode = (text: string) => new TextEncoder().encode(text);
const completed = 'data: {"type":"image_generation.completed","b64_json":"AQID"}\n\n';
const done = 'data: [DONE]\n\n';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return {promise, resolve}; }
function source() {
	let cancels = 0;
	const body = new ReadableStream<Uint8Array>({start(c) { c.enqueue(encode(completed)); c.enqueue(encode(done)); }, cancel() { cancels++; }});
	return {response: new Response(body), get cancels() { return cancels; }};
}
for (const mode of ['confirmed', 'rejected', 'timeout', 'cancel'] as const) test('image SSE delivery gate: ' + mode, async t => {
	t.mock.timers.enable({apis: ['setTimeout']});
	const pending = deferred(), upstream = source();
	const accepted = mode === 'rejected' ? Promise.reject(new Error('private-db-error')) : pending.promise;
	const response = gateImageSseDelivery(upstream.response, accepted, 'gen-trusted');
	const reader = response.body!.getReader();
	assert.equal(new TextDecoder().decode((await reader.read()).value), completed);
	let delivered = false;
	const reading = reader.read().then(value => { delivered = true; return value; });
	await tick();
	if (mode !== 'rejected') assert.equal(delivered, false);
	if (mode === 'confirmed') pending.resolve();
	if (mode === 'timeout') { t.mock.timers.tick(14_999); await tick(); assert.equal(delivered, false); t.mock.timers.tick(1); }
	if (mode === 'cancel') { await reader.cancel(); assert.equal((await reading).done, true); pending.resolve(); await tick(); assert.equal(upstream.cancels, 1); return; }
	const text = new TextDecoder().decode((await reading).value);
	if (mode === 'confirmed') assert.equal(text, done);
	else {
		const frame = JSON.parse(text.slice(6));
		assert.equal(frame.type, 'error');
		assert.deepEqual(frame.error.metadata, {request_id:'gen-trusted',outcome_unknown:true,retry_safe:false});
		assert.doesNotMatch(text, /private-db-error/);
		assert.equal(new TextDecoder().decode((await reader.read()).value), done);
		pending.resolve(); // A late financial confirmation does not append success.
	}
	await reader.cancel(); assert.equal(upstream.cancels, 1);
});
