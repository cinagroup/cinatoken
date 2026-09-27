import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import type { RouteResult } from '../model-router';
import { IMAGE_JSON_STRUCTURE_LIMITS } from '../json-structure-budget';
import { JsonStringPages, JSON_TEXT_PAGE_CHARS, hasJsonStringContent, materializeJsonStringTree, trimJsonString } from './json-string-pages';
import { CompactJsonStringPage } from './compact-json-string-page';
import { segmentedJsonResponseWithinLimit } from './segmented-json-response';
import { streamJsonResponse, jsonBodyByteLength, JSON_OUTPUT_PAGE_BYTES, JSON_STRING_PIECE_CHARS } from './stream-json-body';
import { countValidImageResults, dispatchOpenAiImageGenerations, dispatchOpenAiImageEdits, normalizeOpenRouterImageResponse } from './openai-images-driver';

const limits = IMAGE_JSON_STRUCTURE_LIMITS;
const encode = (value: string) => new TextEncoder().encode(value);
function source(raw: Uint8Array, width: number): Response {
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === raw.length) c.close();
		else { const end = Math.min(raw.length, offset + width); c.enqueue(raw.subarray(offset, end)); offset = end; }
	} }, { highWaterMark: 0 }));
}
async function parse(raw: Uint8Array, width = 8191) {
	const material = await segmentedJsonResponseWithinLimit(source(raw, width), 32 * 1024 * 1024, limits, undefined, { retainStringPages: true });
	assert.equal(material.jsonValid, true); return material.body;
}
function pages(value: string): JsonStringPages {
	const parts: string[] = [];
	for (let start = 0; start < value.length; start += JSON_TEXT_PAGE_CHARS) parts.push(value.slice(start, start + JSON_TEXT_PAGE_CHARS));
	return new JsonStringPages(parts);
}
async function streamed(value: unknown): Promise<string> {
	const response = streamJsonResponse(value, limits, {}), reader = response.body!.getReader(), decoder = new TextDecoder();
	let text = '';
	while (true) {
		const next = await reader.read(); if (next.done) break;
		assert.ok(next.value.length <= JSON_OUTPUT_PAGE_BYTES); text += decoder.decode(next.value, { stream: true });
	}
	reader.releaseLock(); return text + decoder.decode(); // Independent client materialization, test only.
}

it('paged strings are immutable internal scalars and fail loudly at accidental native serialization/coercion', async () => {
	const input = ['A', '\ud800', '', '\udc00'], value = new JsonStringPages(input);
	input[0] = 'changed'; assert.equal(value.length, 3); assert.equal(value.materialize(), 'A𐀀');
	assert.ok(Object.isFrozen(value));
	assert.throws(() => JSON.stringify(value), /streaming encoder/);
	assert.throws(() => String(value), /explicit materialization/);
	assert.throws(() => new JsonStringPages(['A'.repeat(JSON_TEXT_PAGE_CHARS + 1)]), RangeError);
	assert.equal(await streamed(value), JSON.stringify('A𐀀'));
	assert.equal(await streamed(new JsonStringPages([])), '""');
});

it('compact storage keeps native short, Latin-1 and non-saving BMP/emoji pages', () => {
	for (const text of ['', '�'.repeat(1023), 'A'.repeat(65536), 'ÿ'.repeat(8192), 'Ā'.repeat(8192), '图'.repeat(8192), '💡'.repeat(4096)]) {
		assert.equal(CompactJsonStringPage.from(text), text);
	}
	assert.throws(() => CompactJsonStringPage.from('A'.repeat(65537)), RangeError);
});

it('compact storage owns private bytes, has no retained native cache and never exports its encoding', () => {
	const text = 'A�'.repeat(4096), page = CompactJsonStringPage.from(text);
	assert.ok(page instanceof CompactJsonStringPage);
	assert.equal(page.byteLength, text.length); assert.equal(page.length, text.length);
	assert.ok(Object.isFrozen(page)); assert.deepEqual(Reflect.ownKeys(page), []);
	assert.throws(() => JSON.stringify(page), /internal only/); assert.throws(() => String(page), /explicit decoding/);
	assert.equal(page.decode(), text); assert.equal(page.decode(), text);
	assert.deepEqual(Reflect.ownKeys(page), []);
	const inputs = [page], value = new JsonStringPages(inputs); inputs.length = 0;
	assert.equal(value.materialize(), text);
});

