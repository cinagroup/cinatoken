/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createContext, useContext, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

// Locale helpers and the provider deliberately share the public location API.
// eslint-disable-next-line react-refresh/only-export-components
export const PUBLIC_LOCALES = ['en', 'zh', 'ja', 'ko'] as const
export type PublicLocale = (typeof PUBLIC_LOCALES)[number]
export type PublicLocation = {
	locale: PublicLocale
	href: (path: string) => string
}

// eslint-disable-next-line react-refresh/only-export-components
export function isPublicLocale(value: string): value is PublicLocale {
	return PUBLIC_LOCALES.some((locale) => locale === value)
}

// eslint-disable-next-line react-refresh/only-export-components
export function unprefixPublicPath(path: string): string {
	const locale = path.split('/')[1] ?? ''
	if (!isPublicLocale(locale)) return path
	const rest = path.slice(locale.length + 1)
	return rest || '/'
}

// eslint-disable-next-line react-refresh/only-export-components
export function isPublicPagePath(path: string): boolean {
	return (
		/^\/(?:models|providers|compare|chat|rankings|benchmarks)?\/?$/.test(
			path
		) || /^\/models\/[^/]+\/[^/]+\/?$/.test(path)
	)
}

/** Local public links share a locale; private, fragment and external links keep their contract. */
// eslint-disable-next-line react-refresh/only-export-components
export function localizePublicHref(path: string, locale: PublicLocale): string {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
		return path
	const boundary = path.search(/[?#]/)
	const pathname = boundary < 0 ? path : path.slice(0, boundary)
	const suffix = boundary < 0 ? '' : path.slice(boundary)
	const bare = unprefixPublicPath(pathname)
	if (!isPublicPagePath(bare)) return path
	return `/${locale}${bare === '/' ? '' : bare}${suffix}`
}

// eslint-disable-next-line react-refresh/only-export-components
export function createPublicLocation(locale: PublicLocale): PublicLocation {
	return { locale, href: (path) => localizePublicHref(path, locale) }
}

const PublicLocationContext = createContext<PublicLocation | null>(null)

export function PublicLocationProvider(props: {
	value: PublicLocation
	children?: ReactNode
}) {
	return (
		<PublicLocationContext.Provider value={props.value}>
			{props.children}
		</PublicLocationContext.Provider>
	)
}

// The provider and consumer form a single context API.
// eslint-disable-next-line react-refresh/only-export-components
export function usePublicLocation(): PublicLocation {
	const context = useContext(PublicLocationContext)
	const { i18n } = useTranslation()
	const language = i18n.resolvedLanguage ?? 'en'
	return (
		context ?? {
			locale: isPublicLocale(language) ? language : 'en',
			href: (path) => path,
		}
	)
}
