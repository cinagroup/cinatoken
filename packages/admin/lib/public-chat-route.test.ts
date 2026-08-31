import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextRequest } from 'next/server';
import { POST } from '../app/api/public/chat/route';

test('public chat rejects unauthenticated requests before pulling the body', async () => {
	let pulls = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1;
			controller.enqueue(new Uint8Array(1024));
		},
	}, { highWaterMark: 0 });
	const request = new Request('https://cinatoken.com/api/public/chat', {
		method: 'POST',
		body,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	const response = await POST(request as unknown as NextRequest);
	assert.equal(response.status, 401);
	assert.equal(pulls, 0);
});

test('public chat verifies a well-shaped bearer key before pulling the body', async () => {
	let pulls = 0;
	let authenticationRequests = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulls += 1;
			controller.enqueue(new Uint8Array(1024));
		},
	}, { highWaterMark: 0 });
	const request = new Request('https://cinatoken.com/api/public/chat', {
		method: 'POST',
		headers: { authorization: 'Bearer fake-but-shaped-key' },
		body,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input) => {
		authenticationRequests += 1;
		assert.equal(new Request(input).url, 'https://api.cinatoken.com/v1/me');
		return new Response('{"error":"unauthorized"}', { status: 401 });
	};
	try {
		const response = await POST(request as unknown as NextRequest);
		assert.equal(response.status, 401);
		assert.equal(authenticationRequests, 1);
		assert.equal(pulls, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test('public chat forwards a bounded body only after successful key verification', async () => {
	const calls: Request[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const outgoing = new Request(input, init);
		calls.push(outgoing);
		if (outgoing.url.endsWith('/v1/me')) return new Response('{}', { status: 200 });
		return new Response('data: [DONE]\n\n', {
			status: 200,
			headers: { 'content-type': 'text/event-stream' },
		});
	};
	try {
		const request = new Request('https://cinatoken.com/api/public/chat', {
			method: 'POST',
			headers: { authorization: 'Bearer legitimate-test-key', 'content-type': 'application/json' },
			body: JSON.stringify({ model: 'openai/gpt-5', messages: [{ role: 'user', content: 'Hello' }] }),
		});
		const response = await POST(request as unknown as NextRequest);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), 'data: [DONE]\n\n');
		assert.equal(calls.length, 2);
		assert.equal(calls[0]?.method, 'GET');
		assert.equal(calls[1]?.method, 'POST');
		assert.equal(calls[1]?.headers.get('authorization'), 'Bearer legitimate-test-key');
		assert.deepEqual(await calls[1]!.json(), {
			model: 'openai/gpt-5', messages: [{ role: 'user', content: 'Hello' }], stream: true,
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
});
