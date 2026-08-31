import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { failoverDispatch } from '../failover-dispatch';
import {
	dispatchOpenAiAudioTranscriptions,
	isUsableAudioTranscriptionBody,
	normalizeAudioMimeType,
	normalizeAudioTranscriptionUsage,
	parseAudioDurationFromUpstreamBody,
	resolveUpstreamAudioResponseFormat,
	validateAudioUpload,
} from './openai-audio-driver';

const CANARY_SECRET = 'CANARY_SECRET';

function endpoint(providerId = 'openai', providerSlug = 'openai'): NonNullable<RouteResult['endpoint']> {
	return {
		id: `${providerId}-endpoint`, modelId: 'audio-model', providerId, providerSlug,
		selectorSlug: providerSlug, endpointClass: null, region: null,
		contextLength: 8_192, maxPromptTokens: null, maxCompletionTokens: null,
		quantization: null, supportedParameters: [],
		pricing: { currency: 'USD', prompt: '0', completion: '0', audio: '0' },
		capabilities: {
			implicit_caching: false, voice_cloning: false,
			tool_choice: { auto: false, function: false, none: false, required: false },
		},
		imageCapabilities: null,
		evidenceUrl: 'https://provider.test/evidence', verifiedBy: 'test',
		verifiedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
	};
}

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'target-asr', modelSurfaceId: 'surface-asr', routePoolId: 'pool-asr',
		providerId: 'openai', providerName: 'OpenAI', providerModelName: 'whisper-1',
		upstreamProtocol: 'openai', upstreamOperation: 'audio.transcriptions', adapter: 'passthrough',
		providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
		providerApiKey: 'sk-test', priceOverrideRaw: null, routeMeteredProfileJson: null,
		routeChargedProfileJson: null, customParams: null, routeGroup: 'default',
		routePriority: 1, routeWeight: 1, endpoint: endpoint(),
		...overrides,
	};
}

function request() {
	return {
		file: {
			filename: 'audio.wav', mimeType: 'audio/wav', bytes: new Uint8Array([1, 2, 3]),
		},
		clientResponseFormat: 'json' as const,
	};
}

async function captureConsole<T>(run: () => Promise<T>): Promise<{ value: T; output: string }> {
	const originalLog = console.log;
	const originalError = console.error;
	const entries: string[] = [];
	console.log = (...data: unknown[]) => { entries.push(data.map(String).join(' ')); };
	console.error = (...data: unknown[]) => { entries.push(data.map(String).join(' ')); };
	try {
		return { value: await run(), output: entries.join('\n') };
	} finally {
		console.log = originalLog;
		console.error = originalError;
	}
}

describe('normalizeAudioMimeType', () => {
	it('strips MediaRecorder codec parameters', () => {
		assert.equal(normalizeAudioMimeType('audio/webm;codecs=opus'), 'audio/webm');
		assert.equal(normalizeAudioMimeType('audio/ogg; codecs=opus'), 'audio/ogg');
	});

	it('maps audio/mp3 to audio/mpeg', () => {
		assert.equal(normalizeAudioMimeType('audio/mp3'), 'audio/mpeg');
	});
});

describe('validateAudioUpload', () => {
	it('accepts webm with codecs parameter', () => {
		assert.equal(
			validateAudioUpload({
				filename: 'recording.webm',
				mimeType: 'audio/webm;codecs=opus',
				bytes: new Uint8Array([1, 2, 3]),
			}),
			null
		);
	});

	it('rejects unknown mime types', () => {
		assert.match(
			validateAudioUpload({
				filename: 'x.bin',
				mimeType: 'video/mp4',
				bytes: new Uint8Array([1]),
			}) ?? '',
			/unsupported audio mime type/
		);
	});
});

describe('resolveUpstreamAudioResponseFormat', () => {
	it('forces verbose_json for whisper-1', () => {
		assert.equal(resolveUpstreamAudioResponseFormat('whisper-1', 'json'), 'verbose_json');
		assert.equal(resolveUpstreamAudioResponseFormat('whisper-1', 'text'), 'verbose_json');
	});

	it('forces json for gpt-4o-transcribe family (token usage; even when client asks text)', () => {
		assert.equal(resolveUpstreamAudioResponseFormat('gpt-4o-transcribe', 'json'), 'json');
		assert.equal(resolveUpstreamAudioResponseFormat('gpt-4o-mini-transcribe', 'text'), 'json');
		assert.equal(
			resolveUpstreamAudioResponseFormat('gpt-4o-mini-transcribe-2025-12-15', 'verbose_json'),
			'json'
		);
	});

	it('allows diarized_json for diarize model; text still uses json upstream', () => {
		assert.equal(
			resolveUpstreamAudioResponseFormat('gpt-4o-transcribe-diarize', 'diarized_json'),
			'diarized_json'
		);
		assert.equal(
			resolveUpstreamAudioResponseFormat('gpt-4o-transcribe-diarize', 'text'),
			'json'
		);
		assert.equal(
			resolveUpstreamAudioResponseFormat('gpt-4o-transcribe-diarize', 'verbose_json'),
			'json'
		);
	});
});

