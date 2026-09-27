import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { RequestExecutionStoppedError } from '@octafuse/core';
import { RequestBodyTooLargeError } from '../bounded-request-body';
import { BoundedJsonRequestError, readBoundedJsonObject } from './bounded-json-request';

function request(body: BodyInit, signal?: AbortSignal, length?: number) {
	const init = { method: 'POST', body, signal, duplex: 'half', headers: { 'Content-Type': 'application/json',
		...(length === undefined ? {} : { 'Content-Length': String(length) }) } };
	return new Request('https://gateway.example.invalid/v1/rerank', init);
}
const options = { maxBytes: 3, label: 'Synthetic' };

it('accepts a strict JSON object exactly at the byte limit', async () => {
	assert.deepEqual(await readBoundedJsonObject(request('{} '), options), {});
});

for (const declared of [false, true]) {
	it(`size rejection does not await hanging cancel acknowledgement (declared=${declared})`, { timeout: 1000 }, async () => {
		let cancels = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.enqueue(new TextEncoder().encode('{}  ')); },
			cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		await assert.rejects(readBoundedJsonObject(request(source, undefined, declared ? 4 : undefined), options),
			(error: unknown) => error instanceof BoundedJsonRequestError && error.kind === 'payload_too_large');
		assert.equal(cancels, 1); assert.equal(source.locked, false);
	});
}

it('client cancellation stays bounded when its body refuses cancel acknowledgement', { timeout: 1000 }, async () => {
	const parent = new AbortController(); let cancels = 0;
	const source = new ReadableStream<Uint8Array>({ cancel() { cancels++; return new Promise<void>(() => {}); } });
	const work = readBoundedJsonObject(request(source, parent.signal), options);
	const rejected = assert.rejects(work, (error: unknown) => error instanceof BoundedJsonRequestError && error.kind === 'cancelled');
	await nextTurn(); parent.abort('PRIVATE_DETAIL'); await rejected; assert.equal(cancels, 1); assert.equal(source.locked, false);
});

for (const error of [new RequestBodyTooLargeError(), new RequestExecutionStoppedError('deadline_exceeded'), new RequestExecutionStoppedError('client_cancelled')]) {
	it(`preserves the ingress guard error identity: ${error.message}`, async () => {
		const source = new ReadableStream<Uint8Array>({ pull(c) { c.error(error); } });
		await assert.rejects(readBoundedJsonObject(request(source), options), received => received === error);
		assert.equal(source.locked, false);
	});
}

for (const body of ['{', '[]', new Uint8Array([0xff])]) {
	it(`invalid input is still rejected: ${typeof body === 'string' ? body : 'UTF-8'}`, async () => {
		await assert.rejects(readBoundedJsonObject(request(body), options), BoundedJsonRequestError);
	});
}
