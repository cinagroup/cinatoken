import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	AUDIO_SPEECH_MAX_REQUEST_BYTES,
	audioSpeechGuardrailBody,
	audioPricingCeilingFailureContract,
	audioTranscriptionParseFailureContract,
	audioTranscriptionRequestMediaType,
	parseAudioTranscriptionRequest,
	parseAudioSpeechRequest,
	parseSpeechRequest,
	restoreAudioSpeechAfterGuardrail,
} from './audio';
import { dashScopeMultimodalPricingCeilingFailureContract } from './dashscope-multimodal';
import { GatewayErrorCode } from '../../services/gateway-error-codes';
import {
	OPENROUTER_SPEECH_AUDIO_SENTINEL,
	OPENROUTER_SPEECH_JSON_MAX_METADATA_BYTES,
	OPENROUTER_SPEECH_REFERENCE_MAX_BASE64_BYTES,
	OPENROUTER_SPEECH_REFERENCE_MAX_DECODED_BYTES,
	OpenRouterSpeechJsonError,
	parseOpenRouterSpeechJson,
} from '../../services/egress/openrouter-speech-json';

function jsonRequest(body: unknown, signal?: AbortSignal): Request {
	return new Request('https://gateway.example/api/v1/audio/transcriptions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
		signal,
	});
}

