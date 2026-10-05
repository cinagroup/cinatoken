/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToReadableStream } from 'react-dom/server.edge'
import { createPublicCatalogApi } from '../public/catalog-api'
import {
	createPublicRequestApp,
	preparePublicRequest,
	PublicApplication,
	parsePublicBootstrap,
} from '../public/ssr'
import { PUBLIC_HTTP_LOCALES } from './http-policy'
import { publicCatalogHttpFixture } from './public-http.fixture'
import {
	anonymousCatalogFetch,
	renderPublicResponse,
	type PublicResponseOptions,
} from './public-response'

const shell =
	'<html><link rel="stylesheet" href="/web-assets/static/css/index.123.css"><script defer src="/web-assets/static/js/index.123.js"></script><div id="root"></div></html>'
function fixture(read?: (request: Request) => Promise<Response>) {
	const reads: Request[] = []
	const failures: unknown[] = []
	const options: PublicResponseOptions = {
		onFailure: (error) => failures.push(error),
		publicOrigin: 'https://canonical.example',
		anonymousFetch: anonymousCatalogFetch('https://untrusted-host.example', {
			async fetch(request) {
				reads.push(request)
				if (read) return read(request)
				return Response.json(publicCatalogHttpFixture(request.url))
			},
		}),
		readBrowserShell: async () =>
			new Response(shell, { headers: { 'content-type': 'text/html' } }),
	}
	return { options, reads, failures }
}

for (const locale of PUBLIC_HTTP_LOCALES) {
	for (const path of [
		'',
		'/models?q=HTTP',
		'/models/Vendor/http-fixture',
		'/providers',
		'/compare?models=vendor%2Fhttp-fixture',
		'/chat?model=vendor%2Fhttp-fixture',
		'/rankings?range=30d',
		'/benchmarks?range=90d',
	]) {
		test(`full document HTTP contract ${locale}${path || '/'} preserves one snapshot and safe SEO`, async () => {
			const f = fixture()
			const request = new Request(
				`https://untrusted-host.example/${locale}${path}`,
				{
					headers: {
						cookie: 'admin_session=private-marker',
						authorization: 'Bearer secret-marker',
					},
				}
			)
			const response = await renderPublicResponse(request, f.options)
			const html = await response.text()
			assert.equal(
				response.status,
				200,
				f.failures
					.map((error) =>
						error instanceof Error ? error.stack : String(error)
					)
					.join('\n')
			)
			assert.equal(response.headers.get('cache-control'), 'no-store')
			assert.match(html, new RegExp(`<html lang="${locale}"`))
			assert.match(html, /<h1\b/)
			const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1]
			assert.ok(main, 'The response must contain its main content')
			assert.match(
				main,
				/<h1\b/,
				'The heading must be inline in main without JavaScript'
			)
			assert.doesNotMatch(
				html,
				/id="cinatoken-public-[BS]:/,
				'Prepared content must not depend on a React reveal script'
			)
			assert.match(html, /name="twitter:card"/)
			assert.match(html, /property="og:title"/)
			assert.equal((html.match(/rel="alternate"/g) ?? []).length, 5)
			assert.match(html, /hrefLang="x-default"/i)
			assert.match(html, /rel="canonical" href="https:\/\/canonical\.example\//)
			assert.equal(html.includes('untrusted-host.example'), false)
			assert.equal(
				html.includes('private-marker') || html.includes('secret-marker'),
				false
			)
			assert.equal(html.includes('</script><script>unsafe-marker'), false)
			const nonce = /'nonce-([^']+)'/.exec(
				response.headers.get('content-security-policy') ?? ''
			)?.[1]
			assert.ok(nonce)
			const scripts = [
				...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g),
			]
			assert.ok(
				scripts.length >= 4,
				'query data, official router scripts and client entry'
			)
			for (const script of scripts)
				assert.ok(script[1].includes(`nonce="${nonce}"`))
			const routerScript = scripts.find((script) => script[2].includes('$_TSR'))
			assert.ok(
				routerScript,
				'official route matches must accompany the query snapshot'
			)
			assert.ok(
				html.indexOf(routerScript[0]) >
					html.indexOf('id="cinatoken-public-bootstrap"')
			)
			assert.ok(
				html.indexOf(routerScript[0]) <
					html.indexOf('src="/web-assets/static/js/index.123.js"')
			)
			const encoded =
				/<script[^>]*id="cinatoken-public-bootstrap"[^>]*>([\s\S]*?)<\/script>/.exec(
					html
				)?.[1]
			assert.ok(encoded)
			const bootstrap = parsePublicBootstrap(encoded)
			assert.equal(bootstrap.locale, locale)
			assert.equal(bootstrap.status, 200)
			assert.equal(bootstrap.pathname, new URL(request.url).pathname)
			assert.equal(f.reads.length, path ? 1 : 0)
			for (const read of f.reads) {
				assert.equal(read.method, 'GET')
				assert.equal(read.headers.get('cookie'), null)
				assert.equal(read.headers.get('authorization'), null)
				assert.equal(read.credentials, 'omit')
				assert.equal(read.redirect, 'error')
				assert.ok(read.url.includes('/api/public/catalog/'))
			}
			if (path.startsWith('/models/Vendor')) {
				assert.match(html, /<title>HTTP authority model/)
				assert.ok(html.includes(`/models/vendor/http-fixture`))
			}
			if (path.startsWith('/chat'))
				assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
		})
	}
}

