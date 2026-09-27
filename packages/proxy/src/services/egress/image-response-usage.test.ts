import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it } from 'node:test';
import { parseOpenAiImageUsage } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { IMAGE_MAX_USAGE_JSON_BYTES, ImageUsageLimitError, parseImageUsageFromAnyShape } from './image-response-usage';
import { JsonStringPages } from './json-string-pages';
import { dispatchOpenAiImageEdits, dispatchOpenAiImageGenerations, normalizeOpenRouterImageResponse } from './openai-images-driver';

const paged = (text: string) => new JsonStringPages(Array.from({ length: Math.ceil(text.length / 8192) }, (_, i) => text.slice(i * 8192, (i + 1) * 8192)));
function pageTree(value: unknown): unknown {
	if (typeof value === 'string') return paged(value);
	if (Array.isArray(value)) return value.map(pageTree);
	if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, pageTree(child)]));
	return value;
}
// Independent pre-change contract: alias the native usage object, then ask Core.
function original(u: Record<string, unknown>) {
	return parseOpenAiImageUsage({ usage: { ...u, input_tokens: u.input_tokens ?? u.prompt_tokens, output_tokens: u.output_tokens ?? u.completion_tokens } });
}
function compare(u: Record<string, unknown>) {
	const expected = original(u);
	assert.deepEqual(parseImageUsageFromAnyShape({ usage: u }), expected);
	assert.deepEqual(parseImageUsageFromAnyShape({ usage: pageTree(u) }), expected);
}

it('usage shape validation does not mistake a paged scalar for a record', () => {
	for (const body of [null, [], 'text', paged('text'), {}, { usage: null }, { usage: [] }, { usage: 'text' }, { usage: paged('text') }]) {
		assert.equal(parseImageUsageFromAnyShape(body), null);
	}
});

it('counter projection preserves floor, aliases, nullish cache precedence, detail presence and zero-usage behavior', () => {
	const fields: unknown[] = [undefined, null, false, true, [], {}, 0, -0, -1, 3.9, 1e300, Infinity, NaN, '', ' ', '-0', '+03.9', '0xff', 'Infinity', 'no', '0'.repeat(1200) + '3'];
	for (const value of fields) for (const details of [undefined, null, [], 'text', {},
		{ text_tokens: value, image_tokens: value, cached_text_tokens: value, cache_tokens: '5', cached_image_tokens: value }]) {
		// Omit undefined like a parsed JSON object; it is not a supported wire value.
		const u: Record<string, unknown> = { prompt_tokens: '7', completion_tokens: '11' };
		if (value !== undefined) { u.input_tokens = value; u.output_tokens = value; u.total_tokens = value; }
		if (details !== undefined) u.input_tokens_details = JSON.parse(JSON.stringify(details));
		compare(u);
		if (details !== undefined) u.output_tokens_details = JSON.parse(JSON.stringify(details));
		compare(u);
	}
	compare({ input_tokens: null, output_tokens: null });
	compare({ input_tokens_details: { cache_tokens: 5 } });
	compare({ input_tokens_details: {}, output_tokens_details: {}, input_tokens: 7, output_tokens: 11 });
});

it('raw usage preserves aliases, special key order and all opaque nested data without full scalar copies', t => {
	const long = '图\ufffd\n"\\\u0000\ud800💡'.repeat(300);
	const u: Record<string, unknown> = JSON.parse('{"input_tokens":null,"9":9,"2":2,"__proto__":{"data":1},"toJSON":"data","prompt_tokens":3,"output_tokens":null,"completion_tokens":7}');
	u['key'.repeat(50)] = [{ long }, long];
	u.input_tokens_details = { text_tokens: '0'.repeat(4000) + '3', image_tokens: '0x' + '0'.repeat(4000) + 'ff' };
	const expected = original(u), value = pageTree(u);
	t.mock.method(JsonStringPages.prototype, 'materialize', function(this: JsonStringPages) {
		assert.ok(this.length <= 1024); return [...this.chunks()].join('');
	});
	const before = JSON.stringify(u);
	assert.deepEqual(parseImageUsageFromAnyShape({ usage: value }), expected);
	assert.equal(JSON.stringify(u), before);
});