it('compact page round trips every UTF-16 code unit, including all lone surrogates and noncharacters', () => {
	for (let base = 0; base < 65536; base += 1024) {
		const units = Array.from({ length: 1024 }, (_, i) => String.fromCharCode(base + i) + 'X').join('');
		const text = '�'.repeat(8192) + units, page = CompactJsonStringPage.from(text);
		assert.ok(page instanceof CompactJsonStringPage); assert.equal(page.decode(), text);
	}
});

it('compact page round trips surrogate pairs across every high-surrogate and low-bit boundary', () => {
	for (const low of [0xdc00, 0xdc01, 0xdc3f, 0xdc40, 0xdcff, 0xdd00, 0xdffe, 0xdfff]) {
		const units = Array.from({ length: 1024 }, (_, i) => String.fromCharCode(0xd800 + i, low)).join('');
		const text = '�'.repeat(4096) + units, page = CompactJsonStringPage.from(text);
		assert.ok(page instanceof CompactJsonStringPage); assert.equal(page.decode(), text);
	}
});

it('compact storage and wire encoding match native JSON for 128 seeded mixed UTF-16 pages', async () => {
	let seed = 0x51729;
	for (let run = 0; run < 128; run++) {
		const units = Array.from({ length: 2048 }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed >>> 16; });
		const text = '�'.repeat(8192) + String.fromCharCode(...units), page = CompactJsonStringPage.from(text);
		assert.ok(page instanceof CompactJsonStringPage); assert.equal(page.decode(), text);
		const value = new JsonStringPages([page]), expected = JSON.stringify(text);
		assert.equal(jsonBodyByteLength(value, limits), encode(expected).length); assert.equal(await streamed(value), expected);
	}
});

for (const length of [8191, 8192, 65536]) it(`compact pages preserve split surrogate pairs and escaping at ${length} UTF-16 units`, async () => {
	const first = '�'.repeat(length - 1) + '\ud800', last = '\udc00\udc00X\ud800\n"\\\u0000' + '�'.repeat(8192);
	const value = new JsonStringPages([CompactJsonStringPage.from(first), '', CompactJsonStringPage.from(last)]), expected = JSON.stringify(first + last);
	assert.equal(value.length, first.length + last.length);
	assert.equal(jsonBodyByteLength(value, limits), encode(expected).length); assert.equal(await streamed(value), expected);
});

for (const padding of [false, true]) it(`trim shares compact interiors without decoding them, padding=${padding}`, t => {
	const interior = CompactJsonStringPage.from('�'.repeat(8192)); assert.ok(interior instanceof CompactJsonStringPage);
	const parts = [CompactJsonStringPage.from('A�'.repeat(4096)), ...Array.from({ length: 32 }, () => interior), CompactJsonStringPage.from('�Z'.repeat(4096))];
	const value = new JsonStringPages(padding ? [' ', ...parts, '\ufeff'] : parts);
	const decode = CompactJsonStringPage.prototype.decode; let calls = 0;
	t.mock.method(CompactJsonStringPage.prototype, 'decode', function(this: CompactJsonStringPage) {
		assert.notEqual(this, interior, 'trim must not materialize interior pages'); calls++; return decode.call(this);
	});
	const result = trimJsonString(value); assert.equal(calls, 2);
	if (!padding) assert.equal(result, value);
	assert.equal(result.length, value.length - (padding ? 2 : 0));
	t.mock.restoreAll(); assert.equal(materializeJsonStringTree(result), value.materialize().trim());
});

it('compact trim matches native trim for single-page boundaries, all-whitespace and random partitions', () => {
	for (const text of [' \ufeff'.repeat(8192), ' '.repeat(8192) + '�' + '\ufeff'.repeat(8192), ' �'.repeat(8192), '\ud800' + '�'.repeat(8192) + '\udc00', '�'.repeat(8192) + ' ']) {
		for (const width of [1023, 1024, 8191, 8192, 65536]) {
			const parts = Array.from({ length: Math.ceil(text.length / width) }, (_, i) => text.slice(i * width, (i + 1) * width));
			assert.equal(materializeJsonStringTree(trimJsonString(new JsonStringPages(parts.map(CompactJsonStringPage.from)))), text.trim());
		}
	}
});

