import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { createRequestDeadline } from '../request-deadline';
import { JSON_OUTPUT_PAGE_BYTES, JSON_STRING_PIECE_CHARS, jsonBodyByteLength, materializeJsonBodyText, streamJsonBody, streamJsonResponse } from './stream-json-body';
import { JsonStringPages } from './json-string-pages';

const limits = { maxDepth: 64, maxNodes: 196624 };
const encode = (value: string) => new TextEncoder().encode(value);
async function bytes(body: ReadableStream<Uint8Array>) {
	const reader = body.getReader(), pages: Uint8Array[] = []; let length = 0;
	try {
		while (true) {
			const next = await reader.read(); if (next.done) break;
			assert.ok(next.value.byteLength > 0 && next.value.byteLength <= JSON_OUTPUT_PAGE_BYTES);
			pages.push(next.value); length += next.value.byteLength;
		}
	} finally { reader.releaseLock(); }
	const result = new Uint8Array(length); let offset = 0;
	for (const page of pages) { result.set(page, offset); offset += page.length; }
	return result;
}
const scalars = [null, true, false, 0, -0, 1.25, -123, 1e21, 1e-7, Infinity, -Infinity, NaN, '', 'ASCII', '\u0000\b\f\n\r\t"\\', '图Ā💡', '\ud800', '\udfff'];
for (const [index, value] of scalars.entries()) it(`bounded JSON matches native scalar bytes ${index}`, async () => {
	assert.equal(materializeJsonBodyText(value, limits), JSON.stringify(value));
	assert.equal(jsonBodyByteLength(value, limits), encode(JSON.stringify(value)).length);
	assert.deepEqual(await bytes(streamJsonBody(value, limits)), encode(JSON.stringify(value)));
});
for (const offset of [-1, 0, 1]) for (const suffix of ['💡', '\ud800x', '\udfff', '\u0000', '"\\']) {
	it(`bounded JSON string boundary ${offset}, suffix ${JSON.stringify(suffix)}`, async () => {
		const long = 'a'.repeat(JSON_STRING_PIECE_CHARS + offset) + suffix + '图💡\\\n'.repeat(20000);
		const value = { [long]: [long, { tail: 'done' }] };
		assert.equal(materializeJsonBodyText(value, limits), JSON.stringify(value));
		assert.equal(jsonBodyByteLength(value, limits), encode(JSON.stringify(value)).length);
		assert.deepEqual(await bytes(streamJsonBody(value, limits)), encode(JSON.stringify(value)));
	});
}
it('bounded JSON preserves parsed integer key order, duplicate semantics, __proto__, nested arrays and toJSON data', async () => {
	const value: unknown = JSON.parse('{"z":0,"10":10,"2":2,"a":1,"a":2,"__proto__":{"data":"opaque"},"toJSON":"data","deep":[[],{},[true,null,1e400,-0]]}');
	assert.equal(materializeJsonBodyText(value, limits), JSON.stringify(value));
	assert.equal(jsonBodyByteLength(value, limits), encode(JSON.stringify(value)).length);
	assert.deepEqual(await bytes(streamJsonBody(value, limits)), encode(JSON.stringify(value)));
});
it('bounded JSON serializes no scalars eagerly and never stringifies a whole object or large scalar', async t => {
	const value = { data: [{ b64_json: 'a'.repeat(2 * JSON_OUTPUT_PAGE_BYTES) }], label: 'Ā' };
	const expected = encode(JSON.stringify(value)), stringify = t.mock.method(JSON, 'stringify');
	let finished = 0;
	const body = streamJsonBody(value, limits, { onFinished: () => { finished++; } });
	await nextTurn(); assert.equal(stringify.mock.callCount(), 0); assert.equal(finished, 0);
	assert.deepEqual(await bytes(body), expected); assert.equal(finished, 1);
	assert.ok(stringify.mock.calls.every(call => {
		const argument: unknown = call.arguments[0];
		return argument === null || typeof argument === 'number' || typeof argument === 'boolean'
			|| (typeof argument === 'string' && argument.length <= JSON_STRING_PIECE_CHARS);
	}));
});
const invalid: Array<[string, () => unknown]> = [
	['undefined', () => undefined], ['function', () => () => {}], ['bigint', () => 1n], ['symbol', () => Symbol('synthetic')],
	['undefined property', () => ({ data: undefined })], ['date', () => new Date(0)], ['map', () => new Map()],
	['sparse array', () => new Array(3)], ['accessor', () => Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('PRIVATE_DETAIL'); } })],
	['cycle', () => { const value: unknown[] = []; value.push(value); return value; }],
	['toJSON function', () => ({ toJSON() { throw new Error('PRIVATE_DETAIL'); } })],
];
for (const [name, make] of invalid) it(`unsupported ${name} rejected before a stream is returned`, () => {
	assert.throws(() => materializeJsonBodyText(make(), limits), { name: 'TypeError' });
	assert.throws(() => jsonBodyByteLength(make(), limits), { name: 'TypeError' });
	assert.throws(() => streamJsonBody(make(), limits), { name: 'TypeError' });
});
it('node/depth validation agrees at exact boundary and rejects overflow before body delivery', async () => {
	assert.equal(materializeJsonBodyText({ x: [0] }, { maxDepth: 2, maxNodes: 4 }), '{"x":[0]}');
	assert.throws(() => materializeJsonBodyText({ x: [0] }, { maxDepth: 1, maxNodes: 4 }));
	assert.throws(() => materializeJsonBodyText({ x: [0] }, { maxDepth: 2, maxNodes: 3 }));
	assert.throws(() => materializeJsonBodyText({}, { maxDepth: 0, maxNodes: 1 }));
	assert.deepEqual(await bytes(streamJsonBody({ x: [0] }, { maxDepth: 2, maxNodes: 4 })), encode('{"x":[0]}'));
	assert.throws(() => streamJsonBody({ x: [0] }, { maxDepth: 1, maxNodes: 4 }));
	assert.throws(() => streamJsonBody({ x: [0] }, { maxDepth: 2, maxNodes: 3 }));
	assert.throws(() => streamJsonBody({}, { maxDepth: 0, maxNodes: 1 }));
});
for (const phase of ['unread', 'one-page', 'eof'] as const) for (const stop of ['cancel', 'abort', 'timer', 'elapsed'] as const) {
	it(`bounded JSON ${stop} at ${phase} releases listeners exactly once without exposing abort detail`, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		const client = new AbortController(), owner = createRequestDeadline(1000, client.signal); let finished = 0;
		const body = streamJsonBody({ value: 'a'.repeat(3 * JSON_OUTPUT_PAGE_BYTES) }, limits, {
			signal: owner.signal, checkActive: owner.throwIfStopped, onFinished: () => { finished++; owner.dispose(); },
		});
		const reader = body.getReader();
		if (phase === 'one-page') { const first = await reader.read(); assert.equal(first.value?.length, JSON_OUTPUT_PAGE_BYTES); }
		if (phase === 'eof') while (!(await reader.read()).done) { /* drain */ }
		if (stop === 'cancel') await reader.cancel('PRIVATE_DETAIL');
		else if (stop === 'abort') client.abort('PRIVATE_DETAIL');
		else if (stop === 'timer') t.mock.timers.tick(1000);
		else t.mock.timers.setTime(1000);
		if (phase === 'eof' || stop === 'cancel') assert.equal((await reader.read()).done, true);
		else await assert.rejects(reader.read(), { message: 'JSON response delivery was interrupted' });
		assert.equal(finished, 1); assert.equal(getEventListeners(owner.signal, 'abort').length, 0);
		assert.equal(getEventListeners(client.signal, 'abort').length, 0); reader.releaseLock();
	});
}
it('already aborted ownership is rejected synchronously without registering a listener', () => {
	const client = new AbortController(); client.abort();
	assert.throws(() => streamJsonBody({}, limits, { signal: client.signal }));
	assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});