it('usage projection matches Core for 500 seeded combinations of JSON fields and unknown audit data', () => {
	let seed = 0x912875;
	const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
	const values: unknown[] = [null, false, 0, -0, -4, 8.75, ' ', '+12', '0x10', '.5e2', 'bad', {}, [], '0'.repeat(1100) + '7'];
	const fields = ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens', 'input_tokens_details', 'output_tokens_details', '__proto__', 'opaque', 'toJSON'];
	const counters = ['text_tokens', 'image_tokens', 'cached_text_tokens', 'cache_tokens', 'cached_image_tokens'];
	for (let run = 0; run < 500; run++) {
		const u: Record<string, unknown> = {};
		for (const field of fields) {
			if (next() % 4 === 0) continue;
			const value = field.endsWith('_details') && next() % 2 ? Object.fromEntries(counters.map(key => [key, values[next() % values.length]])) : values[next() % values.length];
			Object.defineProperty(u, field, { value, enumerable: true });
		}
		compare(u);
	}
});

it('usage cancellation during admission, numeric scanning or audit serialization is never converted into zero usage', () => {
	for (const u of [{ input_tokens: paged('0'.repeat(20000) + '3') }, { input_tokens: 3, opaque: paged('A'.repeat(20000)) }]) {
		let checks = 0; const reason = new Error('Synthetic deadline');
		assert.throws(() => parseImageUsageFromAnyShape({ usage: u }, () => { if (++checks === 15) throw reason; }), error => error === reason);
		assert.equal(checks, 15);
	}
});

const route: RouteResult = {
	targetId: 'target', modelSurfaceId: null, routePoolId: null, providerId: 'provider', providerName: 'Synthetic', providerModelName: 'synthetic-image',
	upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://synthetic.invalid/v1' } }, providerApiKey: 'synthetic', providerSharedChannelType: null,
	priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams: null, routeGroup: 'default', routePriority: 1, routeWeight: 1,
};

for (const shape of ['ascii', 'unicode', 'escaped', 'aliases'] as const) for (const asPages of [false, true]) {
	it(`usage ${shape}, paged=${asPages}: complete normalized audit admits 64 KiB and rejects the next byte`, t => {
		const special = shape === 'unicode' ? '图💡�' : shape === 'escaped' ? '\u0000\ud800\n"\\' : '';
		const base: Record<string, unknown> = shape === 'aliases' ? { prompt_tokens: 3, completion_tokens: 7, opaque: special }
			: { input_tokens: 3, output_tokens: 7, opaque: special };
		const overhead = Buffer.byteLength(original(base)!.raw_usage!);
		t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Audit must serialize pages directly'); });
		for (const extra of [0, 1]) {
			const u = { ...base, opaque: special + 'A'.repeat(IMAGE_MAX_USAGE_JSON_BYTES - overhead + extra) };
			const expected = original(u)!; assert.equal(Buffer.byteLength(expected.raw_usage!), IMAGE_MAX_USAGE_JSON_BYTES + extra);
			const parse = () => parseImageUsageFromAnyShape({ usage: asPages ? pageTree(u) : u });
			if (extra) assert.throws(parse, ImageUsageLimitError); else assert.deepEqual(parse(), expected);
		}
	});
}

it('an oversized zero-counter audit is rejected, not reclassified as missing usage', () => {
	assert.throws(() => parseImageUsageFromAnyShape({ usage: { input_tokens: 0, opaque: paged('A'.repeat(65536)) } }), ImageUsageLimitError);
});

