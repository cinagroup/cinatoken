/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { attachRouterServerSsrUtils } from '@tanstack/router-core/ssr/server'
import assert from 'node:assert/strict'
import test from 'node:test'
import { publicCatalogHttpFixture } from '../../public-server/public-http.fixture'
import { createPublicCatalogApi } from '../catalog-api'
import {
	createPublicRequestApp,
	preparePublicRequest,
} from './public-request-app'

for (const [path, locale, upstreamStatus, status] of [
	['/en', 'en', 200, 200],
	['/zh/models?q=HTTP', 'zh', 200, 200],
	['/ja/models/Vendor/http-fixture', 'ja', 404, 404],
	['/ko/models', 'ko', 503, 503],
	['/fr/models', 'en', 200, 404],
] as const) {
	test(`official router wire carries the terminal public route without duplicating catalog or private state: ${path}`, async () => {
		let reads = 0
		const app = createPublicRequestApp({
			url: `https://request.invalid${path}`,
			locale,
			publicOrigin: 'https://trusted.invalid',
			api: createPublicCatalogApi(async (input) => {
				reads++
				if (upstreamStatus !== 200)
					return Response.json(
						{ privateError: 'SECRET_PRIVATE_ERROR' },
						{ status: upstreamStatus }
					)
				return Response.json(publicCatalogHttpFixture(String(input)))
			}),
		})
		app.router.update({ ssr: { nonce: 'fixture-public-nonce' } })
		attachRouterServerSsrUtils({ router: app.router, manifest: undefined })
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, status)
			assert.ok(app.router.state.matches.length > 0)
			assert.ok(app.router.serverSsr)
			await app.router.serverSsr.dehydrate({ signal: app.signal })
			app.router.serverSsr.setRenderFinished()
			const tags = app.router.serverSsr.takeInitialHydrationScriptTags()
			assert.ok(tags?.before.length)
			assert.equal(tags.boundary.tag, 'script')
			assert.equal(tags.boundary.attrs?.nonce, 'fixture-public-nonce')
			for (const tag of tags.before) {
				assert.equal(tag.tag, 'script')
				assert.equal(tag.attrs?.nonce, 'fixture-public-nonce')
				assert.equal(tag.children?.includes('SECRET_'), false)
				assert.equal(tag.children?.includes('HTTP authority model'), false)
				assert.equal(tag.children?.includes('billing_currency'), false)
			}
			assert.equal(
				app.router.serverSsr.takeInitialHydrationScriptTags(),
				undefined
			)
			assert.equal(reads, prepared.bootstrap.records.length)
			assert.ok(app.router.ssr)
		} finally {
			app.router.serverSsr?.cleanup()
			app.dispose()
		}
		assert.equal(app.router.ssr, undefined)
		assert.equal(app.queryClient.getQueryCache().getAll().length, 0)
	})
}