for (const status of [204, 205, 304, 99]) it(`Response constructor rejection ${status} disposes its encoder`, () => {
	const client = new AbortController(); let finished = 0;
	assert.throws(() => streamJsonResponse({}, limits, { status }, { signal: client.signal, onFinished: () => { finished++; } }));
	assert.equal(finished, 1); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});

const paged = (value: string, width = 8192) => new JsonStringPages(
	Array.from({ length: Math.ceil(value.length / width) }, (_, index) => value.slice(index * width, (index + 1) * width)),
);

it('wire length matches native escaping for every individual UTF-16 code unit', () => {
	for (let code = 0; code <= 0xffff; code++) {
		const value = String.fromCharCode(code);
		assert.equal(materializeJsonBodyText(value, limits), JSON.stringify(value));
		assert.equal(jsonBodyByteLength(value, limits), encode(JSON.stringify(value)).length, `code unit ${code}`);
	}
});

it('wire length preserves surrogate adjacency across arbitrary decoded page boundaries', () => {
	const units = ['a', '\u0000', '"', '\\', '\u007f', '\u07ff', '\u0800', '\ud800', '\udbff', '\udc00', '\udfff', '图'];
	for (const a of units) for (const b of units) for (const c of units) {
		const value = a + b + c, expected = encode(JSON.stringify(value)).length;
		for (const width of [1, 2]) assert.equal(jsonBodyByteLength(paged(value, width), limits), expected);
	}
});