test('document composition preserves the exact app-root useId tree required by hydration', async () => {
	const f = fixture()
	const url = new URL('https://untrusted-host.example/en')
	const app = createPublicRequestApp({
		url,
		locale: 'en',
		publicOrigin: 'https://canonical.example',
		api: createPublicCatalogApi(f.options.anonymousFetch),
	})
	try {
		await preparePublicRequest(app)
		const standalone = await renderToReadableStream(
			createElement(PublicApplication, { app }),
			{ identifierPrefix: 'cinatoken-public-' }
		)
		const expected = await new Response(standalone).text()
		const response = await renderPublicResponse(new Request(url), f.options)
		assert.equal(response.status, 200)
		const html = await response.text()
		const ids = (text: string) =>
			[...text.matchAll(/\bid="([^"]*cinatoken-public-[^"]*)"/g)]
				.map((match) => match[1])
				// React's optional stream containers are not application useId identities.
				.filter(
					(id) =>
						id !== 'cinatoken-public-bootstrap' &&
						!/^cinatoken-public-[BS]:/.test(id)
				)
		assert.ok(
			ids(expected).length > 0,
			'Real homepage generated IDs are required for this regression'
		)
		assert.deepEqual(ids(html), ids(expected))
		assert.match(html, /^<!DOCTYPE html><html/)
		assert.equal((html.match(/id="root"/g) ?? []).length, 1)
	} finally {
		app.dispose()
	}
})

test('only genuine detail 404 is missing; invalid DTO, upstream failure and network failure stay 503/noindex/no-store', async () => {
	for (const status of [404, 429, 500, 503]) {
		const f = fixture(async () =>
			Response.json({ private: 'do-not-leak' }, { status })
		)
		const response = await renderPublicResponse(
			new Request(
				'https://untrusted-host.example/zh/models/Vendor/http-fixture'
			),
			f.options
		)
		const html = await response.text()
		assert.equal(response.status, status === 404 ? 404 : 503)
		assert.equal(response.headers.get('cache-control'), 'no-store')
		assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow')
		assert.equal(html.includes('rel="canonical"'), false)
		assert.equal(html.includes('do-not-leak'), false)
		assert.equal(f.reads.length, 1)
	}
	for (const read of [
		async () => Response.json({ object: 'list', data: [] }),
		async () => {
			throw new Error('private-upstream-error')
		},
	]) {
		const f = fixture(read)
		const response = await renderPublicResponse(
			new Request('https://untrusted-host.example/ja/models'),
			f.options
		)
		assert.equal(response.status, 503)
		assert.equal(
			(await response.text()).includes('private-upstream-error'),
			false
		)
	}
})

test('bare paths redirect with query, malformed public paths return true 404, and HEAD retains status without body', async () => {
	const f = fixture()
	const redirect = await renderPublicResponse(
		new Request('https://untrusted-host.example/models?q=HTTP'),
		f.options
	)
	assert.equal(redirect.status, 308)
	assert.equal(redirect.headers.get('location'), '/en/models?q=HTTP')
	for (const path of ['/fr/models', '/ko/missing', '/en/models/a/b%2Fc']) {
		const response = await renderPublicResponse(
			new Request('https://untrusted-host.example' + path),
			f.options
		)
		assert.equal(
			response.status,
			404,
			`${path}: ${f.failures.map((error) => (error instanceof Error ? error.stack : String(error))).join('\n')}`
		)
		assert.equal((await response.text()).includes('rel="canonical"'), false)
	}
	assert.equal(f.reads.length, 0)
	const head = await renderPublicResponse(
		new Request('https://untrusted-host.example/en/models', { method: 'HEAD' }),
		f.options
	)
	assert.equal(head.status, 200)
	assert.equal(await head.text(), '')
	assert.equal(f.reads.length, 1)
})

test('robots and sitemap use trusted origin and four-language model URLs; failed sitemap never fabricates empty success', async () => {
	const f = fixture()
	const robots = await renderPublicResponse(
		new Request('https://untrusted-host.example/robots.txt'),
		f.options
	)
	assert.match(await robots.text(), /Disallow: \/ko\/chat/)
	const sitemap = await renderPublicResponse(
		new Request('https://untrusted-host.example/sitemap.xml'),
		f.options
	)
	const xml = await sitemap.text()
	assert.equal(sitemap.status, 200)
	assert.match(
		xml,
		/https:\/\/canonical\.example\/zh\/models\/vendor\/http-fixture/
	)
	assert.equal(xml.includes('/chat'), false)
	assert.equal(xml.includes('untrusted-host.example'), false)
	assert.equal(f.reads.length, 1)
	const failing = fixture(async () =>
		Response.json({ error: 'not-public' }, { status: 503 })
	)
	const failure = await renderPublicResponse(
		new Request('https://untrusted-host.example/sitemap.xml'),
		failing.options
	)
	assert.equal(failure.status, 503)
	assert.equal(failure.headers.get('cache-control'), 'no-store')
})

test('untrusted origin or malformed browser shell fails before any upstream read', async () => {
	for (const invalid of [
		'http://canonical.example',
		'https://user:secret@canonical.example',
	]) {
		const f = fixture()
		f.options.publicOrigin = invalid
		assert.equal(
			(
				await renderPublicResponse(
					new Request('https://untrusted-host.example/en/models'),
					f.options
				)
			).status,
			503
		)
		assert.equal(f.reads.length, 0)
	}
	const f = fixture()
	f.options.readBrowserShell = async () =>
		new Response('<script src="https://evil.example/a.js"></script>', {
			headers: { 'content-type': 'text/html' },
		})
	assert.equal(
		(
			await renderPublicResponse(
				new Request('https://untrusted-host.example/en/models'),
				f.options
			)
		).status,
		503
	)
	assert.equal(f.reads.length, 0)
})