describe('parseAudioDurationFromUpstreamBody', () => {
	it('reads verbose_json duration', () => {
		assert.equal(parseAudioDurationFromUpstreamBody({ text: 'hi', duration: 12.5 }), 12.5);
	});

	it('reads usage.seconds from gpt-4o json', () => {
		assert.equal(
			parseAudioDurationFromUpstreamBody({
				text: 'hi',
				usage: { type: 'duration', seconds: 3.25 },
			}),
			3.25
		);
	});

	it('reads max segment end from diarized_json', () => {
		assert.equal(
			parseAudioDurationFromUpstreamBody({
				segments: [
					{ speaker: 'A', start: 0, end: 1.2, text: 'a' },
					{ speaker: 'B', start: 1.2, end: 4.0, text: 'b' },
				],
			}),
			4.0
		);
	});
});

describe('OpenRouter transcription success usage', () => {
	it('publishes only upstream-proven seconds, tokens, and cost', () => {
		assert.deepEqual(
			normalizeAudioTranscriptionUsage({
				duration: 9.2,
				usage: {
					input_tokens: 83,
					output_tokens: 30,
					cost: 0.000508,
				},
			}),
			{
				seconds: 9.2,
				input_tokens: 83,
				output_tokens: 30,
				total_tokens: 113,
				cost: 0.000508,
			},
		);
		assert.equal(normalizeAudioTranscriptionUsage({ text: 'no usage' }), null);
		assert.deepEqual(
			normalizeAudioTranscriptionUsage({ usage: { input_tokens: 1 } }),
			{ input_tokens: 1 },
		);
	});

	it('keeps text and normalized usage in the public JSON response', async () => {
		const result = await dispatchOpenAiAudioTranscriptions(
			route({ providerModelName: 'gpt-4o-transcribe' }),
			request(),
			undefined,
			null,
			undefined,
			{
				fetchImpl: async () => Response.json({
					text: 'hello',
					usage: {
						type: 'tokens',
						input_tokens: 4,
						output_tokens: 2,
						total_tokens: 6,
						cost: 0.001,
					},
				}),
			},
		);
		assert.deepEqual(await result.response.json(), {
			text: 'hello',
			usage: {
				input_tokens: 4,
				output_tokens: 2,
				total_tokens: 6,
				cost: 0.001,
			},
		});
	});

	it('applies provider.options only to the matching OpenAI-compatible route', async () => {
		let observedPrompt: FormDataEntryValue | null = null;
		let observedFlag: FormDataEntryValue | null = null;
		const result = await dispatchOpenAiAudioTranscriptions(
			route({
				providerId: 'provider-uuid', providerName: 'Hosted Audio',
				endpoint: endpoint('provider-uuid', 'groq'),
			}),
			{
				...request(),
				providerOptions: {
					groq: { prompt: 'Expected vocabulary', custom_flag: true },
					openai: { prompt: 'must not leak to Groq' },
				},
			},
			undefined,
			null,
			undefined,
			{
				fetchImpl: async (_input, init) => {
					const form = init?.body as FormData;
					observedPrompt = form.get('prompt');
					observedFlag = form.get('custom_flag');
					return Response.json({ text: 'hello', duration: 1 });
				},
			},
		);
		assert.equal(result.response.status, 200);
		assert.equal(observedPrompt, 'Expected vocabulary');
		assert.equal(observedFlag, 'true');
	});
});

