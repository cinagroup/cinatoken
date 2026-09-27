import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';
import { Hono } from 'hono';
import type { AdminEnv } from '../../admin-env';
import { adminPlaygroundRoutes } from '../../routes/admin/playground';

function routeRepositories(): AdminEnv['Variables']['repositories'] {
	return {
		routes: {
			async getModelRouteRowById(id: string) {
				return {
					id, model_id: 'synthetic-model', provider_id: 'synthetic-provider',
					provider_model_name: 'synthetic-model', priority: 0, status: 'active',
					route_group: 'default', weight: 1, price_override: null,
					custom_params: null, upstream_protocol: 'openai', upstream_operation: 'chat',
					adapter: 'passthrough',
				};
			},
		},
		providers: {
			async getProvidersByIds() {
				return [{
					id: 'synthetic-provider', name: 'Synthetic', api_key: 'synthetic-key',
					status: 'active', description: null, created_at: '2026-09-25',
					endpoints: JSON.stringify({ openai: { base: 'https://api.example.com/v1' } }),
				}];
			},
		},
		models: {
			async getModelDetailWithRouteCounts() { return null; },
		},
	} as unknown as AdminEnv['Variables']['repositories'];
}

it('does not replay a Playground provider POST through a browser-visible 307 or 308', async (t) => {
	const app = new Hono<AdminEnv>();
	app.use('*', async (c, next) => {
		c.set('principal', { type: 'console', id: 'console:test', username: 'test' });
		c.set('repositories', routeRepositories());
		await next();
	});
	let rawRedirectStatus = 307;
	let rawPosts = 0;
	app.post('/unsafe', async c => {
		rawPosts += 1;
		assert.deepEqual(await c.req.json(), { round: 'trip' });
		if (rawPosts === 1) {
			return new Response(null, { status: rawRedirectStatus, headers: { Location: '/unsafe' } });
		}
		return c.json({ ok: true });
	});
	app.route('/admin/playground', adminPlaygroundRoutes);

	const server = createServer(async (incoming, outgoing) => {
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
			const body = Buffer.concat(chunks);
			const address = server.address() as AddressInfo;
			const request = new Request(`http://127.0.0.1:${address.port}${incoming.url}`, {
				method: incoming.method,
				headers: incoming.headers as HeadersInit,
				body: body.length > 0 ? body : undefined,
			});
			const response = await app.fetch(request);
			outgoing.writeHead(response.status, Object.fromEntries(response.headers));
			outgoing.end(Buffer.from(await response.arrayBuffer()));
		} catch (error) {
			outgoing.writeHead(500);
			outgoing.end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>(resolve => server.close(() => resolve()));
	});
	const address = server.address() as AddressInfo;
	const browserUrl = `http://127.0.0.1:${address.port}/admin/playground`;
	const originalFetch = globalThis.fetch;
	t.after(() => { globalThis.fetch = originalFetch; });
	for (const status of [307, 308]) {
		// A real browser-style fetch preserves the POST body when this response
		// is forwarded without the Playground boundary below.
		rawRedirectStatus = status;
		rawPosts = 0;
		const unsafe = await originalFetch(`http://127.0.0.1:${address.port}/unsafe`, {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ round: 'trip' }),
		});
		assert.equal(unsafe.status, 200);
		assert.equal(rawPosts, 2);

		let providerPosts = 0;
		globalThis.fetch = async (input, init) => {
			if (!String(input).startsWith('https://api.example.com/')) return originalFetch(input, init);
			providerPosts += 1;
			assert.equal(init?.method, 'POST');
			assert.equal(init?.redirect, 'manual');
			return new Response('provider redirect', {
				status, headers: { Location: '/admin/playground' },
			});
		};
		const result = await originalFetch(browserUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ routeId: 'synthetic-route', body: { messages: [] } }),
		});
		assert.equal(result.status, 502);
		assert.equal(result.headers.get('location'), null);
		assert.equal(providerPosts, 1);
		assert.match(await result.text(), /redirect/i);
	}
});