it('paged parser compacts completed pages before EOF and releases its reader on cancellation', async t => {
	const original = CompactJsonStringPage.from; let storedBytes = 0;
	t.mock.method(CompactJsonStringPage, 'from', (text: string) => {
		const page = original(text); if (page instanceof CompactJsonStringPage) storedBytes += page.byteLength; return page;
	});
	let input!: ReadableStreamDefaultController<Uint8Array>;
	const client = new AbortController(), stream = new ReadableStream<Uint8Array>({ start(c) { input = c; } });
	const pending = segmentedJsonResponseWithinLimit(new Response(stream), 1000000, limits, client.signal, { retainStringPages: true });
	input.enqueue(encode('{"image":"' + '�'.repeat(70000)));
	for (let i = 0; i < 20 && !storedBytes; i++) await Promise.resolve();
	assert.ok(storedBytes >= 8192, 'must compact while the token is incomplete, not after full retention');
	client.abort(new Error('synthetic stop')); await assert.rejects(pending, /synthetic stop/); assert.equal(stream.locked, false);
});

for (const option of ['uncompressedStringFields', 'nativeStringFields'] as const) {
	it(`parser storage selection exempts keys and entire ${option} root subtrees, not similarly named nested fields`, async t => {
		const key = '\ufffc'.repeat(20000), protectedValue = '\ufffb'.repeat(20000), compactable = '�'.repeat(20000);
		const raw = `{"${key}":0,"us\\u0061ge":{"nested":[{"x":${JSON.stringify(protectedValue)}}]},"opaque":{"usage":${JSON.stringify(compactable)}},"usageX":${JSON.stringify(compactable)}}`;
		const from = CompactJsonStringPage.from; let packed = 0;
		t.mock.method(CompactJsonStringPage, 'from', (text: string) => {
			assert.ok(!text.includes('\ufffc') && !text.includes('\ufffb'), 'native boundaries never own packed bytes');
			const page = from(text); if (page instanceof CompactJsonStringPage) packed++; return page;
		});
		const result = await segmentedJsonResponseWithinLimit(source(encode(raw), 8191), 1000000, limits, undefined,
			{ retainStringPages: true, [option]: ['usage'] });
		assert.equal(result.jsonValid, true); assert.ok(packed > 0);
		assert.deepEqual(materializeJsonStringTree(result.body), JSON.parse(raw));
		const usage = (result.body as { usage: { nested: Array<{ x: unknown }> } }).usage;
		assert.equal(usage.nested[0]!.x instanceof JsonStringPages, option === 'uncompressedStringFields');
	});
}

it('a paged root field name can select uncompressed storage without whole-name pre-EOF materialization', async t => {
	const key = 'key'.repeat(3000), value = '�'.repeat(20000), raw = JSON.stringify({ [key]: { value } });
	const from = CompactJsonStringPage.from;
	t.mock.method(CompactJsonStringPage, 'from', (text: string) => { assert.ok(!text.includes('�')); return from(text); });
	const result = await segmentedJsonResponseWithinLimit(source(encode(raw), 8191), 1000000, limits, undefined,
		{ retainStringPages: true, uncompressedStringFields: [key] });
	assert.equal(result.jsonValid, true); assert.deepEqual(materializeJsonStringTree(result.body), JSON.parse(raw));
});

it('compact storage selection does not admit malformed tails, separators or object/array transitions', async () => {
	const text = JSON.stringify('�'.repeat(20000));
	for (const raw of [`{"x":${text},}`, `{"usage":${text} "x":0}`, `[${text},]`, `{"x":[${text}}`, `{"x":${text}}{}`, `{"x":${text.slice(0, -1)}`]) {
		assert.throws(() => JSON.parse(raw), SyntaxError);
		const result = await segmentedJsonResponseWithinLimit(source(encode(raw), 8191), 1000000, limits, undefined,
			{ retainStringPages: true, uncompressedStringFields: ['usage'] });
		assert.equal(result.jsonValid, false);
	}
});