describe('OpenAI transcription outcome certainty', () => {
	it('recognizes only OpenAI-compatible transcript bodies as usable', () => {
		assert.equal(isUsableAudioTranscriptionBody({ text: '' }), true);
		assert.equal(isUsableAudioTranscriptionBody({ segments: [] }), true);
		assert.equal(isUsableAudioTranscriptionBody({ error: { message: 'bad' } }), false);
		assert.equal(isUsableAudioTranscriptionBody(null), false);
	});

	it('marks a post-dispatch network failure as outcome-unknown', async () => {
		const result = await dispatchOpenAiAudioTranscriptions(
			route(), request(), undefined, null, undefined,
			{ fetchImpl: async () => { throw new TypeError('connection reset'); } },
		);
		assert.equal(result.response.status, 502);
		assert.equal(result.meta.upstreamOutcomeUnknown, true);
		assert.equal(result.meta.failoverForbidden, true);
	});

	it('stops before fetch when the client signal is already aborted', async () => {
		const controller = new AbortController();
		controller.abort();
		let fetchCalls = 0;
		const result = await dispatchOpenAiAudioTranscriptions(
			route(),
			request(),
			controller.signal,
			null,
			undefined,
			{
				fetchImpl: async () => {
					fetchCalls += 1;
					return Response.json({ text: 'must not run' });
				},
			},
		);
		assert.equal(fetchCalls, 0);
		assert.equal(result.response.status, 499);
		assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
	});

	it('marks invalid and unusable 2xx JSON as outcome-unknown', async () => {
		for (const body of ['not-json', JSON.stringify({ usage: { seconds: 1 } })]) {
			const result = await dispatchOpenAiAudioTranscriptions(
				route(), request(), undefined, null, undefined,
				{ fetchImpl: async () => new Response(body, { status: 200 }) },
			);
			assert.equal(result.response.status, 502);
			assert.equal(result.meta.upstreamOutcomeUnknown, true);
			assert.equal(result.meta.failoverForbidden, true);
			assert.equal(result.meta.audioDurationSeconds, null);
			assert.equal(result.meta.audioTokenUsage, null);
			const clientBody = await result.response.json() as {
				code?: string;
				error?: {
					code?: number;
					message?: string;
					metadata?: { error_type?: string };
				};
			};
			assert.equal(clientBody.code, 'gateway.upstream_request_failed');
			assert.equal(clientBody.error?.code, 502);
			assert.equal(clientBody.error?.metadata?.error_type, 'provider_unavailable');
			assert.equal(JSON.stringify(clientBody).includes(body), false);
		}
	});

	it('bounds 2xx response buffering while preserving explicit non-2xx known-zero', async () => {
		const tooLarge2xx = await dispatchOpenAiAudioTranscriptions(
			route(), request(), undefined, null, undefined,
			{
				maxResponseBytes: 8,
				fetchImpl: async () => new Response('0123456789', {
					status: 200, headers: { 'content-length': '10' },
				}),
			},
		);
		assert.equal(tooLarge2xx.response.status, 502);
		assert.equal(tooLarge2xx.meta.upstreamOutcomeUnknown, true);
		assert.equal(tooLarge2xx.meta.responseBodyTooLarge, true);
		assert.equal(tooLarge2xx.meta.failoverForbidden, true);

		const explicit4xx = await dispatchOpenAiAudioTranscriptions(
			route(), request(), undefined, null, undefined,
			{
				maxResponseBytes: 8,
				fetchImpl: async () => new Response('0123456789', {
					status: 400, headers: { 'content-length': '10' },
				}),
			},
		);
		assert.equal(explicit4xx.response.status, 400);
		assert.equal(explicit4xx.meta.upstreamOutcomeUnknown, undefined);
		assert.equal(explicit4xx.meta.responseBodyTooLarge, undefined);
		assert.equal(explicit4xx.meta.failoverForbidden, undefined);
	});

	it('keeps a usable 2xx transcript certain', async () => {
		const result = await dispatchOpenAiAudioTranscriptions(
			route(), request(), undefined, null, undefined,
			{ fetchImpl: async () => Response.json({ text: 'hello', duration: 1 }) },
		);
		assert.equal(result.meta.upstreamOutcomeUnknown, undefined);
		assert.equal(result.meta.failoverForbidden, undefined);
	});

	it('forbids replay and redacts endpoint query credentials after an accepted oversized response', async () => {
		let fetchCalls = 0;
		const first = route({
			targetId: 'target-asr-first',
			providerId: 'asr-first',
			routePriority: 2,
			providerEndpoints: {
				openai: {
					endpoints: {
						'audio.transcriptions': `https://openai.example/v1/audio/transcriptions?api_key=${CANARY_SECRET}`,
					},
				},
			},
		});
		const second = route({
			targetId: 'target-asr-must-not-run',
			providerId: 'asr-must-not-run',
			routePriority: 1,
		});
		const captured = await captureConsole(async () => failoverDispatch(
			{} as GatewayRepositories,
			[first, second],
			'openai',
			async (candidate, signal, timing, attempt) => dispatchOpenAiAudioTranscriptions(
				candidate,
				request(),
				signal,
				timing,
				attempt,
				{
					maxResponseBytes: 8,
					fetchImpl: async () => {
						fetchCalls += 1;
						return new Response('0123456789', {
							status: 200,
							headers: { 'content-length': '10' },
						});
					},
				},
			),
			undefined,
			{
				affinityKey: 'audio-transcription',
				tierKeyPrefix: 'audio-transcription',
				strategy: 'weight_priority',
			},
		));

		const clientPayload = await captured.value.response.text();
		assert.equal(fetchCalls, 1);
		assert.equal(captured.value.meta?.failoverForbidden, true);
		assert.equal(captured.value.meta?.responseBodyTooLarge, true);
		assert.equal(captured.output.includes(CANARY_SECRET), false);
		assert.match(captured.output, /https:\/\/openai\.example\/v1\/audio\/transcriptions/);
		assert.equal(clientPayload.includes(CANARY_SECRET), false);
		assert.equal(clientPayload.includes('upstream_url'), false);
	});
});
