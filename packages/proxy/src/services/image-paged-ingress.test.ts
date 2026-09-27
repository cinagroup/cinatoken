import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readImageJsonRequest } from './image-json-request';
import { applyOpenAiImageGenerationExtras, countOpenAiGenerationReferenceImages } from './image-generation-extras';
import { buildRouteRequestBody } from './route-default-params';
import type { RouteResult } from './model-router';
import { JsonStringPages, materializeJsonStringTree, trimJsonString } from './egress/json-string-pages';
import { createJsonUploadBody } from './egress/json-upload-body';
import { segmentedJsonResponseWithinLimit } from './egress/segmented-json-response';
import { IMAGE_JSON_STRUCTURE_LIMITS } from './json-structure-budget';
import { countRouteImageGenerationReferences } from '../routes/v1/images';

const large = 'A'.repeat(8192) + 'Ā💡\ud800\n';
function req(text: string) { return new Request('https://synthetic.example.invalid/v1/images', { method: 'POST', body: text }); }
const page = (value: string) => new JsonStringPages([value.slice(0, 8192), value.slice(8192)]);
const makeRoute = (customParams: Record<string, unknown>): RouteResult => ({
	targetId: 'target', modelSurfaceId: null, routePoolId: null, providerId: 'synthetic', providerName: 'synthetic',
	providerModelName: 'image-model', upstreamProtocol: 'openai', upstreamOperation: 'images.generations', adapter: 'passthrough',
	providerEndpoints: { openai: { base: 'https://synthetic.example.invalid/v1' } }, providerApiKey: 'synthetic-key', providerSharedChannelType: null,
	priceOverrideRaw: null, routeMeteredProfileJson: null, routeChargedProfileJson: null, customParams,
	routeGroup: 'default', routePriority: 1, routeWeight: 1,
});
for (const length of [8191, 8192, 8193, 65536]) {
	it(`a ${length}-character root string remains an invalid request object`, async () => {
		await assert.rejects(readImageJsonRequest(req(JSON.stringify('A'.repeat(length)))), { message: 'Invalid JSON body' });
	});
}
async function wire(body: Record<string, unknown>) {
	const upload = createJsonUploadBody(body, new AbortController().signal, () => {});
	const text = await new Response(upload.body).text(); assert.equal(Buffer.byteLength(text), upload.contentLength); return text;
}

for (const control of ['model', 'prompt', 'n', 'size', 'quality', 'background', 'response_format', 'output_format', 'sequential_image_generation', 'stream', 'watermark', 'provider', 'service_tier', 'speed', 'session_id']) {
	it(`generation ${control} retains its declared representation and exact JSON values`, async () => {
		const original = { [control]: { nested: [large] }, image: large, opaque: { [control]: large }, optimize_prompt_options: { label: large } };
		const body = await readImageJsonRequest(req(JSON.stringify(original)));
		if (control === 'provider') assert.deepEqual(body[control], original[control]);
		else assert.ok((body[control] as { nested: unknown[] }).nested[0] instanceof JsonStringPages);
		assert.ok(body.image instanceof JsonStringPages);
		assert.ok((body.opaque as Record<string, unknown>)[control] instanceof JsonStringPages);
		assert.ok((body.optimize_prompt_options as Record<string, unknown>).label instanceof JsonStringPages);
		assert.deepEqual(materializeJsonStringTree(body), original); assert.equal(await wire(body), JSON.stringify(original));
	});
}

it('root native control selection does not leak into nested fields or change generic parser defaults', async () => {
	const text = JSON.stringify({ provider: { image: large }, image: { provider: large } });
	const native = await segmentedJsonResponseWithinLimit(new Response(text), 100000, IMAGE_JSON_STRUCTURE_LIMITS, undefined, { nativeStringFields: ['provider'] });
	assert.deepEqual(native.body, JSON.parse(text));
	const paged = await segmentedJsonResponseWithinLimit(new Response(text), 100000, IMAGE_JSON_STRUCTURE_LIMITS, undefined, { retainStringPages: true, nativeStringFields: ['provider'] });
	assert.deepEqual((paged.body as Record<string, unknown>).provider, { image: large });
	assert.ok(((paged.body as Record<string, unknown>).image as Record<string, unknown>).provider instanceof JsonStringPages);
});

for (const parts of [[], [''], [' ', '  ', '\ufeff'], ['', ' A', 'B ', ''], ['\u2000', 'Ā', '\t'], ['\ud800', '\udc00'], ['\u0085', '\u200b'], ['A', 'B']]) {
	it(`paged trim matches native whitespace/surrogate semantics: ${JSON.stringify(parts)}`, () => {
		const value = new JsonStringPages(parts), expected = parts.join('').trim();
		assert.equal(materializeJsonStringTree(trimJsonString(value)), expected);
		assert.equal(value.materialize(), parts.join(''), 'never mutate the retained source');
	});
}

it('long paged trim/count/extras/default merge/upload never materializes image payloads', async t => {
	const value = page(' \t' + large + '\ufeff '), empty = new JsonStringPages([' '.repeat(8192)]);
	t.mock.method(JsonStringPages.prototype, 'materialize', () => { throw new Error('Unexpected whole image materialization'); });
	const images = [null, empty, value, 1, value];
	const upstream: Record<string, unknown> = {};
	applyOpenAiImageGenerationExtras(upstream, { image: images, optimize_prompt_options: { label: value } });
	assert.equal(countOpenAiGenerationReferenceImages({ image: images }), 2);
	assert.equal(countOpenAiGenerationReferenceImages(upstream), 2);
	assert.ok(Array.isArray(upstream.image)); assert.ok(upstream.image.every(item => item instanceof JsonStringPages));
	const route = makeRoute({ image: { mustNotMerge: true }, optimize_prompt_options: { label: { mustNotMerge: true }, extra: true } });
	const merged = buildRouteRequestBody(route, upstream);
	assert.equal(countRouteImageGenerationReferences(route, upstream), 2);
	const plain = JSON.parse(await wire(merged));
	assert.deepEqual(plain.image, [large.trim(), large.trim()]);
	assert.deepEqual(plain.optimize_prompt_options, { label: ' \t' + large + '\ufeff ', extra: true });
});

it('paged values are scalar overrides, not records; native defaults retain their original precedence', async () => {
	const scalar = page(large);
	for (const [defaults, user, expected] of [
		[{ image: { nested: 1 } }, { image: scalar }, { image: large }],
		[{ image: scalar }, { image: { nested: 1 } }, { image: { nested: 1 } }],
		[{ image: scalar }, {}, { image: large }],
		[{ image: 'default' }, { image: scalar }, { image: large }],
	] as const) {
		const route = makeRoute(defaults);
		assert.deepEqual(JSON.parse(await wire(buildRouteRequestBody(route, user))), expected);
	}
});

it('string-valued option objects stay ignored even when internally represented by pages', async () => {
	const body = await readImageJsonRequest(req(JSON.stringify({ image: [' ', large, 4], sequential_image_generation_options: large, optimize_prompt_options: large })));
	assert.ok(body.optimize_prompt_options instanceof JsonStringPages);
	const upstream: Record<string, unknown> = {}; applyOpenAiImageGenerationExtras(upstream, body);
	assert.deepEqual(JSON.parse(await wire(upstream)), { image: large.trim() });
});
