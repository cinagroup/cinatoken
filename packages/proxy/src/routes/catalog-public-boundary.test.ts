import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import type { GatewayRepositories } from '@octafuse/core';
import type { CatalogBffResource } from '../../../admin/lib/public-catalog-bff';
import { createCatalogRoutes, type CatalogEnv } from './catalog';
import { createInMemoryPublicStatsRuntimeGuard } from '../services/public-stats-runtime-guard';

// Admin is CommonJS and Proxy is ESM. Load the real boundary through Node's
// interop entry, with tsx resolving the Admin tsconfig for its existing aliases.
const { createPublicCatalogBff } = createRequire(import.meta.url)(
	'../../../admin/lib/public-catalog-bff',
) as typeof import('../../../admin/lib/public-catalog-bff');

/** Actual product Hono routes and BFF, with in-process repositories and no network. */
for (const resource of ['models', 'model', 'providers', 'stats', 'legacy-stats'] as const) {
	test(`actual catalog ${resource} faults remain anonymous 503/no-store through BFF and HEAD`, async () => {
		let failed = true;
		let requests = 0;
		const repositories = {
			modelRouting: { listModelsWithActiveRoutes: async () => [] },
			routeDataPolicies: { getByRouteTargetIds: async () => [] },
			systemConfig: {
				getConfig: async () => {
					if (failed) throw new Error('private-key/internal-origin');
					return ' cny ';
				},
			},
			analytics: {
				queryPublicModelAnalytics: async () => {
					if (failed) throw new Error('private-key/internal-origin');
					return [];
				},
			},
		} as unknown as GatewayRepositories;
		const app = new Hono<CatalogEnv>();
		app.use('*', async (c, next) => {
			c.set('repositories', repositories);
			await next();
		});
		app.route('/catalog', createCatalogRoutes(createInMemoryPublicStatsRuntimeGuard()));
		const bff = createPublicCatalogBff(async (path, init) => {
			requests += 1;
			assert.equal(init?.credentials, 'omit');
			assert.equal(init?.cache, 'no-store');
			assert.equal(init?.redirect, 'error');
			const sent = new Request(`https://synthetic-proxy.example${path}`, init);
			assert.equal(sent.headers.get('cookie'), null);
			assert.equal(sent.headers.get('authorization'), null);
			assert.equal(sent.headers.get('x-cinatoken-workspace'), null);
			return app.request(sent);
		});
		const request = (method: string) =>
			new Request('https://synthetic-portal.example/api/public/catalog?range=7d', {
				method,
				headers: {
					Cookie: 'portal=private-key',
					Authorization: 'Bearer private-key',
					'X-CinaToken-Workspace': 'private-workspace',
				},
			});
		const invoke = (method: string) => {
			const incoming = request(method);
			if (resource !== 'stats' && resource !== 'legacy-stats') {
				const url = new URL(incoming.url);
				url.search = '';
				return bff(resource, new Request(url, incoming), resource === 'model' ? { vendor: 'Vendor', slug: 'model' } : undefined);
			}
			return bff(resource, incoming);
		};
		for (const method of ['GET', 'HEAD']) {
			const response = await invoke(method);
			assert.equal(response.status, 503);
			assert.equal(response.headers.get('cache-control'), 'no-store');
			assert.equal(response.headers.get('retry-after'), '60');
			assert.equal(response.headers.get('set-cookie'), null);
			if (method === 'HEAD') assert.equal(await response.text(), '');
			else
				assert.deepEqual(await response.json(), {
					error: { code: 'catalog_upstream_error', message: 'Public catalog request could not be completed' },
				});
		}
		failed = false;
		const recovered = await invoke('GET');
		if (resource === 'model') {
			assert.equal(recovered.status, 404);
			assert.equal(recovered.headers.get('cache-control'), 'no-store');
		} else {
			assert.equal(recovered.status, 200);
			const body = (await recovered.json()) as Record<string, unknown>;
			assert.equal(JSON.stringify(body).includes('private-key'), false);
			if (resource === 'models' || resource === 'providers') assert.equal(body.billing_currency, 'CNY');
			else if (resource === 'stats') assert.equal(body.range, '7d');
			else assert.equal(body.status, 'ready');
		}
		assert.equal(requests, 3);
	});
}

test('a malformed authority currency is a safe 503 through the actual Hono/BFF boundary', async () => {
	const repositories = {
		modelRouting: { listModelsWithActiveRoutes: async () => [] },
		routeDataPolicies: { getByRouteTargetIds: async () => [] },
		systemConfig: { getConfig: async () => 'not-money' },
	} as unknown as GatewayRepositories;
	const app = new Hono<CatalogEnv>();
	app.use('*', async (c, next) => {
		c.set('repositories', repositories);
		await next();
	});
	app.route('/catalog', createCatalogRoutes());
	const bff = createPublicCatalogBff(async (path, init) => app.request(new Request(`https://synthetic-proxy.example${path}`, init)));
	for (const resource of ['models', 'model', 'providers'] satisfies CatalogBffResource[]) {
		const response = await bff(
			resource,
			new Request('https://synthetic-portal.example/api/public/catalog'),
			resource === 'model' ? { vendor: 'Vendor', slug: 'model' } : undefined,
		);
		assert.equal(response.status, 503);
		assert.equal(response.headers.get('cache-control'), 'no-store');
		assert.equal((await response.text()).includes('not-money'), false);
	}
});
