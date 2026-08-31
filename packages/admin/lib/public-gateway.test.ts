import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fetchPublicGateway, resolvePublicApiOrigin } from './public-gateway';

describe('public gateway transport', () => {
	it('uses the Cloudflare service binding and preserves request details', async () => {
		const captured: Request[] = [];
		const service: Pick<Fetcher, 'fetch'> = {
			fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
				captured.push(new Request(request, init));
				return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
			},
		};

		const response = await fetchPublicGateway('/catalog/models?kind=llm', {
			method: 'POST',
			headers: { authorization: 'Bearer test-secret' },
			body: '{}',
			next: { revalidate: 60 },
		}, { env: { CINATOKEN_PROXY_SERVICE: service } });

		assert.equal(response.status, 200);
		assert.equal(captured.length, 1);
		const sent = captured[0]!;
		assert.equal(sent.url, 'https://api.cinatoken.com/catalog/models?kind=llm');
		assert.equal(sent.method, 'POST');
		assert.equal(sent.headers.get('authorization'), 'Bearer test-secret');
		assert.equal(await sent.text(), '{}');
	});

	it('rejects scheme-relative paths and credentials in public origins', async () => {
		assert.equal(resolvePublicApiOrigin('https://user:secret@gateway.example'), 'https://api.cinatoken.com');
		await assert.rejects(() => fetchPublicGateway('//attacker.example/catalog'), /absolute-path/);
	});
});