for (const operation of ['generations', 'edits'] as const) for (const overflow of ['key', 'usage'] as const) for (const upstreamStatus of [200, 401]) {
	it(`${operation}: ${overflow} overflow after ${upstreamStatus} preserves unknown/known rejection metadata`, async t => {
		t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
		const client = new AbortController(); let sends = 0, cancels = 0, pulls = 0;
		const raw = JSON.stringify({ data: [{ b64_json: 'PRIVATE_IMAGE' }], usage: { input_tokens: 3, output_tokens: 7,
			...(overflow === 'usage' ? { opaque: 'A'.repeat(65536) } : {}) }, ...(overflow === 'key' ? { ['SECRET_PROPERTY'.repeat(20)]: 0 } : {}) });
		const source = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls === 1) c.enqueue(new TextEncoder().encode(raw)); else c.close(); },
			cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
		const options = { fetchImpl: async () => { sends++; return new Response(source, { status: upstreamStatus, headers: { 'x-request-id': 'synthetic-evidence-id' } }); } };
		const result = operation === 'generations'
			? await dispatchOpenAiImageGenerations(route, { prompt: 'test' }, client.signal, undefined, undefined, options)
			: await dispatchOpenAiImageEdits({ ...route, upstreamOperation: 'images.edits' }, { prompt: 'test', n: 1, images: [] }, client.signal, undefined, undefined, options);
		assert.equal(sends, 1); assert.equal(result.response.status, upstreamStatus === 200 ? 502 : 401);
		assert.equal(result.meta.upstreamOutcomeUnknown, upstreamStatus === 200 ? true : undefined);
		assert.equal(result.meta.failoverForbidden, upstreamStatus === 200 ? true : undefined);
		assert.equal(result.upstreamRequestId, 'synthetic-evidence-id'); assert.equal(result.meta.imageUsage, null);
		assert.equal((await result.usagePromise).raw_usage, null);
		const text = await result.response.text(); assert.match(text, overflow === 'key' ? /property name characters/ : /65536 UTF-8 bytes/);
		assert.doesNotMatch(text, /PRIVATE_IMAGE|SECRET_PROPERTY/);
		assert.equal(cancels, overflow === 'key' ? 1 : 0); assert.equal(source.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
	});
}

for (const overflow of ['key', 'usage'] as const) it(`SSE ${overflow} overflow has one error/DONE, settles unknown and never delivers the completed image`, async t => {
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
	const client = new AbortController(); let sends = 0, pulls = 0, cancels = 0;
	const raw = JSON.stringify({ type: 'image_generation.completed', b64_json: 'PRIVATE_IMAGE',
		usage: { input_tokens: 3, output_tokens: 7, ...(overflow === 'usage' ? { opaque: 'A'.repeat(65536) } : {}) },
		...(overflow === 'key' ? { ['SECRET_PROPERTY'.repeat(20)]: 0 } : {}) });
	const source = new ReadableStream<Uint8Array>({ pull(c) {
		if (++pulls === 1) c.enqueue(new TextEncoder().encode('data: ' + raw + '\n\n'));
		else throw new Error('Must not read another event');
	}, cancel() { cancels++; return new Promise<void>(() => {}); } }, { highWaterMark: 0 });
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'test', stream: true }, client.signal, undefined, undefined,
		{ fetchImpl: async () => { sends++; return new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }); } });
	const text = await result.response.text(), settlement = await result.meta.imageStreamSettlement!;
	assert.equal(result.response.status, 200); assert.equal((text.match(/"type":"error"/g) ?? []).length, 1); assert.equal((text.match(/\[DONE\]/g) ?? []).length, 1);
	assert.doesNotMatch(text, /PRIVATE_IMAGE|SECRET_PROPERTY|image_generation.completed/);
	assert.equal(settlement.completed, false); assert.equal(settlement.upstreamOutcomeUnknown, true); assert.equal(settlement.imageUsage, null);
	assert.equal(settlement.validImages, 0); assert.equal(result.meta.failoverForbidden, true); assert.ok((await result.usagePromise).stream_error);
	assert.equal(sends, 1); assert.equal(pulls, 1); assert.equal(cancels, 1); assert.equal(source.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
});