for (const boundary of [0, 1, 8191, 8192, 65535, 65536, 65537]) for (const suffix of ['💡', '\ud800X\udc00', '\n"\\\u0000']) {
	it(`wire length and bytes agree across decoded/encoder boundary ${boundary}/${JSON.stringify(suffix)}`, async t => {
		const plain = 'A'.repeat(boundary) + suffix + '图'.repeat(8193), expected = encode(JSON.stringify({ [plain]: [plain] }));
		const value = { [plain]: [paged(plain)] };
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No whole string copy'); });
		assert.equal(materializeJsonBodyText(value, limits), new TextDecoder().decode(expected));
		assert.equal(jsonBodyByteLength(value, limits), expected.length);
		assert.deepEqual(await bytes(streamJsonBody(value, limits)), expected);
	});
}

it('wire length and encoder carry a high surrogate through empty decoded pages', async () => {
	for (const chunks of [[], ['', ''], ['\ud800', '', '\udc00'], ['\ud800', '', ''], ['', '\udc00'], ['\ud800', '', '\ud800', '', '\udc00']]) {
		const expected = encode(JSON.stringify(chunks.join(''))), value = new JsonStringPages(chunks);
		assert.equal(materializeJsonBodyText(value, limits), new TextDecoder().decode(expected));
		assert.equal(jsonBodyByteLength(value, limits), expected.length);
		assert.deepEqual(await bytes(streamJsonBody(value, limits)), expected);
	}
});

it('wire length counts strings and keys without stringify, encoding or materialization', t => {
	const raw = '\u0000\b\f\n\r\t"\\Ā图💡\ud800'.repeat(30000), key = 'long-key'.repeat(10000);
	const expected = encode(JSON.stringify({ [key]: [raw, ''] })).length;
	const value = { [key]: [paged(raw), ''] };
	t.mock.method(JSON, 'stringify', () => { throw new Error('No serialization while counting'); });
	t.mock.method(TextEncoder.prototype, 'encode', () => { throw new Error('No byte allocation while counting'); });
	t.mock.method(TextEncoder.prototype, 'encodeInto', () => { throw new Error('No encoding while counting'); });
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No whole string copy'); });
	assert.equal(jsonBodyByteLength(value, limits), expected);
});

for (const representation of ['native', 'paged']) for (const sample of ['ascii', '图Ā\ufeff\u2028\u2029', '\ufffd']) {
	it(`unescaped ${representation} output reuses string pieces without native stringify: ${sample}`, async t => {
		const plain = sample.repeat(100000), expected = encode(JSON.stringify(plain));
		const value = representation === 'native' ? plain : paged(plain);
		t.mock.method(JSON, 'stringify', () => { throw new Error('No escaping needed'); });
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No whole string copy'); });
		assert.equal(jsonBodyByteLength(value, limits), expected.length);
		assert.deepEqual(await bytes(streamJsonBody(value, limits)), expected);
	});
}

