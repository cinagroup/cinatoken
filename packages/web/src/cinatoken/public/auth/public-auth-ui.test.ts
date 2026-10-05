/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { buildAuthStartPath } from '../../auth-popup-contract'
import { publicCatalogHttpFixture } from '../../public-server/public-http.fixture'
import { createPublicCatalogApi } from '../catalog-api'
import { PublicApplication } from '../ssr/public-application'
import { createPublicI18n } from '../ssr/public-i18n'
import { PUBLIC_LOCALES, type PublicLocale } from '../ssr/public-location'
import {
	createPublicRequestApp,
	preparePublicRequest,
} from '../ssr/public-request-app'
import { PublicAuthAccessLink } from './PublicAuthAccessLink'
import { PublicAuthStatus, PublicAuthStatusView } from './PublicAuthStatus'
import { publicAuthMessages } from './messages'
import { PublicAuthProvider, type usePublicAuth } from './public-auth-context'

const actions = {
	begin: () => undefined,
	cancel: () => undefined,
	refocus: () => undefined,
	retry: () => undefined,
}
type AuthValue = ReturnType<typeof usePublicAuth>
function status(locale: PublicLocale, auth: AuthValue): string {
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n: createPublicI18n(locale) },
			createElement(PublicAuthStatusView, { auth })
		)
	)
}

for (const locale of PUBLIC_LOCALES) {
	test(`${locale} public auth idle leaves the anonymous page without a status banner`, () => {
		assert.equal(status(locale, { ...actions, phase: 'idle', error: null }), '')
	})
	for (const phase of ['loading', 'waiting', 'verifying'] as const) {
		test(`${locale} public auth ${phase} announces the action with the applicable controls`, () => {
			const html = status(locale, { ...actions, phase, error: null })
			assert.ok(html.includes(publicAuthMessages[locale][phase]))
			assert.ok(html.includes('role="status"'))
			assert.ok(html.includes('aria-live="polite"'))
			assert.ok(html.includes(publicAuthMessages[locale].cancel))
			assert.equal(
				html.includes(publicAuthMessages[locale].refocus),
				phase === 'waiting'
			)
			assert.ok(!html.includes(publicAuthMessages[locale].retry))
			assert.ok(!html.includes('cinatoken.publicAuth.'))
		})
	}
	const safeErrors = {
		oidc_failed: 'oidcFailed',
		session_unavailable: 'sessionUnavailable',
		admin_forbidden: 'adminForbidden',
		popup_expired: 'popupExpired',
		popup_blocked: 'popupBlocked',
		runtime_unavailable: 'runtimeUnavailable',
	} as const
	for (const [code, key] of Object.entries(safeErrors)) {
		test(`${locale} public auth ${code} exposes a translated message instead of the code`, () => {
			const html = status(locale, { ...actions, phase: 'error', error: code })
			assert.ok(html.includes(publicAuthMessages[locale].errors[key]))
			assert.ok(!html.includes(code))
			assert.ok(html.includes('role="alert"'))
			assert.ok(html.includes(publicAuthMessages[locale].retry))
			assert.ok(html.includes(publicAuthMessages[locale].cancel))
			assert.ok(!html.includes(publicAuthMessages[locale].refocus))
		})
	}
	for (const error of [
		null,
		'constructor',
		'<script>private-error-token</script>',
	]) {
		test(`${locale} public auth unknown error ${String(error)} uses only the safe fallback`, () => {
			const html = status(locale, { ...actions, phase: 'error', error })
			assert.ok(
				html.includes(publicAuthMessages[locale].errors.sessionUnavailable)
			)
			assert.ok(!html.includes('private-error-token'))
			assert.ok(!html.includes('constructor'))
			assert.ok(!html.includes('<script>'))
		})
	}
}

test('public auth access keeps private destinations bare and a real no-JS sign-in URL', () => {
	const portal = { intent: 'portal', callbackPath: '/account' } as const
	const admin = { intent: 'admin', callbackPath: '/dashboard' } as const
	const html = renderToStaticMarkup(
		createElement(
			PublicAuthProvider,
			null,
			createElement(
				'div',
				null,
				createElement(PublicAuthAccessLink, {
					options: portal,
					children: 'Sign in',
				}),
				createElement(PublicAuthAccessLink, {
					options: portal,
					href: '/account',
					children: 'Account',
				}),
				createElement(PublicAuthAccessLink, {
					options: admin,
					href: '/dashboard',
					target: '_blank',
					rel: 'noopener',
					children: 'Console',
				})
			)
		)
	)
	assert.ok(html.includes(buildAuthStartPath(portal).replaceAll('&', '&amp;')))
	assert.ok(html.includes('href="/account"'))
	assert.ok(html.includes('href="/dashboard" target="_blank" rel="noopener"'))
	assert.ok(!html.includes('presentation=popup'))
	assert.ok(!html.includes('request='))
})

test('public auth SSR never reads browser session or storage and renders the shared idle provider', () => {
	const storage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		get: () => {
			throw new Error('Anonymous public SSR must not read localStorage')
		},
	})
	try {
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n: createPublicI18n('en') },
				createElement(PublicAuthProvider, null, createElement(PublicAuthStatus))
			)
		)
		assert.equal(html, '')
	} finally {
		if (storage) Object.defineProperty(globalThis, 'localStorage', storage)
		else Reflect.deleteProperty(globalThis, 'localStorage')
	}
})

test('public auth links fail explicitly when a coordinator provider is missing', () => {
	assert.throws(
		() =>
			renderToStaticMarkup(
				createElement(PublicAuthAccessLink, {
					options: {},
					children: 'Sign in',
				})
			),
		/PublicAuthProvider is missing/
	)
})

for (const locale of PUBLIC_LOCALES) {
	for (const path of [
		'',
		'/models',
		'/models/Vendor/http-fixture',
		'/providers',
		'/compare',
		'/chat',
		'/rankings',
		'/benchmarks',
		'/unknown-public-page',
	]) {
		test(`${locale}${path || '/'} uses one footer and an idle shared auth coordinator`, async () => {
			const app = createPublicRequestApp({
				url: `https://public-auth.test/${locale}${path}`,
				publicOrigin: 'https://public-auth.test',
				locale,
				api: createPublicCatalogApi(async (input) =>
					Response.json(publicCatalogHttpFixture(String(input)))
				),
			})
			try {
				const prepared = await preparePublicRequest(app)
				const html = renderToStaticMarkup(
					createElement(PublicApplication, { app })
				)
				assert.equal((html.match(/<footer[\s>]/g) ?? []).length, 1)
				assert.ok(html.includes('href="/account"'))
				assert.ok(!html.includes('data-public-auth-phase'))
				if (path === '') {
					assert.ok(html.includes('© 2026 CinaGroup'))
					assert.ok(!html.includes('CinaToken ·'))
				} else {
					assert.ok(html.includes('CinaToken ·'))
				}
				if (path === '/unknown-public-page') {
					assert.equal(prepared.status, 404)
					assert.match(html, /<h1[^>]*>404<\/h1>/)
				} else assert.equal(prepared.status, 200)
			} finally {
				app.dispose()
			}
		})
	}
}
