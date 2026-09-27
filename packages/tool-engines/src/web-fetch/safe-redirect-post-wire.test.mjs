import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { once } from 'node:events';
import { fetchWithSafeRedirects, UnsafeFetchDestinationError } from './safe-redirect-fetch.ts';

const originRequests = [];
const targetRequests = [];
const originServer = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	originRequests.push({ method: request.method, body: Buffer.concat(chunks).toString('utf8') });
	const status = Number(new URL(request.url, 'http://local.invalid').searchParams.get('status'));
	response.writeHead(status, { Location: 'https://download-target.example/result' });
	response.end();
});
const targetServer = createServer(async (request, response) => {
	const chunks = [];
	for await (const chunk of request) chunks.push(chunk);
	targetRequests.push({ method: request.method, body: Buffer.concat(chunks).toString('utf8') });
	response.writeHead(200, { 'Content-Type': 'text/plain' });
	response.end('download');
});

for (const server of [originServer, targetServer]) {
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
}
after(async () => {
	await Promise.all([originServer, targetServer].map(server => new Promise(resolve => server.close(resolve))));
});

const localUrl = server => `http://127.0.0.1:${server.address().port}`;
const mappedFetch = (input, init) => {
	const url = new URL(input);
	if (url.hostname === 'download-origin.example') return fetch(`${localUrl(originServer)}${url.pathname}${url.search}`, init);
	if (url.hostname === 'download-target.example') return fetch(`${localUrl(targetServer)}${url.pathname}${url.search}`, init);
	throw new Error(`Unexpected network destination: ${url.hostname}`);
};

for (const status of [307, 308]) {
	test(`safe redirect helper never resends an already received POST after HTTP ${status}`, async () => {
		const beforeOrigin = originRequests.length;
		const beforeTarget = targetRequests.length;
		let rejection;
		try {
			await fetchWithSafeRedirects(`https://download-origin.example/result?status=${status}`, {
				fetchImpl: mappedFetch,
				init: { method: 'POST', body: 'paid-request' },
				requireHttps: true,
			});
		} catch (error) { rejection = error; }
		assert.deepEqual(targetRequests.slice(beforeTarget), []);
		assert.equal(originRequests.length, beforeOrigin);
		assert.ok(rejection instanceof UnsafeFetchDestinationError);
	});

	test(`safe redirect helper retains a bodyless GET download across HTTP ${status}`, async () => {
		const beforeOrigin = originRequests.length;
		const beforeTarget = targetRequests.length;
		const result = await fetchWithSafeRedirects(`https://download-origin.example/result?status=${status}`, {
			fetchImpl: mappedFetch,
			init: { method: 'GET' },
			requireHttps: true,
		});
		assert.equal(await result.response.text(), 'download');
		assert.equal(result.redirects, 1);
		assert.equal(originRequests.length, beforeOrigin + 1);
		assert.equal(targetRequests.length, beforeTarget + 1);
		assert.deepEqual(originRequests.at(-1), { method: 'GET', body: '' });
		assert.deepEqual(targetRequests.at(-1), { method: 'GET', body: '' });
	});
}

test('invalid redirect limits fail before any physical GET', async () => {
	const beforeOrigin = originRequests.length;
	const beforeTarget = targetRequests.length;
	for (const maxRedirects of [NaN, Infinity, -1, 1.5]) {
		await assert.rejects(() => fetchWithSafeRedirects('https://download-origin.example/result?status=307', {
			fetchImpl: mappedFetch,
			maxRedirects,
		}), UnsafeFetchDestinationError);
	}
	assert.equal(originRequests.length, beforeOrigin);
	assert.equal(targetRequests.length, beforeTarget);
});