for (const operation of ['generations', 'edits'] as const) for (const phase of ['numeric', 'audit', 'final-join']) for (const stop of ['abort', 'deadline']) {
	it(`${operation}: ${stop} during ${phase} keeps an unknown 2xx non-replayable and releases ownership`, async t => {
		t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
		t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
		t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network'); });
		const client = new AbortController(); let stopped = false, dispatches = 0;
		const stopNow = () => { if (stopped) return; stopped = true; if (stop === 'abort') client.abort('PRIVATE_DETAIL'); else t.mock.timers.setTime(1000); };
		const usage = phase === 'numeric' ? { input_tokens: '0'.repeat(20000) + '3', output_tokens: 7 }
			: { input_tokens: 3, output_tokens: 7, opaque: 'A'.repeat(20000) };
		const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ b64_json: 'AQID' }], usage }));
		let offset = 0;
		const source = new ReadableStream<Uint8Array>({ pull(c) {
			if (offset === bytes.length) c.close(); else { const end = Math.min(bytes.length, offset + 8191); c.enqueue(bytes.subarray(offset, end)); offset = end; }
		} }, { highWaterMark: 0 });
		const chunks = JsonStringPages.prototype.chunks, join = Array.prototype.join;
		if (phase !== 'final-join') t.mock.method(JsonStringPages.prototype, 'chunks', function*(this: JsonStringPages) {
			for (const chunk of chunks.call(this)) { yield chunk; if (this.length >= 20000) stopNow(); }
		});
		try {
			if (phase === 'final-join') Array.prototype.join = function(this: unknown[], separator?: string) {
				const result = join.call(this, separator); if (result.length >= 20000) stopNow(); return result;
			};
			const options = { deadlineAtMs: 1000, requireAuthoritativeUsage: true, fetchImpl: async () => { dispatches++; return new Response(source); } };
			const result = operation === 'generations'
				? await dispatchOpenAiImageGenerations(route, { prompt: 'synthetic', n: 1 }, client.signal, undefined, undefined, options)
				: await dispatchOpenAiImageEdits({ ...route, upstreamOperation: 'images.edits' }, { prompt: 'synthetic', n: 1, images: [] }, client.signal, undefined, undefined, options);
			assert.ok(stopped); assert.equal(dispatches, 1); assert.equal(offset, bytes.length);
			assert.equal(result.response.status, stop === 'abort' ? 499 : 504);
			assert.equal(result.meta.failoverForbidden, true); assert.equal(result.meta.upstreamOutcomeUnknown, true);
			assert.equal(result.meta.imageUsage, null); assert.equal((await result.usagePromise).raw_usage, null);
			assert.ok(!(await result.response.text()).includes('PRIVATE_DETAIL'));
			assert.equal(source.locked, false); assert.equal(getEventListeners(client.signal, 'abort').length, 0);
		} finally { Array.prototype.join = join; }
	});
}

for (const extra of [0, 1]) it(`driver usage cap includes response-normalization aliases, extra=${extra}`, async t => {
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
	const initial = { data: [{ b64_json: 'AQID' }], usage: { input_tokens: 3, output_tokens: 7, opaque: '图💡�' } };
	const normalized = normalizeOpenRouterImageResponse(initial) as { usage: Record<string, unknown> };
	const overhead = Buffer.byteLength(original(normalized.usage)!.raw_usage!);
	initial.usage.opaque += 'A'.repeat(IMAGE_MAX_USAGE_JSON_BYTES - overhead + extra);
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'test' }, undefined, undefined, undefined, { fetchImpl: async () => Response.json(initial) });
	assert.equal(result.response.status, extra ? 502 : 200);
	if (!extra) {
		assert.equal(Buffer.byteLength((await result.usagePromise).raw_usage!), IMAGE_MAX_USAGE_JSON_BYTES);
		assert.deepEqual(await result.response.json(), normalizeOpenRouterImageResponse(initial));
	} else { assert.equal(result.meta.upstreamOutcomeUnknown, true); await result.response.text(); }
});

it('audit cap measures the final duplicate value, not source whitespace or discarded usage', async t => {
	t.mock.method(console, 'log', () => {}); t.mock.method(console, 'error', () => {});
	const raw = '{"usage":{"opaque":"' + 'A'.repeat(100000) + '"},"usage":' + ' '.repeat(100000)
		+ '{"input_tokens":3,"output_tokens":7},"data":[{"b64_json":"AQID"}]}';
	const result = await dispatchOpenAiImageGenerations(route, { prompt: 'test' }, undefined, undefined, undefined, { fetchImpl: async () => new Response(raw) });
	assert.equal(result.response.status, 200); const usage = (await result.usagePromise).raw_usage!;
	assert.ok(Buffer.byteLength(usage) < 256); assert.ok(!usage.includes('opaque')); await result.response.text();
});
