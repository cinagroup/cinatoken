/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { routeWebRequest, type WebEntryEnv } from './worker'

function fixture(enabled?: string) {
	const assets: Request[] = []
	const backend: Request[] = []
	const env: WebEntryEnv = {
		CINATOKEN_WEB_DOCS_ENABLED: enabled,
		ASSETS: {
			async fetch(request) {
				assets.push(request)
				return new Response(new URL(request.url).pathname, {
					status: request.url.includes('missing') ? 404 : 200,
					headers: { 'content-type': 'text/html' },
				})
			},
		},
		CINATOKEN_ADMIN_SERVICE: {
			async fetch(request) {
				backend.push(request)
				return new Response('backend')
			},
		},
	}
	return { env, assets, backend }
}

test('documentation GET/HEAD use isolated static pages and keep the trusted origin', async () => {
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/en/docs', '/zh/docs/', '/en/docs/quickstart/']) {
			const f = fixture('true')
			const response = await routeWebRequest(
				new Request(`https://cinatoken.example${path}?token=not-forwarded`, {
					method,
				}),
				f.env
			)
			assert.equal(response.status, 200)
			const target = new URL(f.assets[0]!.url)
			assert.equal(target.origin, 'https://cinatoken.example')
			assert.equal(target.pathname, path.replace(/\/$/, '') + '/index.html')
			assert.equal(target.search, '')
			assert.equal(f.backend.length, 0)
			assert.match(response.headers.get('cache-control')!, /no-transform/)
			assert.match(
				response.headers.get('content-security-policy')!,
				/frame-ancestors 'none'/
			)
			assert.equal(
				method === 'HEAD' ? await response.text() : 'not-head',
				method === 'HEAD' ? '' : 'not-head'
			)
		}
	}
})

test('documentation has an independent rollback; old hashed assets stay available', async () => {
	for (const enabled of [undefined, 'false', 'TRUE']) {
		const f = fixture(enabled)
		assert.equal(
			(
				await routeWebRequest(
					new Request('https://test.example/en/docs/'),
					f.env
				)
			).status,
			503
		)
		assert.equal(f.assets.length, 0)
		const asset = await routeWebRequest(
			new Request('https://test.example/docs-assets/static/index.haH-_Vsc.css'),
			f.env
		)
		assert.equal(asset.status, 200)
		assert.match(asset.headers.get('cache-control')!, /immutable/)
		const missing = await routeWebRequest(
			new Request(
				'https://test.example/docs-assets/static/missing.12345678.js'
			),
			f.env
		)
		assert.equal(missing.status, 404)
		assert.equal(missing.headers.get('cache-control'), 'no-store')
		assert.equal(f.backend.length, 0)
	}
})

test('docs routing preserves authenticated requests and all mutation methods for Admin', async () => {
	for (const [method, path] of [
		['POST', '/en/docs/'],
		['POST', '/docs-assets/static/x.12345.js'],
		['POST', '/docs'],
		['GET', '/api/auth/cinaauth/callback'],
		['GET', '/api/public/catalog/models'],
		['GET', '/account'],
		['GET', '/admin'],
		['GET', '/en/docs-api'],
		['GET', '/ja/docs/'],
	]) {
		const f = fixture('true')
		const request = new Request(`https://test.example${path}?state=fixture`, {
			method,
			headers: { cookie: 'session=fixture', authorization: 'Bearer fixture' },
		})
		const response = await routeWebRequest(request, f.env)
		assert.equal(await response.text(), 'backend')
		assert.equal(f.backend[0], request)
		assert.equal(f.assets.length, 0)
	}
	const f = fixture('true')
	const missing = await routeWebRequest(
		new Request('https://test.example/zh/docs/missing/'),
		f.env
	)
	assert.equal(missing.status, 404)
	assert.equal(f.backend.length, 0)
})

test('content namespaces, legacy bookmarks and XML feeds stay separate from business routes', async () => {
	for (const path of [
		'/en/updates/',
		'/zh/updates/2026-11-28-docs/',
		'/zh/reference/catalog/models/',
		'/en/docs/guides/mcp/',
	]) {
		const f = fixture('true')
		const response = await routeWebRequest(
			new Request('https://test.example' + path),
			f.env
		)
		assert.equal(response.status, 200)
		assert.equal(f.backend.length, 0)
		assert.match(
			response.headers.get('content-security-policy')!,
			/wasm-unsafe-eval/
		)
	}
	for (const [path, target] of [
		['quick-start', 'quickstart'],
		['guides/api-keys', 'keys'],
		['guides/models', 'models'],
	]) {
		const f = fixture('true')
		const response = await routeWebRequest(
			new Request('https://test.example/zh/docs/' + path + '?from=bookmark'),
			f.env
		)
		assert.equal(response.status, 307)
		assert.equal(
			response.headers.get('location'),
			'/zh/docs/' + target + '/?from=bookmark'
		)
		assert.equal(f.assets.length, 0)
	}
	for (const method of ['GET', 'HEAD'])
		for (const path of ['/content-sitemap.xml', '/updates.xml']) {
			const f = fixture('false')
			const response = await routeWebRequest(
				new Request('https://test.example' + path + '?discarded=true', {
					method,
				}),
				f.env
			)
			assert.equal(response.status, 200)
			assert.match(response.headers.get('content-type')!, /application\/xml/)
			assert.equal(new URL(f.assets[0]!.url).search, '')
			assert.equal(f.backend.length, 0)
			if (method === 'HEAD') assert.equal(await response.text(), '')
		}
})