for (const position of ['key', 'value']) it(`wire length checks cancellation within a large ${position}`, t => {
	const long = 'A'.repeat(512 * 1024), value = position === 'key' ? { [long]: true } : { data: paged(long) };
	let checks = 0;
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No whole string copy'); });
	assert.throws(() => jsonBodyByteLength(value, limits, () => { if (++checks === 20) throw new Error('Synthetic deadline'); }), /Synthetic deadline/);
	assert.equal(checks, 20);
});

it('wire length preserves empty containers, shared values and independent structure limits', () => {
	const child = { empty: [], object: {}, text: '' }, value = [child, child, null, -0, Infinity, false];
	assert.equal(jsonBodyByteLength(value, limits), encode(JSON.stringify(value)).length);
	assert.equal(jsonBodyByteLength({ x: [0] }, { maxDepth: 2, maxNodes: 4 }), 9);
	assert.throws(() => jsonBodyByteLength({ x: [0] }, { maxDepth: 1, maxNodes: 4 }));
	assert.throws(() => jsonBodyByteLength({ x: [0] }, { maxDepth: 2, maxNodes: 3 }));
	assert.throws(() => jsonBodyByteLength({}, { maxDepth: 0, maxNodes: 1 }));
});

it('wire length and stream use array indices, never a caller-supplied iterator', async () => {
	const value = ['synthetic', 0, false];
	Object.defineProperty(value, Symbol.iterator, { value() { throw new Error('Must not invoke array iteration'); } });
	const expected = encode(JSON.stringify(value));
	assert.equal(materializeJsonBodyText(value, limits), new TextDecoder().decode(expected));
	assert.equal(jsonBodyByteLength(value, limits), expected.length);
	assert.deepEqual(await bytes(streamJsonBody(value, limits)), expected);
});

it('audit text serializes only bounded escaping pieces, without native object/scalar copies or UTF-8 buffers', t => {
	const text = '图\n"\\\u0000\ud800💡'.repeat(20000), plain = { [text]: [text, text], count: 3 };
	const expected = JSON.stringify(plain), stringify = JSON.stringify;
	const value = { [text]: [paged(text), paged(text)], count: 3 };
	t.mock.method(JSON, 'stringify', ((item: unknown) => {
		assert.ok(typeof item === 'number' || (typeof item === 'string' && item.length <= JSON_STRING_PIECE_CHARS));
		return stringify(item);
	}) as typeof JSON.stringify);
	t.mock.method(TextEncoder.prototype, 'encode', () => { throw new Error('No UTF-8 buffer'); });
	t.mock.method(TextEncoder.prototype, 'encodeInto', () => { throw new Error('No UTF-8 buffer'); });
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No full scalar copy'); });
	assert.equal(materializeJsonBodyText(value, limits), expected);
});

for (const position of ['key', 'value']) it(`audit text checks cancellation inside a long ${position}`, () => {
	const text = 'A'.repeat(200000), value = position === 'key' ? { [text]: true } : { data: paged(text) };
	let checks = 0; const reason = new Error('Synthetic deadline');
	assert.throws(() => materializeJsonBodyText(value, limits, () => { if (++checks === 15) throw reason; }), error => error === reason);
	assert.equal(checks, 15);
});

it('audit text checks cancellation before work and immediately after its unavoidable final join', () => {
	const reason = new Error('Synthetic deadline');
	assert.throws(() => materializeJsonBodyText({}, limits, () => { throw reason; }), error => error === reason);
	const value = { data: paged('A'.repeat(200000)) }, join = Array.prototype.join;
	let joined = false;
	// Node's mock.method rejects array objects (including Array.prototype).
	try {
		Array.prototype.join = function(this: unknown[], separator?: string) { const result = join.call(this, separator); joined = true; return result; };
		assert.throws(() => materializeJsonBodyText(value, limits, () => { if (joined) throw reason; }), error => error === reason);
	} finally { Array.prototype.join = join; }
	assert.ok(joined);
});
