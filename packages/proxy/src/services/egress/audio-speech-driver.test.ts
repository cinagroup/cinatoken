import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { failoverDispatch } from '../failover-dispatch';
import {
	buildDashScopeTtsBody,
	dispatchDashScopeMiniMaxTts,
	dispatchDashScopeQwenTts,
	dispatchDashScopeSpeechSynthesizer,
	dispatchOpenAiAudioSpeech,
	SPEECH_SSE_MAX_EVENT_CHARS,
	SpeechSseParser,
	type NormalizedAudioSpeechRequest,
} from './audio-speech-driver';

const CANARY_SECRET = 'CANARY_SECRET';

function route(overrides: Partial<RouteResult> = {}): RouteResult {
	return {
		targetId: 'target-tts',
		modelSurfaceId: 'surface-tts',
		routePoolId: 'pool-tts',
		providerId: 'aliyun',
		providerName: 'Aliyun',
		providerModelName: 'cosyvoice-v3-flash',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.speech',
		adapter: 'dashscope-tts-speech',
		providerEndpoints: { dashscope: { base: 'https://workspace.example/api/v1' } },
		providerApiKey: 'sk-test',
		priceOverrideRaw: null,
		routeMeteredProfileJson: null,
		routeChargedProfileJson: null,
		customParams: null,
		routeGroup: 'default',
		routePriority: 1,
		routeWeight: 1,
		...overrides,
	};
}

function request(overrides: Partial<NormalizedAudioSpeechRequest> = {}): NormalizedAudioSpeechRequest {
	return {
		input: '你好',
		voice: 'longxiaochun',
		responseFormat: 'mp3',
		speed: 1,
		streamFormat: 'audio',
		...overrides,
	};
}

function sse(...events: unknown[]): Response {
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
		status: 200,
		headers: { 'Content-Type': 'text/event-stream' },
	});
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

describe('DashScope TTS request mapping', () => {
	it('bounds incomplete speech SSE events and parses CRLF-framed controls incrementally', () => {
		const parser = new SpeechSseParser();
		assert.deepEqual(parser.push(new TextEncoder().encode('data: {"ok":true}\r\n\r\n')), [{ ok: true }]);
		assert.throws(
			() => parser.push(new TextEncoder().encode('x'.repeat(SPEECH_SSE_MAX_EVENT_CHARS + 1))),
			/Speech SSE event exceeds/,
		);
	});

	it('maps SpeechSynthesizer fields and keeps nested route defaults', () => {
		assert.deepEqual(
			buildDashScopeTtsBody(
				route({ customParams: { input: { sample_rate: 24000, volume: 60 } } }),
				request({ responseFormat: 'wav', speed: 1.2, instructions: '温柔一些' }),
				'speech'
			),
			{
				model: 'cosyvoice-v3-flash',
				input: {
					sample_rate: 24000,
					volume: 60,
					text: '你好',
					voice: 'longxiaochun',
					format: 'wav',
					rate: 1.2,
					instruction: '温柔一些',
				},
			}
		);
	});

	it('uses distinct Qwen and MiniMax body shapes', () => {
		assert.deepEqual(
			buildDashScopeTtsBody(
				route({ providerModelName: 'qwen3-tts-flash' }),
				request({ responseFormat: 'wav', voice: { id: 'Cherry' }, instructions: 'cheerful' }),
				'qwen'
			),
			{
				model: 'qwen3-tts-flash',
				input: { text: '你好', voice: 'Cherry', instructions: 'cheerful' },
			}
		);
		assert.deepEqual(
			buildDashScopeTtsBody(
				route({ providerModelName: 'MiniMax/speech-2.8-hd' }),
				request({ responseFormat: 'flac', voice: 'male-qn-qingse', speed: 1.1 }),
				'minimax'
			),
			{
				model: 'MiniMax/speech-2.8-hd',
				input: {
					text: '你好',
					voice_setting: { voice_id: 'male-qn-qingse', speed: 1.1 },
					audio_setting: { format: 'flac' },
					stream_options: { exclude_aggregated_audio: true },
				},
			}
		);
	});
});

