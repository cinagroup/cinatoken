import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Hono } from 'hono';
import type { Env } from '../app';
import {
	assignGenerationId,
	createGenerationId,
	GENERATION_ID_HEADER,
} from './generation-id';

describe('generation id middleware', () => {
	it('uses an OpenRouter-shaped cryptographically random identifier', () => {
		const first = createGenerationId();
		const second = createGenerationId();
		assert.match(first, /^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
		assert.notEqual(first, second);
	});

	it('reuses the route generation id in the response header without buffering a stream', async () => {
		const app = new Hono<Env>();
		app.use('*', assignGenerationId);
		app.get('/stream', (c) => {
			const expected = c.get('generationId');
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(expected));
					controller.close();
				},
			});
			return new Response(stream, { headers: { 'Content-Type': 'text/plain' } });
		});

		const response = await app.request('/stream');
		const header = response.headers.get(GENERATION_ID_HEADER);
		assert.ok(header);
		assert.equal(await response.text(), header);
	});
});
