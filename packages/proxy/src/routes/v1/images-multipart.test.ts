import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyGuardrailFiltersToJson, type GatewayRepositories, type GuardrailBudgetIntent } from '@octafuse/core';
import {
	IMAGE_OUTPUT_GUARDRAIL_UNSUPPORTED,
	imageEditGuardrailBody,
	imageGenerationGuardrailBody,
	imageClientOutcomeBillable,
	shouldPreserveImageDispatchedCeiling,
	imageRouteSupportsParameter,
	imageOutputGuardrailBlockReason,
	countRouteImageGenerationReferences,
	admitImageGuardrailBudget,
	parseMultipartImageProvider,
	validateImagesEditsContentType,
} from './images';
import { isAtomicImageBudgetRoute } from '../../middleware/auth';
import type { RouteResult } from '../../services/model-router';

const BUDGET_INTENT: GuardrailBudgetIntent = {
	assignmentId: 'assignment-1',
	guardrailId: 'guardrail-1',
	guardrailVersion: 1,
	scopeType: 'api_key',
	scopeId: 'key-1',
	period: 'daily',
	periodStart: '2026-08-29T00:00:00.000Z',
	periodEnd: '2026-08-30T00:00:00.000Z',
	limitMicros: 1_000_000,
};

describe('validateImagesEditsContentType', () => {
	it('accepts multipart/form-data with boundary', () => {
		assert.equal(
			validateImagesEditsContentType('multipart/form-data; boundary=----WebKitFormBoundary7MA4YWxk'),
			null
		);
	});

	it('rejects application/json (the axios FormData footgun)', () => {
		const err = validateImagesEditsContentType('application/json');
		assert.match(err ?? '', /Unsupported Content-Type/i);
		assert.match(err ?? '', /multipart\/form-data/);
		assert.match(err ?? '', /application\/json/);
		assert.doesNotMatch(err ?? '', /Missing model/i);
	});

	it('rejects missing Content-Type', () => {
		assert.match(validateImagesEditsContentType(null) ?? '', /\(missing\)/);
		assert.match(validateImagesEditsContentType('') ?? '', /\(missing\)/);
	});

	it('rejects application/x-www-form-urlencoded for edits (files require multipart)', () => {
		const err = validateImagesEditsContentType('application/x-www-form-urlencoded');
		assert.match(err ?? '', /Unsupported Content-Type/i);
	});
});

describe('multipart image provider preferences', () => {
	it('parses a JSON provider object without forwarding it as image content', () => {
		assert.deepEqual(
			parseMultipartImageProvider('{"sort":"price","max_price":{"image":0.05}}'),
			{ ok: true, value: { sort: 'price', max_price: { image: 0.05 } } },
		);
		assert.deepEqual(parseMultipartImageProvider(undefined), { ok: true, value: null });
	});

	it('rejects malformed and non-object provider values', () => {
		assert.equal(parseMultipartImageProvider('not-json').ok, false);
		assert.equal(parseMultipartImageProvider('[]').ok, false);
		assert.equal(parseMultipartImageProvider('null').ok, false);
		assert.equal(parseMultipartImageProvider(' '.repeat(16_385)).ok, false);
	});
});

