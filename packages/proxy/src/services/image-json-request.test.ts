import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readImageJsonRequest } from './image-json-request';
import { JsonStringPages, materializeJsonStringTree } from './egress/json-string-pages';
import { IMAGE_CONTROL_MAX_CHARS, IMAGE_PROVIDER_MAX_JSON_BYTES, ImageControlLimitError } from './image-control-limits';
import { JsonStructureLimitError } from './json-structure-budget';

const encoder = new TextEncoder();

for (const width of [1, 7]) it(`property-name length counts decoded invalid-UTF8 replacement at ${width}-byte splits`, async () => {
	for (const extra of [0, 1]) {
		const head = encoder.encode('{"'), tail = encoder.encode('":0}');
		const bytes = new Uint8Array(head.length + 256 + extra + tail.length).fill(255);
		bytes.set(head); bytes.set(tail, head.length + 256 + extra);
		const pending = readImageJsonRequest(request(bytes, width));
		if (extra) await assert.rejects(pending, JsonStructureLimitError);
		else assert.equal((await pending)['�'.repeat(256)], 0);
	}
});

it('oversized property name stops ingress before its huge tail, native allocation or dispatch', async t => {
	let pulls = 0, cancels = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (++pulls === 1) c.enqueue(encoder.encode('{"discard":{"' + '\\u0041'.repeat(257)));
		else throw new Error('Must not read the unbounded tail');
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('No native string allocation'); });
	await assert.rejects(readImageJsonRequest(new Request('https://synthetic.invalid', { method: 'POST', body: source, duplex: 'half' } as RequestInit)), JsonStructureLimitError);
	assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false);
});
function request(bytes: Uint8Array, width: number, signal?: AbortSignal) {
	let offset = 0;
	const body = new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === bytes.length) { c.close(); return; }
		const end = Math.min(bytes.length, offset + width); c.enqueue(bytes.subarray(offset, end)); offset = end;
	} }, { highWaterMark: 0 });
	return new Request('https://synthetic.example.invalid', { method: 'POST', body, signal, duplex: 'half' } as RequestInit);
}

for (const width of [1, 7, 8192, 65536]) {
	it(`image ingress parser matches native Request.json at ${width}-byte boundaries`, async () => {
		const head = encoder.encode('\uFEFF{"text":"' + 'A'.repeat(8191) + '💡Ā\\ud800\\n\\u0000'), tail = encoder.encode('","dup":0,"dup":1,"n":1e400,"round":0.123456789012345678,"__proto__":{"x":1}}');
		const bytes = new Uint8Array(head.length + 1 + tail.length); bytes.set(head); bytes[head.length] = 255; bytes.set(tail, head.length + 1);
		const expected = await request(bytes, bytes.length).json();
		const actual = await readImageJsonRequest(request(bytes, width));
		assert.ok(actual.text instanceof JsonStringPages);
		assert.deepEqual(materializeJsonStringTree(actual), expected);
	});
}

for (const text of ['', ' ', 'null', 'true', '[]', '42', '{"x":1,}', '{"x":"truncated', '{}{}']) {
	it(`image ingress rejects non-object or malformed ${JSON.stringify(text)} without exposing its contents`, async () => {
		await assert.rejects(readImageJsonRequest(request(encoder.encode(text), 1)), { message: 'Invalid JSON body' });
	});
}

it('image ingress cancellation never waits for a stalled transport cancel acknowledgement', async () => {
	const parent = new AbortController(); let cancel = 0;
	const source = new ReadableStream<Uint8Array>({ cancel() { cancel++; return new Promise<void>(() => {}); } });
	const req = new Request('https://synthetic.example.invalid', { method: 'POST', body: source, signal: parent.signal, duplex: 'half' } as RequestInit);
	const pending = readImageJsonRequest(req); parent.abort(new Error('synthetic stop'));
	await assert.rejects(pending, /synthetic stop/); assert.equal(cancel, 1); assert.equal(source.locked, false);
});

