/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { webProxyConnectSources } from '../../../scripts/proxy-origin-policy.mjs'
import { publicSiteOrigin } from '../../../scripts/public-origin-policy.mjs'

export const PUBLIC_HTTP_LOCALES = ['en', 'zh', 'ja', 'ko'] as const
export type PublicHttpLocale = (typeof PUBLIC_HTTP_LOCALES)[number]
export type PublicPageKind =
	| 'home'
	| 'models'
	| 'model'
	| 'providers'
	| 'compare'
	| 'chat'
	| 'rankings'
	| 'benchmarks'
	| 'not-found'
	| 'robots'
	| 'sitemap'
export type PublicHttpRoute = {
	locale: PublicHttpLocale
	kind: PublicPageKind
	barePath: string
	redirect: string | null
}

export function trustedPublicOrigin(value: string | undefined): string {
	return publicSiteOrigin(value)
}

function pageKind(path: string): PublicPageKind {
	if (path === '/') return 'home'
	const name = path.slice(1)
	if (
		name === 'models' ||
		name === 'providers' ||
		name === 'compare' ||
		name === 'chat' ||
		name === 'rankings' ||
		name === 'benchmarks'
	)
		return name
	if (/^\/models\/[^/]+\/[^/]+$/.test(path)) return 'model'
	return 'not-found'
}

/** Only public namespaces are captured. API/private requests keep the Admin binding. */
export function publicHttpRoute(url: URL): PublicHttpRoute | null {
	if (url.pathname === '/robots.txt' || url.pathname === '/sitemap.xml') {
		return {
			locale: 'en',
			barePath: url.pathname,
			redirect: null,
			kind: url.pathname === '/robots.txt' ? 'robots' : 'sitemap',
		}
	}
	const parts = url.pathname.split('/')
	const candidate = parts[1]
	const locale = PUBLIC_HTTP_LOCALES.find((value) => value === candidate)
	if (locale) {
		let barePath = '/' + parts.slice(2).join('/')
		if (barePath.length > 1) barePath = barePath.replace(/\/$/, '')
		const canonicalPath =
			barePath === '/' ? `/${locale}` : `/${locale}${barePath}`
		return {
			locale,
			barePath,
			kind: pageKind(barePath),
			redirect:
				canonicalPath !== url.pathname ? canonicalPath + url.search : null,
		}
	}
	const barePath =
		url.pathname.length > 1 ? url.pathname.replace(/\/$/, '') : '/'
	const kind = pageKind(barePath)
	if (kind !== 'not-found' || /^\/models(?:\/|$)/.test(barePath)) {
		return {
			locale: 'en',
			barePath,
			kind,
			redirect: `/en${barePath === '/' ? '' : barePath}${url.search}`,
		}
	}
	// Unsupported language prefixes never masquerade as the English resource.
	if (
		/^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(candidate ?? '') &&
		pageKind('/' + parts.slice(2).join('/').replace(/\/$/, '')) !== 'not-found'
	) {
		return {
			locale: 'en',
			barePath: url.pathname,
			kind: 'not-found',
			redirect: null,
		}
	}
	return null
}

export function publicSecurityHeaders(
	nonce: string,
	proxyOrigins?: string
): Headers {
	const headers = new Headers({
		'cache-control': 'no-store',
		'content-type': 'text/html; charset=utf-8',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
	})
	headers.set(
		'content-security-policy',
		[
			"default-src 'self'",
			`script-src 'self' 'nonce-${nonce}'`,
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: https:",
			"media-src 'self' blob:",
			"font-src 'self' data:",
			`connect-src ${webProxyConnectSources(proxyOrigins)}`,
			"worker-src 'self' blob:",
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"frame-src 'none'",
			"form-action 'self'",
		].join('; ')
	)
	return headers
}

export type PublicBrowserAssets = { scripts: string[]; styles: string[] }
export function publicBrowserAssets(html: string): PublicBrowserAssets {
	if (html.length > 1024 * 1024)
		throw new TypeError('Invalid public browser shell')
	const path = (value: string): string => {
		if (
			!/^\/web-assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:js|css)$/.test(
				value
			) ||
			value.split('/').some((part) => part === '.' || part === '..')
		)
			throw new TypeError('Invalid public browser asset')
		return value
	}
	const scripts = [
		...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi),
	].map((match) => path(match[1]!))
	const styles = [
		...html.matchAll(
			/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi
		),
	].map((match) => path(match[1]!))
	if (
		!scripts.length ||
		scripts.length > 32 ||
		!styles.length ||
		styles.length > 32 ||
		new Set(scripts).size !== scripts.length ||
		new Set(styles).size !== styles.length
	)
		throw new TypeError('Invalid public browser shell')
	return { scripts, styles }
}

export function xmlText(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const replacements: Record<string, string> = {
			'&': '&amp;',
			'<': '&lt;',
			'>': '&gt;',
			'"': '&quot;',
			"'": '&apos;',
		}
		return replacements[character]!
	})
}

export function publicRobotsText(origin: string): string {
	const privatePaths = [
		'/api/',
		'/account',
		'/admin',
		'/gateway',
		'/dashboard',
		'/chat',
		...PUBLIC_HTTP_LOCALES.map((locale) => `/${locale}/chat`),
	]
	return `User-agent: *\n${privatePaths.map((path) => `Disallow: ${path}`).join('\n')}\nSitemap: ${origin}/sitemap.xml\n`
}