describe('DashScope TTS streaming conversion', () => {
	it('decodes SpeechSynthesizer Base64 chunks and captures characters', async () => {
		let upstreamBody: unknown;
		const result = await dispatchDashScopeSpeechSynthesizer(
			route(),
			request(),
			undefined,
			null,
			undefined,
			{
				fetchImpl: async (_input, init) => {
					upstreamBody = JSON.parse(String(init?.body));
					return sse(
						{
							request_id: 'req-tts',
							output: { finish_reason: 'null', audio: { data: 'AQI=' } },
							usage: { characters: 2 },
						},
						{
							request_id: 'req-tts',
							output: { finish_reason: 'stop', audio: { data: '' } },
							usage: { characters: 2 },
						}
					);
				},
			}
		);
		assert.equal(result.upstreamRequestId, 'req-tts');
		assert.deepEqual(new Uint8Array(await result.response.arrayBuffer()), new Uint8Array([1, 2]));
		assert.equal((await result.usagePromise).audio_characters, 2);
		assert.equal((upstreamBody as { model: string }).model, 'cosyvoice-v3-flash');
	});

	it('converts MiniMax hex chunks into OpenAI speech SSE events without tail duplication', async () => {
		const result = await dispatchDashScopeMiniMaxTts(
			route({
				providerModelName: 'MiniMax/speech-2.8-hd',
				upstreamOperation: 'audio.speech.multimodal',
				adapter: 'dashscope-tts-minimax',
			}),
			request({ streamFormat: 'sse' }),
			undefined,
			null,
			undefined,
			{
				fetchImpl: async () =>
					sse(
						{
							output: {
								base_resp: { status_code: 0, status_msg: 'success' },
								data: { audio: '0102', status: 1 },
							},
							usage: { characters: 2 },
						},
						{
							output: {
								base_resp: { status_code: 0, status_msg: 'success' },
								data: { audio: '', status: 2 },
							},
							usage: { characters: 2 },
						}
					),
			}
		);
		const text = await result.response.text();
		assert.match(text, /"type":"speech\.audio\.delta","audio":"AQI="/);
		assert.match(text, /"type":"speech\.audio\.done"/);
		assert.equal((await result.usagePromise).audio_characters, 2);
	});

	it('turns a first-frame Qwen application error into an HTTP failure before streaming', async () => {
		const result = await dispatchDashScopeQwenTts(
			route({
				providerModelName: 'qwen3-tts-flash',
				upstreamOperation: 'audio.speech.multimodal',
				adapter: 'dashscope-tts-qwen',
			}),
			request({ responseFormat: 'wav' }),
			undefined,
			null,
			undefined,
			{ fetchImpl: async () => sse({ code: 'InvalidParameter', message: 'bad voice' }) }
		);
		assert.equal(result.response.status, 502);
		assert.match(await result.response.text(), /bad voice/);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
	});

	it('keeps an explicit DashScope non-2xx response known-zero', async () => {
		const result = await dispatchDashScopeSpeechSynthesizer(
			route(), request(), undefined, null, undefined,
			{ fetchImpl: async () => Response.json({ error: 'bad request' }, { status: 400 }) },
		);
		assert.equal(result.response.status, 400);
		assert.equal(result.meta?.upstreamOutcomeUnknown, undefined);
		assert.equal(result.meta?.failoverForbidden, undefined);
	});
});

