import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GatewayRepositories } from '@octafuse/core';
import type { RouteResult } from '../model-router';
import { failoverDispatch } from '../failover-dispatch';
import {
	audioSpeechRouteCanDispatch,
	buildDashScopeTtsBody,
	dispatchDashScopeMiniMaxTts,
	dispatchDashScopeQwenTts,
	dispatchDashScopeSpeechSynthesizer,
	dispatchOpenAiAudioSpeech,
	redactAudioSpeechRequestForLog,
	SPEECH_SSE_MAX_EVENT_CHARS,
	speechResponseContentType,
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

function endpoint(
	voiceCloning: boolean | null,
	speechEvidence: {
		supports_default_voice: boolean | null;
		reference_audio_media_types: string[];
		reference_audio_default_media_type: string | null;
	} | null = {
		supports_default_voice: false,
		reference_audio_media_types: ['audio/wav', 'audio/mpeg'],
		reference_audio_default_media_type: 'audio/wav',
	},
): NonNullable<RouteResult['endpoint']> {
	return {
		id: 'tts-endpoint', modelId: 'tts-model', providerId: 'hosted-openai', providerSlug: 'hosted-openai',
		selectorSlug: 'hosted-openai', endpointClass: null, region: null,
		contextLength: 8_192, maxPromptTokens: null, maxCompletionTokens: null,
		quantization: null, supportedParameters: [],
		pricing: { currency: 'USD', prompt: '0', completion: '0', audio: '0' },
		capabilities: {
			implicit_caching: false, voice_cloning: voiceCloning,
			tool_choice: { auto: false, function: false, none: false, required: false },
		},
		imageCapabilities: null,
		audioCapabilities: {
			v: 1,
			pricing_by_operation: {
				'audio.speech': {
					currency: 'USD',
					meter: {
						kind: 'characters', unit: 'unicode_code_point', price: '0.00002',
						minimum_units: 0, increment_units: 1,
					},
				},
			},
			...(speechEvidence ? { speech_by_operation: { 'audio.speech': speechEvidence } } : {}),
		},
		evidenceUrl: 'https://provider.test/evidence', verifiedBy: 'test',
		verifiedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z',
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
	it('uses canonical OpenRouter response Content-Types', () => {
		assert.equal(speechResponseContentType(request({ responseFormat: 'mp3' })), 'audio/mpeg');
		assert.equal(speechResponseContentType(request({ responseFormat: 'pcm' })), 'audio/pcm');
		assert.equal(
			speechResponseContentType(request({ responseFormat: 'pcm', streamFormat: 'sse' })),
			'text/event-stream; charset=utf-8',
		);
	});

	it('rejects adapter-incompatible requests before pricing or dispatch', () => {
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'passthrough', upstreamProtocol: 'openai' }),
			request({ responseFormat: 'pcm', speed: 4, instructions: 'bright' }),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-speech' }),
			request({ responseFormat: 'pcm', speed: 2 }),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-speech' }),
			request({ responseFormat: 'pcm', speed: 2.01 }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-qwen' }),
			request({ responseFormat: 'pcm' }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-qwen' }),
			request({ responseFormat: 'wav', speed: 4 }),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-minimax' }),
			request({ speed: 2.01 }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-minimax' }),
			request({ responseFormat: 'mp3', instructions: 'bright' }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'unknown' }),
			request(),
		), false);
	});

	it('admits stateless cloning only on a verified OpenAI-compatible endpoint', () => {
		const cloningRequest = request({
			voice: undefined,
			inputReferences: [{
				type: 'input_audio',
				inputAudio: { bytes: new Uint8Array([1, 2, 3]), encoding: { kind: 'raw_base64' } },
			}],
		});
		for (const voiceCloning of [false, null]) {
			assert.equal(audioSpeechRouteCanDispatch(
				route({ adapter: 'passthrough', upstreamProtocol: 'openai', endpoint: endpoint(voiceCloning) }),
				cloningRequest,
			), false);
		}
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'passthrough', upstreamProtocol: 'openai', endpoint: endpoint(true) }),
			cloningRequest,
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'passthrough', upstreamProtocol: 'openai', endpoint: endpoint(true, null) }),
			cloningRequest,
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'passthrough', upstreamProtocol: 'openai', endpoint: endpoint(true) }),
			request({
				voice: undefined,
				inputReferences: [{
					type: 'input_audio',
					inputAudio: {
						bytes: new Uint8Array([1]),
						encoding: { kind: 'data_uri', mediaType: 'audio/ogg' },
					},
				}],
			}),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-speech', endpoint: endpoint(true) }),
			cloningRequest,
		), false);
	});

	it('requires verified provider-side default-voice evidence when voice is omitted', () => {
		const withoutVoice = request({ voice: undefined });
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'passthrough', upstreamProtocol: 'openai', endpoint: endpoint(false, null) }),
			withoutVoice,
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({
				adapter: 'passthrough',
				upstreamProtocol: 'openai',
				endpoint: endpoint(false, {
					supports_default_voice: true,
					reference_audio_media_types: [],
					reference_audio_default_media_type: null,
				}),
			}),
			withoutVoice,
		), true);
	});

	it('validates built-in DashScope provider options before route admission', () => {
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-speech' }),
			request({ providerOptions: { aliyun: { sample_rate: 24_000, volume: 75, pitch: 1.1 } } }),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-speech' }),
			request({ providerOptions: { aliyun: { volume: 101 } } }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-qwen' }),
			request({
				responseFormat: 'wav', speed: 4,
				providerOptions: { aliyun: { language_type: 'English', optimize_instructions: true } },
			}),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-qwen' }),
			request({ responseFormat: 'wav', providerOptions: { aliyun: { speed: 2 } } }),
		), false);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-minimax' }),
			request({
				providerOptions: { aliyun: {
					voice_setting: { emotion: 'happy', pitch: -2, vol: 1.25 },
					audio_setting: { sample_rate: 32_000, bitrate: 128_000, channel: 1 },
					pronunciation_dict: { tone: ['处理/(chu3)(li3)'] },
					text_normalization: true,
				} },
			}),
		), true);
		assert.equal(audioSpeechRouteCanDispatch(
			route({ adapter: 'dashscope-tts-minimax' }),
			request({ providerOptions: { aliyun: { voice_setting: { speed: 1.5 } } } }),
		), false);
	});

	it('bounds incomplete speech SSE events and parses CRLF-framed controls incrementally', () => {
		const parser = new SpeechSseParser();
		assert.deepEqual(parser.push(new TextEncoder().encode('data: {"ok":true}\r\n\r\n')), [{ ok: true }]);
		assert.throws(
			() => parser.push(new TextEncoder().encode('x'.repeat(SPEECH_SSE_MAX_EVENT_CHARS + 1))),
			/Speech SSE event exceeds/,
		);
	});

	it('maps only matching SpeechSynthesizer provider options and protects standard fields', () => {
		assert.deepEqual(
			buildDashScopeTtsBody(
				route({ customParams: { input: { sample_rate: 24000, volume: 60 } } }),
				request({
					responseFormat: 'pcm',
					speed: 1.2,
					instructions: '温柔一些',
					providerOptions: {
						aliyun: {
							volume: 75,
							pitch: 1.1,
							text: 'must not override input',
							format: 'wav',
							instruction: 'must not override instructions',
						},
						openai: { volume: 0 },
					},
				}),
				'speech'
			),
			{
				model: 'cosyvoice-v3-flash',
				input: {
					sample_rate: 24000,
					volume: 75,
					pitch: 1.1,
					text: '你好',
					voice: 'longxiaochun',
					format: 'pcm',
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
				request({
					responseFormat: 'wav',
					voice: 'Cherry',
					instructions: 'cheerful',
					providerOptions: {
						aliyun: {
							language_type: 'English',
							optimize_instructions: true,
							voice: 'must-not-override',
							instructions: 'must-not-override',
						},
					},
				}),
				'qwen'
			),
			{
				model: 'qwen3-tts-flash',
				input: {
					language_type: 'English',
					optimize_instructions: true,
					text: '你好',
					voice: 'Cherry',
					instructions: 'cheerful',
				},
			}
		);
		assert.deepEqual(
			buildDashScopeTtsBody(
				route({ providerModelName: 'MiniMax/speech-2.8-hd' }),
				request({
					responseFormat: 'flac',
					voice: 'male-qn-qingse',
					speed: 1.1,
					providerOptions: {
						aliyun: {
							voice_setting: { voice_id: 'must-not-override', emotion: 'happy', speed: 2 },
							audio_setting: { format: 'wav', sample_rate: 32000 },
							stream_options: { exclude_aggregated_audio: false },
							text_normalization: true,
						},
					},
				}),
				'minimax'
			),
			{
				model: 'MiniMax/speech-2.8-hd',
				input: {
					text: '你好',
					voice_setting: {
						voice_id: 'male-qn-qingse',
						emotion: 'happy',
						speed: 1.1,
					},
					audio_setting: { format: 'flac', sample_rate: 32000 },
					stream_options: { exclude_aggregated_audio: true },
					text_normalization: true,
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
			request({ responseFormat: 'pcm' }),
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
		assert.equal(result.response.headers.get('content-type'), 'audio/pcm');
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
	it('serializes raw and data-URI clone references without requiring voice', async () => {
		for (const encoding of [
			{ kind: 'raw_base64' as const },
			{ kind: 'data_uri' as const, mediaType: 'audio/wav' },
		]) {
			let upstreamBody: Record<string, unknown> | null = null;
			let upstreamDuplex: string | undefined;
			const cloneRequest = request({
				voice: undefined,
				inputReferences: [
					{
						type: 'input_audio',
						inputAudio: { bytes: new Uint8Array([1, 2, 3]), encoding },
					},
					{ type: 'text', text: 'CANARY_REFERENCE_TRANSCRIPT' },
				],
			});
			const result = await dispatchOpenAiAudioSpeech(
				route({
					providerId: 'hosted-openai', providerName: 'Hosted OpenAI',
					upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
					providerModelName: 'clone-tts',
					providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
					endpoint: endpoint(true),
				}),
				cloneRequest,
				undefined,
				null,
				undefined,
				{
					fetchImpl: async (_input, init) => {
						upstreamDuplex = (init as RequestInit & { duplex?: string } | undefined)?.duplex;
						upstreamBody = await new Response(init?.body).json() as Record<string, unknown>;
						return new Response(new Uint8Array([1]), {
							status: 200, headers: { 'Content-Type': 'audio/pcm' },
						});
					},
				},
			);
			await result.response.arrayBuffer();
			await result.usagePromise;
			assert.equal(upstreamDuplex, 'half');
			assert.equal('voice' in upstreamBody!, false);
			assert.deepEqual(upstreamBody!.input_references, [
				{
					type: 'input_audio',
					input_audio: {
						data: encoding.kind === 'data_uri' ? 'data:audio/wav;base64,AQID' : 'AQID',
					},
				},
				{ type: 'text', text: 'CANARY_REFERENCE_TRANSCRIPT' },
			]);
		}
	});

	it('logs clone payload metadata without audio or transcript content', () => {
		const redacted = redactAudioSpeechRequestForLog('clone-tts', request({
			voice: undefined,
			inputReferences: [
				{
					type: 'input_audio',
					inputAudio: {
						bytes: new Uint8Array([1, 2, 3]),
						encoding: { kind: 'raw_base64' },
					},
				},
				{ type: 'text', text: 'CANARY_REFERENCE_TRANSCRIPT' },
			],
		}));
		assert.equal(redacted.reference_audio_bytes, 3);
		assert.equal(redacted.has_reference_transcript, true);
		assert.equal(redacted.input_reference_count, 2);
		const serialized = JSON.stringify(redacted);
		assert.equal(serialized.includes('AQID'), false);
		assert.equal(serialized.includes('CANARY_REFERENCE_TRANSCRIPT'), false);
	});
	it('forwards provider.options only to the matching route attempt', async () => {
		let upstreamBody: Record<string, unknown> | null = null;
		const result = await dispatchOpenAiAudioSpeech(
			route({
				providerId: 'hosted-openai',
				providerName: 'Hosted OpenAI',
				upstreamProtocol: 'openai',
				upstreamOperation: 'audio.speech',
				adapter: 'passthrough',
				providerModelName: 'gpt-4o-mini-tts',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
			}),
			request({
				responseFormat: 'pcm',
				providerOptions: {
					'hosted-openai': {
						instructions: 'Speak warmly',
						style: 'friendly',
						input: 'must not override input',
						voice: 'must-not-override',
						speed: 3,
					},
					other: { secret_option: 'must not leak' },
				},
			}),
			undefined,
			null,
			undefined,
			{
				fetchImpl: async (_input, init) => {
					upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return new Response(new Uint8Array([1]), {
						status: 200,
						headers: { 'Content-Type': 'audio/pcm' },
					});
				},
			},
		);
		await result.response.arrayBuffer();
		await result.usagePromise;
		assert.deepEqual(upstreamBody, {
			instructions: 'Speak warmly',
			style: 'friendly',
			model: 'gpt-4o-mini-tts',
			input: '你好',
			voice: 'longxiaochun',
			response_format: 'pcm',
			speed: 1,
			stream_format: 'audio',
		});
	});

	it('does not let route defaults inject unscanned voice-cloning references', async () => {
		let upstreamBody: Record<string, unknown> | null = null;
		const result = await dispatchOpenAiAudioSpeech(
			route({
				providerId: 'hosted-openai', providerName: 'Hosted OpenAI',
				upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
				providerModelName: 'gpt-4o-mini-tts',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
				customParams: {
					input_references: [{
						type: 'input_audio', input_audio: { data: 'CANARY_ROUTE_DEFAULT_AUDIO' },
					}],
				},
			}),
			request(),
			undefined,
			null,
			undefined,
			{
				fetchImpl: async (_input, init) => {
					upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
					return new Response(new Uint8Array([1]), {
						status: 200, headers: { 'Content-Type': 'audio/mpeg' },
					});
				},
			},
		);
		await result.response.arrayBuffer();
		await result.usagePromise;
		assert.equal('input_references' in upstreamBody!, false);
		assert.equal(JSON.stringify(upstreamBody).includes('CANARY_ROUTE_DEFAULT_AUDIO'), false);
	});

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
		assert.equal(result.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
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

	it('streams raw bytes while canonicalizing MP3 and PCM Content-Type', async () => {
		const openAiRoute = route({
			upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
			providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
		});
		for (const [responseFormat, expectedContentType] of [
			['mp3', 'audio/mpeg'],
			['pcm', 'audio/pcm'],
		] as const) {
			const result = await dispatchOpenAiAudioSpeech(
				openAiRoute,
				request({ responseFormat }),
				undefined,
				null,
				undefined,
				{
					fetchImpl: async () => new Response(new Uint8Array([1, 2, 3]), {
						status: 200,
						headers: {
							'Content-Type': 'application/octet-stream',
							'Content-Encoding': 'gzip',
							'Content-Length': '3',
						},
					}),
				},
			);
			assert.equal(result.response.headers.get('content-type'), expectedContentType);
			assert.equal(result.response.headers.has('content-encoding'), false);
			assert.equal(result.response.headers.has('content-length'), false);
			assert.deepEqual(
				new Uint8Array(await result.response.arrayBuffer()),
				new Uint8Array([1, 2, 3]),
			);
			await result.usagePromise;
		}
	});

	it('rejects an accepted JSON body before exposing it as audio', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"error":"provider detail"}'));
			},
			cancel() { cancelled = true; },
		});
		const result = await dispatchOpenAiAudioSpeech(
			route({
				upstreamProtocol: 'openai', upstreamOperation: 'audio.speech', adapter: 'passthrough',
				providerEndpoints: { openai: { base: 'https://openai.example/v1' } },
			}),
			request(), undefined, null, undefined,
			{ fetchImpl: async () => new Response(body, {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}) },
		);
		assert.equal(result.response.status, 502);
		assert.equal(cancelled, true);
		assert.equal(result.meta?.upstreamOutcomeUnknown, true);
		assert.equal(result.meta?.failoverForbidden, true);
		assert.equal((await result.response.text()).includes('provider detail'), false);
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
		assert.equal(empty.response.status, 502);
		assert.equal(empty.meta?.upstreamOutcomeUnknown, true);
		assert.equal(empty.meta?.failoverForbidden, true);

		const emptyStream = await dispatchOpenAiAudioSpeech(
			openAiRoute, request(), undefined, null, undefined,
			{ fetchImpl: async () => new Response('', {
				status: 200,
				headers: { 'Content-Type': 'audio/mpeg' },
			}) },
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
			{ fetchImpl: async () => new Response(brokenBody, {
				status: 200,
				headers: { 'Content-Type': 'text/event-stream' },
			}) },
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