describe('OpenRouter Images root budget boundary', () => {
	it('includes only the canonical root and existing image write aliases', () => {
		for (const path of [
			'/v1/images', '/v1/images/', '/api/v1/images', '/api/v1/images/',
			'/v1/images/generations', '/api/v1/images/edits',
		]) {
			assert.equal(isAtomicImageBudgetRoute('POST', path), true, path);
		}
		for (const path of [
			'/v1/images/models', '/api/v1/images-malicious', '/v1/images/generations/extra',
		]) {
			assert.equal(isAtomicImageBudgetRoute('POST', path), false, path);
		}
		assert.equal(isAtomicImageBudgetRoute('GET', '/api/v1/images'), false);
	});

	it('requires affirmative endpoint metadata for stream and n', () => {
		const endpoint = {
			id: 'image-endpoint', modelId: 'image-model', providerId: 'image-provider',
			providerSlug: 'image-provider', selectorSlug: 'image-provider', endpointClass: null,
			region: null, contextLength: null, maxPromptTokens: null, maxCompletionTokens: null,
			quantization: null, supportedParameters: [], pricing: null,
			capabilities: {
				implicit_caching: null, voice_cloning: null,
				tool_choice: { auto: null, function: null, none: null, required: null },
			},
			imageCapabilities: {
				provider_slug: 'image-provider', provider_tag: null, supports_streaming: true,
				supported_parameters: { n: { type: 'range', min: 1, max: 4 } },
				allowed_passthrough_parameters: [], pricing: [],
			},
			evidenceUrl: 'https://provider.test/evidence', verifiedBy: 'test',
			verifiedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
		} satisfies NonNullable<RouteResult['endpoint']>;
		const route = { endpoint };
		assert.equal(imageRouteSupportsParameter(route, 'stream'), true);
		assert.equal(imageRouteSupportsParameter(route, 'n', 4), true);
		assert.equal(imageRouteSupportsParameter(route, 'n', 5), false);
		assert.equal(imageRouteSupportsParameter({ endpoint: undefined }, 'stream'), false);
		assert.equal(imageRouteSupportsParameter({ endpoint: { ...endpoint, imageCapabilities: null } }, 'n'), false);
	});

	it('derives generation reference facts from the same route-default merge as the driver', () => {
		const route = {
			customParams: {
				image: ['https://example.test/reference-a.png', 'https://example.test/reference-b.png'],
			},
		} as RouteResult;
		assert.equal(
			countRouteImageGenerationReferences(route, { prompt: 'draw', n: 1 }),
			2,
		);
		assert.equal(
			countRouteImageGenerationReferences(route, {
				prompt: 'draw', n: 1, image: 'https://example.test/user-reference.png',
			}),
			1,
		);
	});

	it('preserves unknown dispatched outcomes but releases proven non-billable terminals', () => {
		assert.equal(shouldPreserveImageDispatchedCeiling({
			costUnknown: true,
		}), true);
		assert.equal(shouldPreserveImageDispatchedCeiling({
			costUnknown: true, imageAbortReason: 'gateway_timeout',
		}), false);
		assert.equal(imageClientOutcomeBillable({
			status: 'error', responseOk: true, costUnknown: true,
		}), undefined);
		assert.equal(imageClientOutcomeBillable({
			status: 'error', responseOk: false, costUnknown: true,
		}), undefined);
		assert.equal(imageClientOutcomeBillable({
			status: 'error', responseOk: false, costUnknown: false,
		}), false);
		assert.equal(imageClientOutcomeBillable({
			status: 'error', responseOk: true, costUnknown: true,
			imageAbortReason: 'client_abort',
		}), false);
		assert.equal(imageClientOutcomeBillable({
			status: 'success', responseOk: true, costUnknown: false,
		}), true);
	});
});

