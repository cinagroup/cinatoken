import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createServer } from 'node:http';
import { it } from 'node:test';
import { createJsonUploadBody } from './json-upload-body';
import { JSON_OUTPUT_PAGE_BYTES, JSON_STRING_PIECE_CHARS } from './stream-json-body';
import { dispatchOpenAiImageGenerations } from './openai-images-driver';
import type { RouteResult } from '../model-router';

const route = (): RouteResult => ({
	targetId: 'target', modelSurfaceId: null, routePoolId: null, providerId: 'synthetic', providerName: 'synthetic',
	providerModelName: 'image-model', upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://synthetic.example.invalid/v1' } }, providerApiKey: 'synthetic-key', providerSharedChannelType: null,
	priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null,
	routeGroup: 'default', routePriority: 1, routeWeight: 1,
});
const goodResponse = () => Response.json({ data: [{ b64_json: 'AQID' }] });
const active = () => {};

it('JSON upload preserves native bytes/length, ordered keys, omitted optionals and internal typed arrays', async () => {
	const source = JSON.parse('{"9":1,"2":2,"__proto__":{"a":1},"toJSON":"data"}') as Record<string, unknown>;
	Object.assign(source, { image: 'A'.repeat(8191) + '💡Ā\ud800\n"\\' + 'A'.repeat(65536),
		options: { omitted: undefined, nil: null }, array: [undefined, , null, Infinity, -0],
		internal: new Uint8Array([1, 2, 255]), date: new Date('2026-01-01Z'), boxed: [new Number(3), new String('label'), new Boolean(false)],
	});
	const expected = JSON.stringify(source), parent = new AbortController();
	const upload = createJsonUploadBody(source, parent.signal, active);
	const reader = upload.body.getReader(), chunks: Uint8Array[] = [];
	while (true) { const next = await reader.read(); if (next.done) break; assert.ok(next.value.length <= JSON_OUTPUT_PAGE_BYTES); chunks.push(next.value); }
	reader.releaseLock();
	assert.equal(Buffer.concat(chunks).toString('utf8'), expected);
	assert.equal(upload.contentLength, Buffer.byteLength(expected));
	assert.equal(getEventListeners(parent.signal, 'abort').length, 0); upload.dispose();
});

it('snapshot fixes values before dispatch admission; getter/toJSON run only once', async () => {
	let gets = 0, calls = 0;
	const source = { nested: { image: 'before' }, get opaque() { gets++; return { toJSON(key: string) { calls++; return key; } }; } };
	const upload = createJsonUploadBody(source, new AbortController().signal, active);
	source.nested.image = 'after';
	assert.equal(await new Response(upload.body).text(), '{"nested":{"image":"before"},"opaque":"opaque"}');
	assert.equal(gets, 1); assert.equal(calls, 1);
});

it('preflight measures only bounded scalar pieces and merged defaults do not inherit the ingress node limit', async t => {
	const stringify = JSON.stringify; let largest = 0;
	t.mock.method(JSON, 'stringify', (...args: Parameters<typeof JSON.stringify>) => {
		assert.notEqual(typeof args[0], 'object'); if (typeof args[0] === 'string') largest = Math.max(largest, args[0].length);
		return stringify(...args);
	});
	const upload = createJsonUploadBody({ image: 'A'.repeat(1024 * 1024), defaults: Array(65536).fill(0) }, new AbortController().signal, active);
	assert.ok(largest <= JSON_STRING_PIECE_CHARS); await upload.body.cancel();
});

for (const locked of [false, true]) for (const read of [false, true]) for (const stop of ['dispose', 'abort'] as const) {
	it(`JSON upload ${stop} frees ${locked ? 'locked' : 'unlocked'} encoder after ${read ? 'one page' : 'no read'}`, async () => {
		const parent = new AbortController();
		const upload = createJsonUploadBody({ image: 'A'.repeat(4 * JSON_OUTPUT_PAGE_BYTES) }, parent.signal, active);
		let reader = locked || read ? upload.body.getReader() : undefined;
		if (read) assert.equal((await reader!.read()).value?.length, JSON_OUTPUT_PAGE_BYTES);
		if (!locked) { reader?.releaseLock(); reader = undefined; }
		if (stop === 'dispose') upload.dispose(); else parent.abort('PRIVATE_DETAIL');
		reader ??= upload.body.getReader();
		await assert.rejects(reader.read(), { message: 'JSON response delivery was interrupted' }); reader.releaseLock();
		assert.equal(getEventListeners(parent.signal, 'abort').length, 0); upload.dispose();
	});
}