describe('OpenRouter audio transcription request parsing', () => {
	it('accepts JSON input_audio and strips base64 from retained metadata', async () => {
		const encoded = Buffer.from([1, 2, 3, 4, 5]).toString('base64');
		const parsed = await parseAudioTranscriptionRequest(jsonRequest({
			model: 'openai/whisper-1',
			input_audio: { data: encoded, format: 'wav' },
			language: 'EN',
			temperature: 0.25,
			response_format: 'verbose_json',
			timestamp_granularities: ['segment', 'word'],
			provider: {
				order: ['groq'],
				options: { groq: { prompt: 'Expected vocabulary', custom_flag: true } },
			},
		}));

		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual([...parsed.transcription.file!.bytes], [1, 2, 3, 4, 5]);
		assert.equal(parsed.transcription.file!.filename, 'audio.wav');
		assert.equal(parsed.transcription.file!.mimeType, 'audio/wav');
		assert.equal(parsed.transcription.language, 'en');
		assert.deepEqual(parsed.transcription.extra, {
			'timestamp_granularities[]': ['segment', 'word'],
		});
		assert.deepEqual(parsed.transcription.providerOptions, {
			groq: { prompt: 'Expected vocabulary', custom_flag: true },
		});
		assert.deepEqual(parsed.routingBody.provider, { order: ['groq'] });
		assert.equal(JSON.stringify(parsed.routingBody).includes(encoded), false);
		assert.equal(JSON.stringify(parsed.transcription.providerOptions).includes(encoded), false);
	});

	it('accepts OpenAI-compatible multipart with a bounded file', async () => {
		const form = new FormData();
		form.append('model', 'openai/whisper-1');
		form.append('file', new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/mpeg' }), 'clip.mp3');
		form.append('language', 'en');
		form.append('response_format', 'json');
		form.append('timestamp_granularities[]', 'word');
		const parsed = await parseAudioTranscriptionRequest(new Request(
			'https://gateway.example/v1/audio/transcriptions',
			{ method: 'POST', body: form },
		));

		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual([...parsed.transcription.file!.bytes], [9, 8, 7]);
		assert.equal(parsed.transcription.file!.filename, 'clip.mp3');
		assert.deepEqual(parsed.transcription.extra, { 'timestamp_granularities[]': ['word'] });
	});

	it('rejects body session_id for both JSON and multipart requests', async () => {
		const json = await parseAudioTranscriptionRequest(jsonRequest({
			model: 'openai/whisper-1',
			input_audio: { data: 'AQID', format: 'wav' },
			session_id: 'body-session',
		}));
		assert.equal(json.ok, false);
		if (!json.ok) assert.match(json.error, /use x-session-id/u);

		const form = new FormData();
		form.append('model', 'openai/whisper-1');
		form.append('session_id', 'body-session');
		form.append('file', new Blob([new Uint8Array([9, 8, 7])], { type: 'audio/mpeg' }), 'clip.mp3');
		const multipart = await parseAudioTranscriptionRequest(new Request(
			'https://gateway.example/v1/audio/transcriptions',
			{ method: 'POST', body: form },
		));
		assert.equal(multipart.ok, false);
		if (!multipart.ok) assert.match(multipart.error, /use x-session-id/u);
	});

	it('rejects invalid base64, data URIs, unsupported formats, and non-OpenRouter response formats', async () => {
		const cases: Array<[unknown, RegExp]> = [
			[
				{ model: 'm', input_audio: { data: '%%%=', format: 'wav' } },
				/not valid base64/,
			],
			[
				{ model: 'm', input_audio: { data: 'data:audio/wav;base64,AQID', format: 'wav' } },
				/not valid base64/,
			],
			[
				{ model: 'm', input_audio: { data: 'AQID', format: 'exe' } },
				/input_audio\.format/,
			],
			[
				{ model: 'm', input_audio: { data: 'AQID', format: 'wav' }, response_format: 'text' },
				/response_format/,
			],
		];
		for (const [body, expected] of cases) {
			const parsed = await parseAudioTranscriptionRequest(jsonRequest(body));
			assert.equal(parsed.ok, false);
			if (parsed.ok) continue;
			assert.match(parsed.error, expected);
		}
	});

	it('rejects decoded audio and metadata beyond caller-supplied hard limits', async () => {
		const decodedTooLarge = await parseAudioTranscriptionRequest(
			jsonRequest({ model: 'm', input_audio: { data: 'AQID', format: 'wav' } }),
			{ maxDecodedBytes: 2, maxMetadataBytes: 1024, maxRequestBytes: 2048 },
		);
		assert.equal(decodedTooLarge.ok, false);
		if (!decodedTooLarge.ok) assert.equal(decodedTooLarge.kind, 'payload_too_large');

		const metadataTooLarge = await parseAudioTranscriptionRequest(
			jsonRequest({
				model: 'm',
				input_audio: { data: 'AQID', format: 'wav' },
				prompt: 'x'.repeat(256),
			}),
			{ maxDecodedBytes: 32, maxMetadataBytes: 64, maxRequestBytes: 1024 },
		);
		assert.equal(metadataTooLarge.ok, false);
		if (!metadataTooLarge.ok) assert.equal(metadataTooLarge.kind, 'payload_too_large');
	});

	it('counts the metadata ceiling in UTF-8 bytes and rejects malformed UTF-8 as JSON', async () => {
		const limits = { maxDecodedBytes: 32, maxMetadataBytes: 120, maxRequestBytes: 1024 };
		const ascii = await parseAudioTranscriptionRequest(jsonRequest({
			model: 'm',
			input_audio: { data: 'AQID', format: 'wav' },
			prompt: 'x'.repeat(10),
		}), limits);
		assert.equal(ascii.ok, true);

		const multibyte = await parseAudioTranscriptionRequest(jsonRequest({
			model: 'm',
			input_audio: { data: 'AQID', format: 'wav' },
			prompt: '界'.repeat(10),
		}), limits);
		assert.equal(multibyte.ok, false);
		if (!multibyte.ok) assert.equal(multibyte.kind, 'payload_too_large');

		const encoder = new TextEncoder();
		const prefix = encoder.encode('{"model":"m","input_audio":{"data":"AQID","format":"wav"},"prompt":"');
		const suffix = encoder.encode('"}');
		const malformed = new Uint8Array(prefix.byteLength + 1 + suffix.byteLength);
		malformed.set(prefix);
		malformed[prefix.byteLength] = 0xff;
		malformed.set(suffix, prefix.byteLength + 1);
		const invalidUtf8 = await parseAudioTranscriptionRequest(new Request(
			'https://gateway.example/api/v1/audio/transcriptions',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: malformed,
			},
		));
		assert.equal(invalidUtf8.ok, false);
		if (!invalidUtf8.ok) assert.equal(invalidUtf8.kind, 'invalid_json');
	});

	it('cancels a pending streamed JSON read immediately', async () => {
		const controller = new AbortController();
		let streamCancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode(
					'{"model":"m","input_audio":{"data":"AQ',
				));
			},
			cancel() {
				streamCancelled = true;
			},
		});
		const init: RequestInit & { duplex: 'half' } = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: stream,
			signal: controller.signal,
			duplex: 'half',
		};
		const pending = parseAudioTranscriptionRequest(new Request(
			'https://gateway.example/api/v1/audio/transcriptions',
			init,
		));
		controller.abort();
		const parsed = await pending;
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.equal(parsed.kind, 'cancelled');
		assert.equal(streamCancelled, true);
	});
});

