import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	coercePublicChatRequest,
	parsePublicChatResponseError,
	parsePublicChatResponseText,
	parsePublicChatStoredSession,
	PublicChatBodyTooLargeError,
	PublicChatSseDecoder,
	readPublicChatBodyWithinLimit,
} from './public-chat';

describe('public chat boundary', () => {
	it('reads chunked bodies only up to the raw-byte ceiling', async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('1234'));
				controller.enqueue(new TextEncoder().encode('56789'));
			},
			cancel() { cancelled = true; },
		});
		await assert.rejects(
			() => readPublicChatBodyWithinLimit(new Request('https://example.test', {
				method: 'POST', body, duplex: 'half',
			} as RequestInit & { duplex: 'half' }), 8),
			PublicChatBodyTooLargeError,
		);
		assert.equal(cancelled, true);
	});

	it('accepts the exact byte boundary and rejects false or invalid length declarations', async () => {
		assert.equal(await readPublicChatBodyWithinLimit(new Request('https://example.test', {
			method: 'POST', body: 'éé', headers: { 'content-length': '4' },
		}), 4), 'éé');
		await assert.rejects(() => readPublicChatBodyWithinLimit(new Request('https://example.test', {
			method: 'POST', body: 'small', headers: { 'content-length': '999' },
		}), 8), PublicChatBodyTooLargeError);
		await assert.rejects(() => readPublicChatBodyWithinLimit(new Request('https://example.test', {
			method: 'POST', body: 'small', headers: { 'content-length': 'not-a-number' },
		}), 8), PublicChatBodyTooLargeError);
	});

	it('rejects malformed UTF-8 instead of normalizing bytes before JSON parsing', async () => {
		const body = new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]);
		await assert.rejects(() => readPublicChatBodyWithinLimit(new Request('https://example.test', {
			method: 'POST', body,
		}), 32), TypeError);
	});

	it('returns a minimal sanitized request', () => {
		assert.deepEqual(coercePublicChatRequest({
			model: ' vendor/model ',
			messages: [{ role: 'user', content: 'Hello', ignored: 'value' }],
			stream: true,
			provider: { secret: 'must-not-cross-boundary' },
		}), {
			model: 'vendor/model',
			messages: [{ role: 'user', content: 'Hello' }],
		});
	});

	it('rejects malformed, empty, or excessive requests', () => {
		assert.equal(coercePublicChatRequest(null), null);
		assert.equal(coercePublicChatRequest({ model: '', messages: [] }), null);
		assert.equal(coercePublicChatRequest({ model: 'model', messages: [{ role: 'tool', content: 'x' }] }), null);
		assert.equal(coercePublicChatRequest({ model: 'model', messages: [{ role: 'user', content: ' ' }] }), null);
		assert.equal(coercePublicChatRequest({ model: 'model', messages: [{ role: 'user', content: 'x'.repeat(100_001) }] }), null);
		assert.equal(coercePublicChatRequest({ model: 'x'.repeat(181), messages: [{ role: 'user', content: 'x' }] }), null);
	});

	it('accepts bounded image data URLs and strips unsupported part fields', () => {
		assert.deepEqual(coercePublicChatRequest({
			model: 'vision/model',
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'Describe this image', ignored: true },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low', ignored: true } },
				],
			}],
		}), {
			model: 'vision/model',
			messages: [{
				role: 'user',
				content: [
					{ type: 'text', text: 'Describe this image' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=', detail: 'low' } },
				],
			}],
		});
	});

	it('rejects remote images, non-user multimodal content, and excessive image counts', () => {
		assert.equal(coercePublicChatRequest({
			model: 'vision/model',
			messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }] }],
		}), null);
		assert.equal(coercePublicChatRequest({
			model: 'vision/model',
			messages: [{ role: 'assistant', content: [{ type: 'text', text: 'no' }] }],
		}), null);
		assert.equal(coercePublicChatRequest({
			model: 'vision/model',
			messages: [{
				role: 'user',
				content: Array.from({ length: 5 }, () => ({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } })),
			}],
		}), null);
		assert.equal(coercePublicChatRequest({
			model: 'vision/model',
			messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }],
		}), null);
	});

	it('parses only the supported text response and bounded error message', () => {
		assert.equal(parsePublicChatResponseText({ choices: [{ message: { content: 'Reply' } }] }), 'Reply');
		assert.equal(parsePublicChatResponseText({ choices: [{ message: { content: [{ type: 'text' }] } }] }), null);
		assert.equal(parsePublicChatResponseError({ error: { message: 'Denied' } }), 'Denied');
		assert.equal(parsePublicChatResponseError({ error: { message: 'x'.repeat(600) } })?.length, 500);
		assert.equal(parsePublicChatResponseError({ error: 'Denied' }), null);
	});
});

describe('public chat SSE decoder', () => {
	it('decodes text across arbitrary network chunks and recognizes DONE', () => {
		const decoder = new PublicChatSseDecoder();
		assert.deepEqual(decoder.push('data: {"choices":[{"delta":{"content":"Hel'), []);
		assert.deepEqual(decoder.push('lo"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":[{"type":"text","text":"!"}]}}]}\n\n'), [
			{ type: 'text', text: 'Hello' },
			{ type: 'text', text: '!' },
		]);
		assert.deepEqual(decoder.push('data: [DONE]\n\n'), [{ type: 'done' }]);
		assert.deepEqual(decoder.finish(), []);
	});

	it('surfaces structured upstream and malformed stream errors', () => {
		const upstream = new PublicChatSseDecoder();
		assert.deepEqual(upstream.push('data: {"error":{"message":"Denied"}}\n\n'), [{ type: 'error', message: 'Denied' }]);
		const malformed = new PublicChatSseDecoder();
		assert.deepEqual(malformed.push('data: nope\n\n'), [{ type: 'error', message: 'The gateway returned an invalid stream event.' }]);
	});
});

describe('public chat local session boundary', () => {
	it('restores only bounded text messages and never accepts stored secrets or attachments', () => {
		assert.deepEqual(parsePublicChatStoredSession(JSON.stringify({
			version: 1,
			modelId: ' vendor/model ',
			apiKey: 'must-be-ignored',
			messages: [{ role: 'user', content: 'Hello', attachments: [{ dataUrl: 'secret' }] }],
		})), {
			version: 1,
			modelId: 'vendor/model',
			messages: [{ role: 'user', content: 'Hello' }],
		});
		assert.equal(parsePublicChatStoredSession('{'), null);
		assert.equal(parsePublicChatStoredSession(JSON.stringify({ version: 2, modelId: 'm', messages: [] })), null);
		assert.equal(parsePublicChatStoredSession(JSON.stringify({ version: 1, modelId: 'm', messages: [{ role: 'system', content: 'x' }] })), null);
	});
});
