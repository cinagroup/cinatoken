/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { isPublicLocale, type PublicLocale } from './public-location'

export type PublicRoute =
	| {
			kind:
				| 'home'
				| 'models'
				| 'providers'
				| 'compare'
				| 'chat'
				| 'rankings'
				| 'benchmarks'
				| 'not-found'
	  }
	| { kind: 'model'; vendor: string; slug: string }

export function hasPublicControls(value: string): boolean {
	return Array.from(value).some(
		(character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	)
}

export function classifyPublicRoute(
	pathname: string,
	locale: PublicLocale
): PublicRoute {
	const prefix = `/${locale}`
	if (pathname !== prefix && !pathname.startsWith(`${prefix}/`))
		return { kind: 'not-found' }
	const bare = pathname.slice(prefix.length).replace(/\/$/, '') || '/'
	if (bare === '/') return { kind: 'home' }
	const simple = [
		'models',
		'providers',
		'compare',
		'chat',
		'rankings',
		'benchmarks',
	] as const
	for (const kind of simple) {
		if (bare === `/${kind}`) return { kind }
	}
	const match = /^\/models\/([^/]+)\/([^/]+)$/.exec(bare)
	if (!match) return { kind: 'not-found' }
	try {
		const vendor = decodeURIComponent(match[1]!)
		const slug = decodeURIComponent(match[2]!)
		if (
			!vendor ||
			vendor.length > 80 ||
			vendor.trim() !== vendor ||
			vendor === '.' ||
			vendor === '..' ||
			/[/\\]/.test(vendor) ||
			hasPublicControls(vendor) ||
			!slug ||
			slug.length > 256 ||
			slug === '.' ||
			slug === '..' ||
			!/^[A-Za-z0-9._:~-]+$/.test(slug)
		)
			return { kind: 'not-found' }
		return { kind: 'model', vendor, slug }
	} catch {
		return { kind: 'not-found' }
	}
}

export function localeFromPublicPath(pathname: string): PublicLocale | null {
	const value = pathname.split('/')[1] ?? ''
	return isPublicLocale(value) ? value : null
}