describe('OpenAI speech passthrough', () => {
	it('preserves SSE bytes while extracting the done-event token usage', async () => {
		const upstream = [
			{ type: 'speech.audio.delta', audio: 'AQI=' },
			{ type: 'speech.audio.done', usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } },
		];
		const result = await dispatchOpenAiAudioSpeech(
			route({
				upstreamProtocol: 'openai',
				upstreamOperation: 'audio.speech',
				adapter: 'passthrough',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
			}),
			request({ streamFormat: 'sse' }),
			undefined,
			null,
			undefined,
			{ fetchImpl: async () => sse(...upstream) }
		);
		assert.deepEqual(
			(await result.response.text()).trim().split('\n\n'),
			upstream.map((event) => `data: ${JSON.stringify(event)}`)
		);
		assert.deepEqual(await result.usagePromise, {
			input_tokens: 3,
			output_tokens: 5,
			cache_read_tokens: 0,
			cache_write_tokens: 0,
			reasoning_tokens: 0,
			total_tokens: 8,
			raw_usage: JSON.stringify(upstream[1]!.usage),
		});
	});

	it('forbids replay after fetch failures while keeping explicit non-2xx known-zero', async () => {
		const failed = await dispatchOpenAiAudioSpeech(
			route({
				upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
			}),
			request(), undefined, null, undefined,
			{ fetchImpl: async () => { throw new TypeError('connection reset'); } },
		);
		assert.equal(failed.response.status, 502);
		assert.equal(failed.meta?.upstreamOutcomeUnknown, true);
		assert.equal(failed.meta?.failoverForbidden, true);

		const rejected = await dispatchOpenAiAudioSpeech(
			route({
				upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
			}),
			request(), undefined, null, undefined,
			{ fetchImpl: async () => Response.json({ error: 'bad request' }, { status: 400 }) },
		);
		assert.equal(rejected.meta?.upstreamOutcomeUnknown, undefined);
		assert.equal(rejected.meta?.failoverForbidden, undefined);
	});

	it('marks a consumed 2xx empty body and a later stream read failure as unknown', async () => {
		const openAiRoute = route({
			upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
			providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
		});
		const empty = await dispatchOpenAiAudioSpeech(
			openAiRoute, request(), undefined, null, undefined,
			{ fetchImpl: async () => new Response(null, { status: 200 }) },
		);
		assert.equal(empty.meta?.upstreamOutcomeUnknown, true);
		assert.equal(empty.meta?.failoverForbidden, true);

		const emptyStream = await dispatchOpenAiAudioSpeech(
			openAiRoute, request(), undefined, null, undefined,
			{ fetchImpl: async () => new Response('', { status: 200 }) },
		);
		await assert.rejects(() => emptyStream.response.arrayBuffer(), /without audio data/);
		await emptyStream.usagePromise;
		assert.equal(emptyStream.meta?.upstreamOutcomeUnknown, true);
		assert.equal(emptyStream.meta?.failoverForbidden, true);

		let pullCount = 0;
		const brokenBody = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pullCount++ === 0) {
					controller.enqueue(new TextEncoder().encode(
						`data: ${JSON.stringify({ type: 'speech.audio.delta', audio: 'AQI=' })}\n\n`,
					));
					return;
				}
				controller.error(new Error('socket closed'));
			},
		});
		const broken = await dispatchOpenAiAudioSpeech(
			openAiRoute, request({ streamFormat: 'sse' }), undefined, null, undefined,
			{ fetchImpl: async () => new Response(brokenBody, { status: 200 }) },
		);
		await assert.rejects(() => broken.response.text(), /socket closed/);
		const usage = await broken.usagePromise;
		assert.match(usage.stream_error ?? '', /socket closed/);
		assert.equal(broken.meta?.upstreamOutcomeUnknown, true);
		assert.equal(broken.meta?.failoverForbidden, true);
	});

	it('stops failover and redacts query credentials after an unknown speech dispatch', async () => {
		let fetchCalls = 0;
		const first = route({
			targetId: 'target-tts-first',
			providerId: 'tts-first',
			providerName: 'TTS First',
			providerModelName: 'gpt-4o-mini-tts',
			upstreamProtocol: 'openai',
			upstreamOperation: 'audio.speech',
			adapter: 'passthrough',
			routePriority: 2,
			providerEndpoints: {
				openai: {
					endpoints: {
						'audio.speech': `https://openai.example/v1/audio/speech?api_key=${CANARY_SECRET}`,
					},
				},
			},
		});
		const second = route({
			targetId: 'target-tts-must-not-run',
			providerId: 'tts-must-not-run',
			providerName: 'TTS Must Not Run',
			providerModelName: 'gpt-4o-mini-tts',
			upstreamProtocol: 'openai',
			upstreamOperation: 'audio.speech',
			adapter: 'passthrough',
			routePriority: 1,
			providerEndpoints: { openai: { base: 'https://fallback.example/v1' } },
		});
		const captured = await captureConsole(async () => failoverDispatch(
			{} as GatewayRepositories,
			[first, second],
			'openai',
			async (candidate, signal, timing, attempt) => dispatchOpenAiAudioSpeech(
				candidate,
				request(),
				signal,
				timing,
				attempt,
				{
					fetchImpl: async () => {
						fetchCalls += 1;
						throw new TypeError(
							`network failed at https://openai.example/v1/audio/speech?api_key=${CANARY_SECRET}`,
						);
					},
				},
			),
			undefined,
			{
				affinityKey: 'audio-speech',
				tierKeyPrefix: 'audio-speech',
				strategy: 'weight_priority',
			},
		));

		const clientPayload = await captured.value.response.text();
		assert.equal(fetchCalls, 1);
		assert.equal(captured.value.meta?.upstreamOutcomeUnknown, true);
		assert.equal(captured.value.meta?.failoverForbidden, true);
		assert.equal(captured.output.includes(CANARY_SECRET), false);
		assert.match(captured.output, /https:\/\/openai\.example\/v1\/audio\/speech/);
		assert.equal(clientPayload.includes(CANARY_SECRET), false);
		assert.equal(clientPayload.includes('upstream_url'), false);
	});
});