for (const width of [1, 7, 8191, 65536, 65537]) it(`paged parser/native JSON differential with keys, duplicates, opaque arrays and Unicode, width ${width}`, async () => {
	const large = 'A'.repeat(65535) + '💡Ā\ud800\n"\\' + '图'.repeat(9000), key = 'k'.repeat(65537);
	const raw = '{"' + key + '":' + JSON.stringify(large) + ',"data":[' + JSON.stringify(large) + '],"usage":' + JSON.stringify(large)
		+ ',"__proto__":{"same":' + JSON.stringify(large) + ',"same":"last"},"2":true,"1":-0,"toJSON":"data"}';
	const body = await parse(encode(raw), width), expected: unknown = JSON.parse(raw);
	assert.deepEqual(materializeJsonStringTree(body), expected);
	assert.equal(await streamed(body), JSON.stringify(expected));
	assert.equal(countValidImageResults(body), 0);
	assert.equal(await streamed(normalizeOpenRouterImageResponse(body)), JSON.stringify(expected), 'large string data/usage are not mistaken for records');
});

for (const boundary of [8191, 8192, 65535, 65536, 65537]) for (const suffix of ['💡', '\ud800X\udc00', '\n"\\\u0000']) {
	it(`paged escaping matches native JSON across boundary ${boundary}, suffix ${JSON.stringify(suffix)}`, async t => {
		const value = 'A'.repeat(boundary) + suffix + 'B'.repeat(65537), expected = JSON.stringify(value);
		const body = await parse(encode(expected)); assert.ok(body instanceof JsonStringPages);
		let maxScalar = 0; const stringify = JSON.stringify;
		t.mock.method(JSON, 'stringify', ((value: unknown) => {
			if (typeof value === 'string') maxScalar = Math.max(maxScalar, value.length);
			return stringify(value);
		}) as typeof JSON.stringify);
		assert.equal(await streamed(body), expected); assert.ok(maxScalar <= JSON_STRING_PIECE_CHARS);
	});
}

for (const width of [1, 8191, 65536]) it(`paged replacement UTF-8 content and split BOM preserve native decoded semantics, width ${width}`, async () => {
	const prefix = encode('\ufeff{"opaque":"'), suffix = encode('"}');
	const raw = new Uint8Array(prefix.length + 70000 + suffix.length); raw.fill(255); raw.set(prefix); raw.set(suffix, raw.length - suffix.length);
	const body = await parse(raw, width), expected: unknown = JSON.parse(new TextDecoder().decode(raw));
	assert.deepEqual(materializeJsonStringTree(body), expected); assert.equal(await streamed(body), JSON.stringify(expected));
});

for (const mime of [undefined, '', ' '.repeat(70000), 'image/custom' + ' '.repeat(70000)]) {
	it(`paged image metadata/count keep native string behavior, explicit MIME length ${mime?.length}`, async () => {
		const value = '\ufeff'.repeat(70000) + 'iVBORw0KGgo=' + ' '.repeat(70000);
		const plain = { data: [{ b64_json: value, ...(mime === undefined ? {} : { media_type: mime }) }, { url: ' '.repeat(70000) + 'https://synthetic.invalid' }, { b64_json: ' '.repeat(70000) }] };
		const body = await parse(encode(JSON.stringify(plain)));
		assert.equal(countValidImageResults(body), 2);
		assert.equal(await streamed(normalizeOpenRouterImageResponse(body)), JSON.stringify(normalizeOpenRouterImageResponse(plain)));
	});
}

it('paged signature scanning preserves split data URLs and whitespace-only semantics', async () => {
	const data = new JsonStringPages([' '.repeat(65530) + 'DATA:I', 'MAGE/PNG;base64,AQID']);
	assert.equal(hasJsonStringContent(data), true); assert.equal(hasJsonStringContent(pages(' \t\n\ufeff'.repeat(20000))), false);
	const normalized = await streamed(normalizeOpenRouterImageResponse({ data: [{ b64_json: data }] }));
	assert.equal(JSON.parse(normalized).data[0].media_type, 'image/png');
});