it('invalid/cyclic values and elapsed preflight fail before inference admission', async t => {
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	for (const value of [cyclic, { unsupported: 1n }, { unsupported: Object(1n) }]) {
		let sends = 0, admissions = 0;
		const result = await dispatchOpenAiImageGenerations(route(), value, undefined, undefined, undefined,
			{ fetchImpl: async () => { sends++; return goodResponse(); } }, async () => { admissions++; });
		assert.equal(result.response.status, 502); assert.equal(result.meta.admissionDeniedPreDispatch, true);
		assert.equal(sends, 0); assert.equal(admissions, 0); await result.response.text();
	}
	const parent = new AbortController(); let checks = 0;
	assert.throws(() => createJsonUploadBody({ image: 'A'.repeat(1024 * 1024) }, parent.signal, () => {
		if (++checks === 10) throw new Error('Synthetic elapsed deadline');
	}), /Synthetic elapsed deadline/);
	assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
});

for (const sse of [false, true]) it(`early ${sse ? 'SSE' : 'JSON'} response does not truncate upload at headers; terminal owner disposes residual body`, async t => {
	t.mock.method(console, 'log', () => {});
	let incoming!: ReadableStreamDefaultController<Uint8Array>, uploadReader!: ReadableStreamDefaultReader<Uint8Array>;
	let responseReading!: () => void;
	const reading = new Promise<void>(resolve => { responseReading = resolve; });
	const source = new ReadableStream<Uint8Array>({ start(c) { incoming = c; }, pull() { responseReading(); } }, { highWaterMark: 0 });
	const pending = dispatchOpenAiImageGenerations(route(), { image: 'A'.repeat(4 * JSON_OUTPUT_PAGE_BYTES), stream: sse }, undefined, undefined, undefined, {
		fetchImpl: async (_url, init) => {
			assert.ok(init?.body instanceof ReadableStream); uploadReader = init.body.getReader();
			return new Response(source, { headers: { 'Content-Type': sse ? 'text/event-stream' : 'application/json' } });
		},
	});
	if (sse) {
		const result = await pending;
		assert.equal((await uploadReader.read()).value?.length, JSON_OUTPUT_PAGE_BYTES);
		await result.response.body!.cancel(); await result.usagePromise;
	} else {
		await reading;
		assert.equal((await uploadReader.read()).value?.length, JSON_OUTPUT_PAGE_BYTES);
		incoming.enqueue(new TextEncoder().encode('{"data":[{"b64_json":"AQID"}]}')); incoming.close();
		const result = await pending; await result.response.text();
	}
	await assert.rejects(uploadReader.read()); uploadReader.releaseLock();
});

it('real loopback HTTP receives exact Content-Length, content and one generation dispatch', { timeout: 10000 }, async t => {
	t.mock.method(console, 'log', () => {});
	let sends = 0;
	const source = { prompt: 'synthetic', image: 'A'.repeat(3 * JSON_OUTPUT_PAGE_BYTES) + '💡\ud800\n', n: 1 };
	const expected = JSON.stringify({ ...source, model: 'image-model' });
	let received!: (result: { body: string; length: string | undefined; chunked: string | undefined }) => void;
	const observation = new Promise<{ body: string; length: string | undefined; chunked: string | undefined }>(resolve => { received = resolve; });
	const server = createServer((req, res) => {
		sends++; const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			received({ body: Buffer.concat(chunks).toString('utf8'), length: req.headers['content-length'], chunked: req.headers['transfer-encoding'] });
			res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[{"b64_json":"AQID"}]}');
		});
	});
	await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	const candidate = { ...route(), providerEndpoints: { openai: { base: `http://127.0.0.1:${address.port}/v1` } } };
	const result = await dispatchOpenAiImageGenerations(candidate, source);
	assert.equal(result.response.status, 200, await result.response.text());
	const seen = await observation; assert.equal(sends, 1); assert.equal(seen.body, expected);
	assert.equal(seen.length, String(Buffer.byteLength(expected))); assert.equal(seen.chunked, undefined);
});
