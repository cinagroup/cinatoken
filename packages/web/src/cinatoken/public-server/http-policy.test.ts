/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	publicBrowserAssets,
	publicHttpRoute,
	publicRobotsText,
	publicSecurityHeaders,
	trustedPublicOrigin,
	xmlText,
} from './http-policy'

test('public namespaces, fixed locales, stable redirects and private fallback are explicit', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko']) {
		for (const path of [
			'',
			'/models',
			'/models/acme/test',
			'/providers',
			'/compare',
			'/chat',
			'/rankings',
			'/benchmarks',
		]) {
			const route = publicHttpRoute(
				new URL(`https://request.example/${locale}${path}?range=30d`)
			)
			assert.equal(route?.locale, locale)
			assert.equal(route?.redirect, null)
			assert.notEqual(route?.kind, 'not-found')
		}
	}
	assert.equal(
		publicHttpRoute(new URL('https://host/models?q=a%20b'))?.redirect,
		'/en/models?q=a%20b'
	)
	assert.equal(
		publicHttpRoute(new URL('https://host/ja/models/?q=x'))?.redirect,
		'/ja/models?q=x'
	)
	assert.equal(
		publicHttpRoute(new URL('https://host/fr/models'))?.kind,
		'not-found'
	)
	assert.equal(
		publicHttpRoute(new URL('https://host/zh/missing'))?.kind,
		'not-found'
	)
	for (const path of [
		'/api/public/catalog/models',
		'/api/admin/keys',
		'/account',
		'/admin',
		'/gateway/models',
		'/web-assets/a.js',
	])
		assert.equal(publicHttpRoute(new URL('https://host' + path)), null)
})

test('SEO origin rejects request-origin guessing, credentials, paths, query and unsafe schemes', () => {
	assert.equal(
		trustedPublicOrigin('https://gateway.example/'),
		'https://gateway.example'
	)
	for (const value of [
		undefined,
		'',
		'http://gateway.example',
		'https://user:secret@gateway.example',
		'https://gateway.example/path',
		'https://gateway.example?q=1',
		'https://gateway.example#hash',
		' https://gateway.example',
	])
		assert.throws(() => trustedPublicOrigin(value))
})

test('browser assets are exact same-origin paths; missing CSS or hostile script fails closed', () => {
	const html =
		'<link href="/web-assets/static/css/index.123.css" rel="stylesheet"><script defer src="/web-assets/static/js/index.123.js"></script>'
	assert.deepEqual(publicBrowserAssets(html), {
		scripts: ['/web-assets/static/js/index.123.js'],
		styles: ['/web-assets/static/css/index.123.css'],
	})
	for (const hostile of [
		html.replace(
			'/web-assets/static/js/index.123.js',
			'https://evil.example/a.js'
		),
		html.replace(
			'/web-assets/static/js/index.123.js',
			'/web-assets/../evil.js'
		),
		'<script src="/web-assets/a.js"></script>',
		html + '<script src="/web-assets/static/js/index.123.js"></script>',
	])
		assert.throws(() => publicBrowserAssets(hostile))
})

test('per-response CSP, private robots and XML escaping do not trust user text', () => {
	const headers = publicSecurityHeaders('test-nonce')
	assert.equal(headers.get('cache-control'), 'no-store')
	assert.ok(
		headers
			.get('content-security-policy')
			?.includes("script-src 'self' 'nonce-test-nonce'")
	)
	assert.ok(
		!headers
			.get('content-security-policy')
			?.includes("script-src 'self' 'unsafe-inline'")
	)
	const robots = publicRobotsText('https://gateway.example')
	for (const path of [
		'/account',
		'/admin',
		'/api/',
		'/zh/chat',
		'/ja/chat',
		'/ko/chat',
	])
		assert.ok(robots.includes(`Disallow: ${path}`))
	assert.ok(robots.includes('Sitemap: https://gateway.example/sitemap.xml'))
	assert.equal(
		xmlText('<tag a="x">&\''),
		'&lt;tag a=&quot;x&quot;&gt;&amp;&apos;'
	)
})
