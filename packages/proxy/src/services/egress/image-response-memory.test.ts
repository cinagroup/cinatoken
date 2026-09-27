import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { RouteResult } from '../model-router';
import { responseTextWithinLimit, UpstreamResponseBodyTooLargeError } from './bounded-response-body';
import { countValidImageResults, dispatchOpenAiImageGenerations, IMAGE_MAX_RESPONSE_BYTES, normalizeOpenRouterImageResponse } from './openai-images-driver';
import { JSON_OUTPUT_PAGE_BYTES, JSON_STRING_PIECE_CHARS } from './stream-json-body';
import { IMAGE_JSON_STRUCTURE_LIMITS, JsonStructureBudget } from '../json-structure-budget';

const encode = (value: string) => new TextEncoder().encode(value);
function response(bytes: Uint8Array, width: number, headers?: HeadersInit) {
	let offset = 0;
	return new Response(new ReadableStream<Uint8Array>({ pull(c) {
		if (offset === bytes.length) c.close(); else { const end = Math.min(offset + width, bytes.length); c.enqueue(bytes.subarray(offset, end)); offset = end; }
	} }, { highWaterMark: 0 }), { headers });
}
const samples = [encode('\ufeff{"text":"图💡\\n"}\ufeff'), new Uint8Array([0xef, 0xbb, 0xbf, 0xc0, 0xaf, 0xed, 0xa0, 0x80, 0xe2, 0x82]), new Uint8Array()];
for (const [index, bytes] of samples.entries()) for (const width of [1, 2, 3, 7, 65536]) {
	it(`bounded incremental UTF-8 matches one-shot decoder: sample ${index}, width ${width}`, async () => {
		assert.equal(await responseTextWithinLimit(response(bytes, width), bytes.length), new TextDecoder().decode(bytes));
	});
}
it('bounded response decodes borrowed chunks before a transport reuses its buffer', async () => {
	const scratch = new Uint8Array(1); let index = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (index === 6) c.close(); else { scratch[0] = 65 + index++; c.enqueue(scratch); }
	} }, { highWaterMark: 0 });
	assert.equal(await responseTextWithinLimit(new Response(source), 6), 'ABCDEF');
	assert.equal(source.locked, false);
});
it('full 32 MiB response retains the hard capacity without a whole-body binary decode', async t => {
	const chunk = new Uint8Array(65536).fill(65); let remaining = IMAGE_MAX_RESPONSE_BYTES, decoded = 0;
	const originalDecode = TextDecoder.prototype.decode;
	t.mock.method(TextDecoder.prototype, 'decode', function(this: TextDecoder, ...[input, options]: Parameters<TextDecoder['decode']>) {
		if (input) { assert.ok(input.byteLength <= chunk.length); assert.equal(options?.stream, true); decoded += input.byteLength; }
		return originalDecode.call(this, input, options);
	});
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (!remaining) c.close(); else { remaining -= chunk.length; c.enqueue(chunk); }
	} }, { highWaterMark: 0 });
	const text = await responseTextWithinLimit(new Response(source), IMAGE_MAX_RESPONSE_BYTES);
	assert.equal(text.length, IMAGE_MAX_RESPONSE_BYTES); assert.equal(decoded, IMAGE_MAX_RESPONSE_BYTES);
	assert.equal(text[0], 'A'); assert.equal(text.at(-1), 'A'); assert.equal(source.locked, false);
});
for (const declared of [false, true]) it(`byte ceiling is checked before decoding excess input, declared=${declared}`, async t => {
	let cancels = 0, pulls = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(encode('💡')); }, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	const decoder = t.mock.method(TextDecoder.prototype, 'decode');
	await assert.rejects(responseTextWithinLimit(new Response(source, { headers: declared ? { 'Content-Length': '4' } : {} }), 3), UpstreamResponseBodyTooLargeError);
	assert.equal(cancels, 1); assert.equal(pulls, declared ? 0 : 1); assert.equal(decoder.mock.callCount(), 0); assert.equal(source.locked, false);
});
for (const phase of ['before', 'pending', 'after-chunk'] as const) it(`bounded response ${phase} cancellation does not wait for transport ACK`, async () => {
	const client = new AbortController(); let reading = false, cancels = 0;
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		reading = true;
		if (phase === 'after-chunk') { c.enqueue(encode('partial')); client.abort(new Error('synthetic stop')); }
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	if (phase === 'before') client.abort(new Error('synthetic stop'));
	const pending = assert.rejects(responseTextWithinLimit(new Response(source), 1024, client.signal), /synthetic stop/);
	if (phase === 'pending') { for (let i = 0; i < 100 && !reading; i++) await nextTurn(); assert.ok(reading); client.abort(new Error('synthetic stop')); }
	await pending; assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});