for (const [field, limit] of Object.entries(IMAGE_CONTROL_MAX_CHARS)) {
	for (const shape of ['ascii', 'unicode', 'escaped', 'padding'] as const) {
		it(`image ${field} ${shape} limit counts decoded UTF-16 before trim, including exact boundary`, async () => {
			for (const extra of [0, 1]) {
				const value = shape === 'unicode' ? '💡'.repeat(limit / 2) + 'Ā'.repeat(extra)
					: (shape === 'padding' ? ' ' : 'A').repeat(limit + extra);
				const quoted = shape === 'escaped' ? '"' + '\\u0041'.repeat(limit + extra) + '"' : JSON.stringify(value);
				const pending = readImageJsonRequest(request(encoder.encode(`{"${field}":${quoted}}`), 7));
				if (extra) await assert.rejects(pending, { name: 'ImageControlLimitError', message: `${field} must be at most ${limit} characters` });
				else assert.equal((await pending)[field], value);
			}
		});
	}
	it(`oversized paged ${field} is rejected without materialization`, async t => {
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must reject before joining'); });
		await assert.rejects(readImageJsonRequest(request(encoder.encode(JSON.stringify({ [field]: 'A'.repeat(20000) })), 8191)), ImageControlLimitError);
	});
	it(`wrong-type ${field} does not materialize nested strings`, async t => {
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must leave wrong types paged'); });
		const body = await readImageJsonRequest(request(encoder.encode(JSON.stringify({ [field]: [{ x: 'A'.repeat(20000) }] })), 8191));
		assert.ok((body[field] as Array<{ x: unknown }>)[0]!.x instanceof JsonStringPages);
	});
}

for (const shape of ['ascii', 'unicode', 'escape', 'key', 'array', 'string'] as const) {
	it(`provider ${shape} compact JSON byte ceiling admits exact boundary and rejects one byte over`, async t => {
		const materialize = JsonStringPages.prototype.materialize;
		t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
			assert.ok(this.length <= IMAGE_PROVIDER_MAX_JSON_BYTES); return materialize.call(this);
		});
		for (const extra of [0, 1]) {
			const special = shape === 'unicode' ? '💡Ā' : shape === 'escape' ? '\u0000\n"\\\ud800' : '';
			const wrap = (value: string): unknown => shape === 'key' ? { ...Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['k'.repeat(128) + i, ''])), pad: value } : shape === 'array' ? [value] : shape === 'string' ? value : { x: value };
			const overhead = Buffer.byteLength(JSON.stringify(wrap(special)));
			const value = wrap(special + 'A'.repeat(IMAGE_PROVIDER_MAX_JSON_BYTES - overhead + extra));
			assert.equal(Buffer.byteLength(JSON.stringify(value)), IMAGE_PROVIDER_MAX_JSON_BYTES + extra);
			const pending = readImageJsonRequest(request(encoder.encode(JSON.stringify({ provider: value })), 8191));
			if (extra) await assert.rejects(pending, { message: 'provider must be at most 16384 JSON bytes' });
			else assert.deepEqual((await pending).provider, value);
		}
	});
}

it('provider limit includes every surviving unknown nested value, without joining them', async t => {
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must not join rejected provider values'); });
	await assert.rejects(readImageJsonRequest(request(encoder.encode(JSON.stringify({ provider: { unknown: ['A'.repeat(20000)] } })), 8191)), ImageControlLimitError);
});

it('control admission uses last duplicate values and never joins overwritten large subtrees', async t => {
	const discarded = JSON.stringify({ nested: ['A'.repeat(20000)] });
	const text = `{"model":"${'A'.repeat(20000)}","size":${discarded},"provider":${discarded},"mo\\u0064el":"image-model","size":"1024x1024","provider":{"order":["test"]}}`;
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Must skip discarded values'); });
	assert.deepEqual(await readImageJsonRequest(request(encoder.encode(text), 8191)), JSON.parse(text));
});

it('a late oversized duplicate cannot bypass control admission', async () => {
	await assert.rejects(readImageJsonRequest(request(encoder.encode('{"size":"1024x1024","si\\u007ae":"' + 'A'.repeat(65) + '"}'), 1)), ImageControlLimitError);
});

it('malformed overwritten values and tails remain syntax errors, before field limits', async () => {
	for (const text of ['{"size":"\\x","size":"1024x1024"}', '{"size":"' + 'A'.repeat(20000) + '"}{}']) {
		await assert.rejects(readImageJsonRequest(request(encoder.encode(text), 8191)), { message: 'Invalid JSON body' });
	}
});