const route: RouteResult = {
	targetId: 'target', modelSurfaceId: null, routePoolId: null, providerId: 'provider', providerName: 'Synthetic', providerModelName: 'synthetic-image',
	upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://synthetic.invalid/v1' } }, providerApiKey: 'synthetic', providerSharedChannelType: null,
	priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
};
for (const operation of ['generations', 'edits'] as const) it(`${operation}: compact image/metadata and admitted usage pages preserve exact delivery`, async t => {
	const payload = '�'.repeat(70000), usageText = '\ufffb'.repeat(10000);
	const plain = { data: [{ b64_json: payload }], metadata: payload, usage: { input_tokens: 3, output_tokens: 7, total_tokens: 10, nested: { value: usageText } } };
	const from = CompactJsonStringPage.from; let packed = 0, usagePageVisited = false;
	t.mock.method(CompactJsonStringPage, 'from', (text: string) => {
		if (text.includes('\ufffb')) usagePageVisited = true;
		const page = from(text); if (page instanceof CompactJsonStringPage) packed++; return page;
	});
	t.mock.method(console, 'log', () => {});
	t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
	const options = { requireAuthoritativeUsage: true, fetchImpl: async () => source(encode(JSON.stringify(plain)), 8191) };
	const result = operation === 'generations'
		? await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 1 }, undefined, undefined, undefined, options)
		: await dispatchOpenAiImageEdits({ ...route, upstreamOperation: 'images.edits' }, { prompt: 'synthetic', n: 1, images: [] }, undefined, undefined, undefined, options);
	assert.ok(packed > 0); assert.ok(usagePageVisited); assert.equal(result.response.status, 200);
	assert.equal(result.meta.imageUsage?.text_tokens, 3); assert.equal(result.meta.imageUsage?.image_output_tokens, 7);
	assert.equal((JSON.parse((await result.usagePromise).raw_usage!) as typeof plain.usage).nested.value, usageText);
	assert.equal(await result.response.text(), JSON.stringify(normalizeOpenRouterImageResponse(plain)));
});
for (const operation of ['generations', 'edits'] as const) it(`${operation}: driver keeps paged payload but explicitly preserves raw usage and numeric-string billing`, async t => {
	const payload = 'A'.repeat(1024 * 1024) + 'Ā', opaque = '图'.repeat(9000);
	const usage = { input_tokens: ' '.repeat(10000) + '3', output_tokens: 7, total_tokens: 10, opaque, nested: { '__proto__': null, value: opaque } };
	const plain = { data: [{ b64_json: payload }], opaque, usage };
	const expected = normalizeOpenRouterImageResponse(plain), raw = encode(JSON.stringify(plain));
	const materialize = JsonStringPages.prototype.materialize, lengths: number[] = [];
	t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) { lengths.push(this.length); return materialize.call(this); });
	t.mock.method(console, 'log', () => {}); t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
	let dispatches = 0;
	const options = { requireAuthoritativeUsage: true, fetchImpl: async () => { dispatches++; return source(raw, 65536); } };
	const result = operation === 'generations'
		? await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 1 }, undefined, undefined, undefined, options)
		: await dispatchOpenAiImageEdits({ ...route, upstreamOperation: 'images.edits' }, { prompt: 'synthetic', n: 1, images: [] }, undefined, undefined, undefined, options);
	assert.equal(result.response.status, 200); assert.equal(dispatches, 1); assert.equal(countValidImageResults(result.meta.parsedBody), 1);
	assert.equal(result.meta.imageUsage?.text_tokens, 3); assert.equal(result.meta.imageUsage?.image_output_tokens, 7);
	assert.ok(expected && typeof expected === 'object' && 'usage' in expected);
	assert.equal(result.meta.imageUsage?.raw_usage, JSON.stringify(expected.usage));
	assert.equal((await result.usagePromise).raw_usage, result.meta.imageUsage?.raw_usage);
	assert.equal(await result.response.text(), JSON.stringify(expected));
	assert.deepEqual(lengths, [1], 'only the trimmed, bounded numeric value is materialized; audit and payload strings stay paged');
});

for (const position of ['unread', 'one-page'] as const) for (const stop of ['cancel', 'abort', 'deadline'] as const) {
	it(`paged encoder releases lifecycle at ${position}/${stop}`, async () => {
		const client = new AbortController(); let finished = 0, expired = false;
		const value = await parse(encode(JSON.stringify({ data: [ 'A'.repeat(200000) + '💡' ] })));
		const response = streamJsonResponse(value, limits, {}, { signal: client.signal, onFinished: () => { finished++; },
			checkActive: () => { if (expired) throw new Error('synthetic deadline'); } });
		const reader = response.body!.getReader();
		if (position === 'one-page') assert.equal((await reader.read()).done, false);
		if (stop === 'cancel') await reader.cancel();
		else { if (stop === 'abort') client.abort('PRIVATE_DETAIL'); else expired = true;
			await assert.rejects(reader.read(), error => error instanceof Error && error.message === 'JSON response delivery was interrupted'); }
		reader.releaseLock(); assert.equal(finished, 1); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
	});
}