describe('audio transcription Content-Type dispatch', () => {
	it('accepts JSON and multipart and rejects missing/ambiguous types', () => {
		assert.deepEqual(audioTranscriptionRequestMediaType('application/json; charset=utf-8'), {
			ok: true, value: 'json',
		});
		assert.deepEqual(audioTranscriptionRequestMediaType('multipart/form-data; boundary=abc'), {
			ok: true, value: 'multipart',
		});
		assert.equal(audioTranscriptionRequestMediaType('multipart/form-data').ok, false);
		assert.equal(audioTranscriptionRequestMediaType(null).ok, false);
		assert.equal(audioTranscriptionRequestMediaType('text/plain').ok, false);
	});
});

describe('audio transcription parser error contract', () => {
	it('maps bounded payload rejection to the OpenRouter 413 contract', () => {
		assert.deepEqual(audioTranscriptionParseFailureContract('payload_too_large'), {
			status: 413,
			code: GatewayErrorCode.payloadTooLarge,
		});
		assert.deepEqual(audioTranscriptionParseFailureContract('invalid_json'), {
			status: 400,
			code: GatewayErrorCode.invalidJson,
		});
	});
});

describe('OpenRouter speech request contract', () => {
	const validRequest = {
		model: 'openai/gpt-4o-mini-tts',
		input: 'Hello',
		voice: 'alloy',
	};

	it('defaults response_format to pcm and accepts the two public formats', () => {
		const defaulted = parseSpeechRequest(validRequest);
		assert.equal(defaulted.ok, true);
		if (defaulted.ok) assert.equal(defaulted.speech.responseFormat, 'pcm');

		for (const responseFormat of ['mp3', 'pcm']) {
			const parsed = parseSpeechRequest({ ...validRequest, response_format: responseFormat });
			assert.equal(parsed.ok, true, responseFormat);
			if (parsed.ok) assert.equal(parsed.speech.responseFormat, responseFormat);
		}
	});

	it('rejects legacy formats and non-string response_format values', () => {
		for (const responseFormat of ['wav', 'flac', 'opus', 'aac', '', null, 7]) {
			const parsed = parseSpeechRequest({ ...validRequest, response_format: responseFormat });
			assert.equal(parsed.ok, false, String(responseFormat));
			if (!parsed.ok) assert.match(parsed.error, /mp3.*pcm/u);
		}
	});

	it('parses provider.options separately from routing controls with bounded nested JSON', () => {
		const parsed = parseSpeechRequest({
			...validRequest,
			provider: {
				order: ['azure'],
				options: {
					azure: { style: 'cheerful', styledegree: 1.2 },
					minimax: {
						voice_setting: { emotion: 'happy' },
						pronunciation_dict: { tone: ['处理/(chu3)(li3)'] },
					},
				},
			},
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.deepEqual(parsed.routingProvider, { order: ['azure'] });
		assert.deepEqual(parsed.speech.providerOptions, {
			azure: { style: 'cheerful', styledegree: 1.2 },
			minimax: {
				voice_setting: { emotion: 'happy' },
				pronunciation_dict: { tone: ['处理/(chu3)(li3)'] },
			},
		});
	});

	it('accepts an omitted provider-dependent voice and requires numeric speed', () => {
		const withoutVoice = parseSpeechRequest({ model: validRequest.model, input: validRequest.input });
		assert.equal(withoutVoice.ok, true);
		if (withoutVoice.ok) assert.equal(withoutVoice.speech.voice, undefined);

		for (const body of [
			{ ...validRequest, voice: { id: 'alloy' } },
			{ ...validRequest, speed: '1.2' },
			{ ...validRequest, speed: null },
		]) {
			assert.equal(parseSpeechRequest(body).ok, false);
		}
	});

	it('rejects provider options beyond the structural and byte ceilings', () => {
		let nested: unknown = true;
		for (let depth = 0; depth < 8; depth += 1) nested = { child: nested };
		const tooDeep = parseSpeechRequest({
			...validRequest,
			provider: { options: { openai: { nested } } },
		});
		assert.equal(tooDeep.ok, false);
		if (!tooDeep.ok) assert.match(tooDeep.error, /nesting limit/u);

		const tooLarge = parseSpeechRequest({
			...validRequest,
			provider: { options: { openai: {
				a: 'a'.repeat(4096), b: 'b'.repeat(4096), c: 'c'.repeat(4096),
				d: 'd'.repeat(4096), e: 'e'.repeat(4096), f: 'f'.repeat(4096),
				g: 'g'.repeat(4096), h: 'h'.repeat(4096), i: 'i'.repeat(4096),
				j: 'j'.repeat(4096), k: 'k'.repeat(4096), l: 'l'.repeat(4096),
				m: 'm'.repeat(4096), n: 'n'.repeat(4096), o: 'o'.repeat(4096),
				p: 'p'.repeat(4096), q: 'q'.repeat(4096),
			} } },
		});
		assert.equal(tooLarge.ok, false);
		if (!tooLarge.ok) assert.match(tooLarge.error, /at most 65536 bytes/u);
	});

	it('projects provider option text through Guardrails and restores the public shape', () => {
		const parsed = parseSpeechRequest({
			...validRequest,
			instructions: 'say secret',
			provider: {
				only: ['openai'],
				options: { openai: { instructions: 'warm secret voice' } },
			},
		});
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		const projected = audioSpeechGuardrailBody(parsed);
		assert.deepEqual(projected.instructions, {
			top_level: 'say secret',
			provider_options: { openai: { instructions: 'warm secret voice' } },
			reference_text: null,
		});
		const restored = restoreAudioSpeechAfterGuardrail(parsed, {
			...projected,
			input: 'Hello [REDACTED:secret]',
			instructions: {
				top_level: 'say [REDACTED:secret]',
				provider_options: {
					openai: { instructions: 'warm [REDACTED:secret] voice' },
				},
				reference_text: null,
			},
			provider: { only: ['openai'], zdr: true },
		});
		assert.equal(restored.ok, true);
		if (!restored.ok) return;
		assert.equal(restored.speech.input, 'Hello [REDACTED:secret]');
		assert.equal(restored.speech.instructions, 'say [REDACTED:secret]');
		assert.deepEqual(restored.speech.providerOptions, {
			openai: { instructions: 'warm [REDACTED:secret] voice' },
		});
		assert.deepEqual(restored.routingBody.provider, { only: ['openai'], zdr: true });
	});

	it('bounds the streamed TTS JSON body and rejects invalid media types', async () => {
		const accepted = await parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(validRequest),
			},
		));
		assert.equal(accepted.ok, true);

		const oversized = await parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ ...validRequest, ignored: 'x'.repeat(256) }),
			},
		), 128);
		assert.equal(oversized.ok, false);
		if (!oversized.ok) assert.equal(oversized.kind, 'payload_too_large');

		const wrongType = await parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			{ method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' },
		));
		assert.equal(wrongType.ok, false);
		if (!wrongType.ok) assert.equal(wrongType.kind, 'invalid_request');
		assert.equal(
			AUDIO_SPEECH_MAX_REQUEST_BYTES,
			OPENROUTER_SPEECH_REFERENCE_MAX_BASE64_BYTES + OPENROUTER_SPEECH_JSON_MAX_METADATA_BYTES,
		);
	});

	it('streams stateless voice-cloning references without retaining base64 metadata', async () => {
		const parsed = await parseAudioSpeechRequest(jsonRequest({
			model: 'vendor/clone-tts',
			input: 'Hello',
			input_references: [
				{ type: 'input_audio', input_audio: { data: 'data:audio/wav;base64,AQID' } },
				{ type: 'text', text: 'secret reference transcript' },
			],
		}));
		assert.equal(parsed.ok, true);
		if (!parsed.ok) return;
		assert.equal(parsed.speech.voice, undefined);
		assert.equal(parsed.speech.inputReferences?.[0]?.type, 'input_audio');
		const audio = parsed.speech.inputReferences?.[0];
		if (audio?.type !== 'input_audio') return;
		assert.deepEqual([...audio.inputAudio.bytes], [1, 2, 3]);
		assert.deepEqual(audio.inputAudio.encoding, { kind: 'data_uri', mediaType: 'audio/wav' });
		assert.deepEqual(parsed.speech.inputReferences?.[1], {
			type: 'text', text: 'secret reference transcript',
		});

		const projected = audioSpeechGuardrailBody(parsed);
		assert.equal(JSON.stringify(projected).includes('AQID'), false);
		assert.equal(
			(projected.instructions as Record<string, unknown>).reference_text,
			'secret reference transcript',
		);
		const restored = restoreAudioSpeechAfterGuardrail(parsed, {
			...projected,
			instructions: {
				...(projected.instructions as Record<string, unknown>),
				reference_text: '[REDACTED:secret] reference transcript',
			},
		});
		assert.equal(restored.ok, true);
		if (!restored.ok) return;
		assert.equal(JSON.stringify(restored.routingBody).includes('AQID'), false);
		assert.deepEqual(restored.speech.inputReferences?.[1], {
			type: 'text', text: '[REDACTED:secret] reference transcript',
		});
		const restoredAudio = restored.speech.inputReferences?.[0];
		assert.equal(restoredAudio?.type, 'input_audio');
		if (restoredAudio?.type === 'input_audio') {
			assert.deepEqual([...restoredAudio.inputAudio.bytes], [1, 2, 3]);
		}
	});

	it('parses raw and chunk-split clone audio and enforces independent audio limits', async () => {
		const chunks = [
			'{"model":"vendor/clone-tts","input":"Hello","input_references":[{"type":"input_audio","input_audio":{"data":"d',
			'ata:audio/wav;base64,AQ',
			'ID"}}]}',
		];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		});
		const split = await parseOpenRouterSpeechJson(new Request(
			'https://gateway.example/v1/audio/speech',
			{
				method: 'POST', headers: { 'Content-Type': 'application/json' },
				body: stream, duplex: 'half',
			} as RequestInit & { duplex: 'half' },
		));
		assert.deepEqual([...split.referenceAudio!.bytes], [1, 2, 3]);
		assert.deepEqual(split.referenceAudio!.encoding, { kind: 'data_uri', mediaType: 'audio/wav' });
		assert.equal(
			((split.body.input_references as Array<Record<string, unknown>>)[0]!.input_audio as Record<string, unknown>).data,
			OPENROUTER_SPEECH_AUDIO_SENTINEL,
		);

		const raw = await parseOpenRouterSpeechJson(jsonRequest({
			model: 'vendor/clone-tts', input: 'Hello',
			input_references: [{ type: 'input_audio', input_audio: { data: 'AQID' } }],
		}));
		assert.deepEqual([...raw.referenceAudio!.bytes], [1, 2, 3]);
		assert.deepEqual(raw.referenceAudio!.encoding, { kind: 'raw_base64' });

		for (const limits of [
			{ maxBase64Bytes: 3, maxDecodedBytes: 8, maxMetadataBytes: 1024, maxRequestBytes: 2048 },
			{ maxBase64Bytes: 8, maxDecodedBytes: 2, maxMetadataBytes: 1024, maxRequestBytes: 2048 },
		]) {
			await assert.rejects(
				() => parseOpenRouterSpeechJson(jsonRequest({
					model: 'vendor/clone-tts', input: 'Hello',
					input_references: [{ type: 'input_audio', input_audio: { data: 'AQID' } }],
				}), limits),
				(error: unknown) => error instanceof OpenRouterSpeechJsonError
					&& error.kind === 'invalid_request',
			);
		}
		assert.equal(OPENROUTER_SPEECH_REFERENCE_MAX_DECODED_BYTES, 15 * 1024 * 1024);
	});

	it('rejects malformed or ambiguous stateless voice-cloning references', async () => {
		const cases: Array<[unknown, RegExp]> = [
			[
				{ model: 'm', input: 'Hello', input_references: [{ type: 'text', text: 'only text' }] },
				/exactly one input_audio/,
			],
			[
				{ model: 'm', input: 'Hello', input_references: [
					{ type: 'input_audio', input_audio: { data: 'AQID' } },
					{ type: 'input_audio', input_audio: { data: 'BAUG' } },
				] },
				/at most one input_audio/,
			],
			[
				{ model: 'm', input: 'Hello', input_references: [
					{ type: 'input_audio', input_audio: { data: 'AQ=Z' } },
				] },
				/not valid base64/,
			],
			[
				{ model: 'm', input: 'Hello', input_references: [
					{ type: 'input_audio', input_audio: { data: 'data:video/mp4;base64,AQID' } },
				] },
				/data URI must use data:audio/,
			],
		];
		for (const [body, expected] of cases) {
			const parsed = await parseAudioSpeechRequest(jsonRequest(body));
			assert.equal(parsed.ok, false);
			if (!parsed.ok) assert.match(parsed.error, expected);
		}
	});

	it('rejects malformed TTS UTF-8 and normalizes invalid caller limits safely', async () => {
		const invalidUtf8 = await parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: new Uint8Array([0x7b, 0x22, 0x69, 0x6e, 0x70, 0x75, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
			},
		));
		assert.equal(invalidUtf8.ok, false);
		if (!invalidUtf8.ok) assert.equal(invalidUtf8.kind, 'invalid_json');

		const acceptedWithInvalidLimit = await parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			{
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(validRequest),
			},
		), Number.NaN);
		assert.equal(acceptedWithInvalidLimit.ok, true);
	});

	it('cancels a pending streamed TTS JSON read immediately', async () => {
		const controller = new AbortController();
		let streamCancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode(
					'{"model":"vendor/tts","input":"hel',
				));
			},
			cancel() {
				streamCancelled = true;
			},
		});
		const init: RequestInit & { duplex: 'half' } = {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: stream,
			signal: controller.signal,
			duplex: 'half',
		};
		const pending = parseAudioSpeechRequest(new Request(
			'https://gateway.example/v1/audio/speech',
			init,
		));
		controller.abort();
		const parsed = await pending;
		assert.equal(parsed.ok, false);
		if (!parsed.ok) assert.equal(parsed.kind, 'cancelled');
		assert.equal(streamCancelled, true);
	});
});

describe('multimedia pricing ceiling error contracts', () => {
	it('fails HTTP Audio closed with 502 when route pricing cannot prove a ceiling', () => {
		assert.deepEqual(audioPricingCeilingFailureContract(null), {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: 'Audio pricing cannot prove a finite charged-cost ceiling for every eligible route',
		});
		assert.equal(audioPricingCeilingFailureContract(0), null);
		assert.equal(audioPricingCeilingFailureContract(0.25), null);
	});

	it('fails DashScope multimodal closed with 502 when route pricing cannot prove a ceiling', () => {
		assert.deepEqual(dashScopeMultimodalPricingCeilingFailureContract(null), {
			status: 502,
			code: GatewayErrorCode.routeResolutionFailed,
			message: 'DashScope multimodal pricing cannot prove a finite charged-cost ceiling for every eligible route',
		});
		assert.equal(dashScopeMultimodalPricingCeilingFailureContract(0), null);
		assert.equal(dashScopeMultimodalPricingCeilingFailureContract(0.25), null);
	});
});
