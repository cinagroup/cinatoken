/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { referenceAssetPath } from './reference-policy'
import { routeWebRequest, type WebEntryEnv } from './worker'

test('reference aliases map to exact static feeds without entering the live model API', () => {
	for (const prefix of ['/reference/api/catalog', '/reference/catalog']) {
		assert.equal(
			referenceAssetPath(prefix + '/models'),
			'/reference/catalog/models.json'
		)
		assert.equal(
			referenceAssetPath(prefix + '/providers.json'),
			'/reference/catalog/providers.json'
		)
		assert.equal(
			referenceAssetPath(prefix + '/models-by-vendor/deepseek'),
			'/reference/catalog/models-by-vendor/deepseek.json'
		)
	}
	for (const path of [
		'/api/public/catalog/models',
		'/reference/api/catalog/models/../../admin',
		'/reference/api/catalog/models-by-vendor/%2e%2e',
		'/reference/api/catalog/models-by-vendor/a.b',
	])
		assert.equal(referenceAssetPath(path), null)
})

test('public reference feeds preserve ETag, HEAD, CORS and 304 and never call Admin', async () => {
	const requests: Request[] = []
	const env: WebEntryEnv = {
		ASSETS: {
			async fetch(request) {
				requests.push(request)
				if (request.headers.get('if-none-match') === '"fixture"')
					return new Response(null, {
						status: 304,
						headers: { etag: '"fixture"' },
					})
				return Response.json(
					{ catalog: 'models', count: 1, items: [{ id: 'template-only' }] },
					{ headers: { etag: '"fixture"' } }
				)
			},
		},
		CINATOKEN_ADMIN_SERVICE: {
			async fetch() {
				throw Error('Reference must not call Admin')
			},
		},
	}
	for (const method of ['GET', 'HEAD', 'OPTIONS']) {
		const response = await routeWebRequest(
			new Request(
				'https://test.example/reference/api/catalog/models?private=discarded',
				{ method }
			),
			env
		)
		assert.equal(response.status, method === 'OPTIONS' ? 204 : 200)
		assert.equal(response.headers.get('access-control-allow-origin'), '*')
		if (method !== 'GET') assert.equal(await response.text(), '')
	}
	assert.equal(
		new URL(requests[0]!.url).pathname,
		'/reference/catalog/models.json'
	)
	assert.equal(new URL(requests[0]!.url).search, '')
	const cached = await routeWebRequest(
		new Request('https://test.example/reference/api/catalog/models', {
			headers: { 'if-none-match': '"fixture"' },
		}),
		env
	)
	assert.equal(cached.status, 304)
	assert.equal(cached.headers.get('etag'), '"fixture"')
})

test('missing reference feeds remain typed 404s while writes retain their backend path', async () => {
	const requests: Request[] = []
	const env: WebEntryEnv = {
		ASSETS: {
			async fetch() {
				return new Response('missing', { status: 404 })
			},
		},
		CINATOKEN_ADMIN_SERVICE: {
			async fetch(request) {
				requests.push(request)
				return new Response('backend')
			},
		},
	}
	for (const path of [
		'/reference/api/catalog/unknown',
		'/reference/api/catalog/models-by-vendor/missing',
	]) {
		const response = await routeWebRequest(
			new Request('https://test.example' + path),
			env
		)
		assert.equal(response.status, 404)
		assert.equal(response.headers.get('cache-control'), 'no-store')
		assert.deepEqual(await response.json(), { error: 'reference_not_found' })
	}
	const request = new Request(
		'https://test.example/reference/api/catalog/models',
		{ method: 'POST', headers: { authorization: 'Bearer fixture' } }
	)
	assert.equal(await (await routeWebRequest(request, env)).text(), 'backend')
	assert.equal(requests[0], request)
})