function media(value: string, existing?: string) {
	const input = { data: [{ b64_json: value, ...(existing ? { media_type: existing } : {}) }] };
	const result = normalizeOpenRouterImageResponse(input);
	assert.ok(result && typeof result === 'object' && 'data' in result && Array.isArray(result.data));
	const row: unknown = result.data[0]; assert.ok(row && typeof row === 'object' && 'b64_json' in row);
	assert.equal(row.b64_json, value); assert.equal(countValidImageResults(result), /\S/.test(value) ? 1 : 0);
	return 'media_type' in row ? row.media_type : undefined;
}
for (const [bytes, expected] of [
	[[137, 80, 78, 71, 13, 10, 26, 10], 'image/png'], [[255, 216, 255], 'image/jpeg'],
	[[82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], 'image/webp'],
] as const) it(`bounded media signature keeps ${expected}`, () => {
	const value = btoa(String.fromCharCode(...bytes)); assert.equal(media(' \n' + value.split('').join('\t') + ' \r'), expected);
});
it('bounded media signature keeps SVG and a normal case-insensitive data URL', () => {
	assert.equal(media(btoa('<?xml version="1.0"?><svg />')), 'image/svg+xml');
	assert.equal(media('\ufeff DATA:IMAGE/PNG;base64,AQID'), 'image/png');
});
it('large whitespace/base64 is inspected without full trim/replace copies', t => {
	const value = ' '.repeat(65536) + 'iVBORw0KGgo=' + ' '.repeat(1024 * 1024);
	const replace = t.mock.method(String.prototype, 'replace'), trim = t.mock.method(String.prototype, 'trim');
	assert.equal(media(value), 'image/png');
	assert.ok(replace.mock.calls.every(call => String(call.this).length <= 1024));
	assert.ok(trim.mock.calls.every(call => String(call.this).length <= 1024));
});
it('oversized data URL hint is not duplicated; explicit metadata and opaque payload are preserved', () => {
	const value = 'data:image/' + 'a'.repeat(4096) + ';base64,AQID';
	assert.equal(media(value), undefined); assert.equal(media(value, 'image/custom'), 'image/custom');
	assert.equal(media('\t\n\ufeff'), undefined);
});

const route: RouteResult = {
	targetId: 'target', modelSurfaceId: null, routePoolId: null, providerId: 'provider', providerName: 'Synthetic', providerModelName: 'synthetic-image',
	upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://synthetic.invalid/v1' } }, providerApiKey: 'synthetic', providerSharedChannelType: null,
	priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
};
it('generation keeps exact 32 MiB JSON response capacity without whole-payload serialization', async t => {
	const prefix = '{"data":[{"b64_json":"', suffix = '"}]}';
	const payloadSize = IMAGE_MAX_RESPONSE_BYTES - prefix.length - suffix.length;
	const value = 'A'.repeat(payloadSize), raw = prefix + value + suffix;
	const stringify = t.mock.method(JSON, 'stringify');
	t.mock.method(console, 'log', () => {});
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 1 }, undefined, undefined, undefined, {
		fetchImpl: async () => response(encode(raw), 65536),
	});
	assert.equal(result.response.status, 200); assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
	const calls = stringify.mock.calls.filter(call => call.arguments[0]?.data?.[0]?.b64_json === value);
	assert.equal(calls.length, 0);
	let bytes = 0; const reader = result.response.body!.getReader();
	while (true) { const next = await reader.read(); if (next.done) break; assert.ok(next.value.length <= JSON_OUTPUT_PAGE_BYTES); bytes += next.value.length; }
	reader.releaseLock(); assert.equal(bytes, IMAGE_MAX_RESPONSE_BYTES);
	assert.equal(stringify.mock.calls.filter(call => call.arguments[0]?.data?.[0]?.b64_json === value).length, 0);
	assert.ok(stringify.mock.calls.every(call => typeof call.arguments[0] !== 'string' || call.arguments[0].length <= JSON_STRING_PIECE_CHARS));
});
it('missing authoritative usage does not serialize a large image before discarding it', async t => {
	const value = 'A'.repeat(1024 * 1024), raw = JSON.stringify({ data: [{ b64_json: value }] });
	const stringify = t.mock.method(JSON, 'stringify'); t.mock.method(console, 'log', () => {});
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 2 }, undefined, undefined, undefined, {
		requireAuthoritativeUsage: true, fetchImpl: async () => new Response(raw),
	});
	assert.equal(result.response.status, 502); assert.equal(result.meta.failoverForbidden, true);
	assert.equal(stringify.mock.calls.filter(call => call.arguments[0]?.data?.[0]?.b64_json === value).length, 0);
	assert.match(await result.response.text(), /without authoritative usage/);
});

it('normalization may expand an admitted node budget without rejecting valid image metadata', async t => {
	// Root + data key/array + 3 nodes per image = exactly 65,535 wire nodes.
	const count = (IMAGE_JSON_STRUCTURE_LIMITS.maxNodes - 4) / 3;
	assert.equal(Number.isInteger(count), true);
	const raw = '{"data":[' + Array.from({ length: count }, () => '{"b64_json":"iVBORw0KGgo="}').join(',') + ']}';
	const budget = new JsonStructureBudget(IMAGE_JSON_STRUCTURE_LIMITS); budget.write(raw);
	assert.equal(budget.nodeCount, IMAGE_JSON_STRUCTURE_LIMITS.maxNodes - 1);
	t.mock.method(console, 'log', () => {});
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic' }, undefined, undefined, undefined, {
		fetchImpl: async () => new Response(raw),
	});
	assert.equal(result.response.status, 200);
	const body = await result.response.json() as { data: Array<{ b64_json: string; media_type: string }> };
	assert.equal(body.data.length, count); assert.ok(body.data.every(row => row.media_type === 'image/png'));
});
