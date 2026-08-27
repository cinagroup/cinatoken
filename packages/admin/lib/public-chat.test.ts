import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
	coercePublicChatRequest,
	parsePublicChatResponseError,
	parsePublicChatResponseText,
} from './public-chat';

describe('public chat boundary', () => {
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

	it('parses only the supported text response and bounded error message', () => {
		assert.equal(parsePublicChatResponseText({ choices: [{ message: { content: 'Reply' } }] }), 'Reply');
		assert.equal(parsePublicChatResponseText({ choices: [{ message: { content: [{ type: 'text' }] } }] }), null);
		assert.equal(parsePublicChatResponseError({ error: { message: 'Denied' } }), 'Denied');
		assert.equal(parsePublicChatResponseError({ error: { message: 'x'.repeat(600) } })?.length, 500);
		assert.equal(parsePublicChatResponseError({ error: 'Denied' }), null);
	});
});
