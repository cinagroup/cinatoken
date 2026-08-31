import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	audioPricingCeilingFailureContract,
	audioTranscriptionParseFailureContract,
	audioTranscriptionRequestMediaType,
	parseAudioTranscriptionRequest,
} from './audio';
import { dashScopeMultimodalPricingCeilingFailureContract } from './dashscope-multimodal';
import { GatewayErrorCode } from '../../services/gateway-error-codes';

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