describe('image Guardrail request boundary', () => {
	it('filters a generation prompt without exposing reference images or routing controls', () => {
		const body = imageGenerationGuardrailBody('openai/gpt-image-1', {
			prompt: 'draw secret skyline', n: 1, size: '1024x1024', quality: 'high',
			background: 'transparent',
		});
		assert.deepEqual(Object.keys(body).sort(), [
			'background', 'model', 'n', 'prompt', 'quality', 'size',
		]);
		assert.equal('image' in body, false);
		assert.equal('provider' in body, false);
		assert.equal('input' in body, false);
		assert.equal('stream' in body, false);

		const filtered = applyGuardrailFiltersToJson(body, [
			{ id: 'secret', pattern: 'secret', action: 'redact' },
		]);
		assert.equal(filtered.blockedBy, null);
		assert.equal((filtered.value as Record<string, unknown>).prompt, 'draw [REDACTED:secret] skyline');
	});

	it('exposes the edits prompt for filtering without image bytes or synthetic fields', () => {
		const body = imageEditGuardrailBody('openai/gpt-image-1', {
			prompt: 'draw secret skyline', n: 1, size: '1024x1024', quality: 'high',
			background: 'transparent',
		});
		assert.deepEqual(Object.keys(body).sort(), [
			'background', 'model', 'n', 'prompt', 'quality', 'size',
		]);
		assert.equal('images' in body, false);
		assert.equal('input' in body, false);
		assert.equal('stream' in body, false);

		const filtered = applyGuardrailFiltersToJson(body, [
			{ id: 'secret', pattern: 'secret', action: 'redact' },
		]);
		assert.equal(filtered.blockedBy, null);
		assert.equal((filtered.value as Record<string, unknown>).prompt, 'draw [REDACTED:secret] skyline');
	});

	it('fails closed whenever an image output filter is configured', () => {
		assert.equal(imageOutputGuardrailBlockReason(0), null);
		assert.equal(imageOutputGuardrailBlockReason(1), IMAGE_OUTPUT_GUARDRAIL_UNSUPPORTED);
		assert.equal(imageOutputGuardrailBlockReason(20), IMAGE_OUTPUT_GUARDRAIL_UNSUPPORTED);
	});
});

describe('image Guardrail budget lifecycle', () => {
	it('reserves, marks dispatched, and forfeits at most once', async () => {
		const calls: string[] = [];
		const repos = {
			guardrailBudgets: {
				expireBefore: async () => { calls.push('expire'); return 0; },
				reserveMany: async (params: { requestId: string; reservedMicros: number }) => {
					calls.push(`reserve:${params.requestId}:${params.reservedMicros}`);
					return { status: 'reserved' as const, reservationCount: 1 };
				},
				markDispatched: async (requestId: string) => {
					calls.push(`dispatch:${requestId}`);
					return true;
				},
				forfeitMany: async (requestId: string, _now: string, reason: string) => {
					calls.push(`forfeit:${requestId}:${reason}`);
					return 1;
				},
			},
		} as unknown as GatewayRepositories;
		const lease = await admitImageGuardrailBudget(repos, {
			requestId: 'request-1', intents: [BUDGET_INTENT], reservedMicros: 123,
			now: new Date('2026-08-29T12:00:00.000Z'),
		});
		assert.equal(lease.ok, true);
		if (!lease.ok) return;
		assert.equal(lease.reserved, true);
		assert.equal(lease.dispatched, false);
		await lease.beforeUpstreamDispatch();
		await lease.forfeit('upstream_dispatch_failed');
		await lease.forfeit('ignored_second_reason');
		assert.deepEqual(calls, [
			'expire', 'reserve:request-1:123', 'dispatch:request-1',
			'forfeit:request-1:upstream_dispatch_failed',
		]);
	});

	it('releases the admission lease when dispatch marking fails', async () => {
		const calls: string[] = [];
		const repos = {
			guardrailBudgets: {
				expireBefore: async () => 0,
				reserveMany: async () => ({ status: 'reserved' as const, reservationCount: 1 }),
				markDispatched: async () => false,
				releaseMany: async (requestId: string, _now: string, reason: string) => {
					calls.push(`release:${requestId}:${reason}`);
					return 1;
				},
			},
		} as unknown as GatewayRepositories;
		const lease = await admitImageGuardrailBudget(repos, {
				requestId: 'request-2', intents: [BUDGET_INTENT], reservedMicros: 456,
				now: new Date('2026-08-29T12:00:00.000Z'),
			});
		assert.equal(lease.ok, true);
		if (!lease.ok) return;
		await assert.rejects(
			lease.beforeUpstreamDispatch(),
			/enter dispatched state/,
		);
		await lease.release('upstream_dispatch_not_started');
		assert.deepEqual(calls, [
			'release:request-2:upstream_dispatch_not_started',
		]);
	});
});
