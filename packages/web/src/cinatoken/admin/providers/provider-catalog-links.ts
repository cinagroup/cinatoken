/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { providerEndpointsHaveCredentials } from '../provider-endpoints'

export type ProviderCatalogLinks = {
	platform?: string
	api_keys?: string
	referral?: string
}
export type ProviderCatalogOutboundKind = keyof ProviderCatalogLinks
export type ProviderCatalogOutbound = {
	href: string
	kind: ProviderCatalogOutboundKind
}

function safeCatalogHref(value: unknown): string | undefined {
	if (
		typeof value !== 'string' ||
		value.length > 4096 ||
		/[\p{Cc}\p{Cf}\\]/u.test(value)
	)
		return undefined
	const href = value.trim()
	if (!/^https:\/\//iu.test(href)) return undefined
	try {
		const url = new URL(href)
		// Hash-router query parameters and OAuth fragments can also contain credentials.
		const fragment = decodeURIComponent(url.hash.slice(1))
		const fragmentUrl = new URL(url)
		const queryStart = fragment.indexOf('?')
		fragmentUrl.search = ''
		if (queryStart >= 0) fragmentUrl.search = fragment.slice(queryStart + 1)
		else if (fragment.includes('=')) fragmentUrl.search = fragment
		fragmentUrl.hash = ''
		if (
			url.protocol !== 'https:' ||
			!url.hostname ||
			providerEndpointsHaveCredentials({
				openai: { base: href, endpoints: { chat: fragmentUrl.href } },
			})
		)
			return undefined
		return href
	} catch {
		return undefined
	}
}

/** Optional catalog metadata must not break provider reads or retain unsafe URLs. */
export const providerCatalogLinksSchema = z
	.unknown()
	.transform((value): ProviderCatalogLinks | undefined => {
		if (typeof value !== 'object' || value === null || Array.isArray(value))
			return undefined
		const result: ProviderCatalogLinks = {}
		for (const key of ['platform', 'api_keys', 'referral'] as const) {
			if (!Object.hasOwn(value, key)) continue
			const href = safeCatalogHref((value as Record<string, unknown>)[key])
			if (href) result[key] = href
		}
		return Object.keys(result).length ? result : undefined
	})

/** Keep the existing catalog CTA preference and skip unusable higher-priority links. */
export function resolveProviderCatalogOutbound(
	links: unknown
): ProviderCatalogOutbound | null {
	const safe = providerCatalogLinksSchema.parse(links)
	if (!safe) return null
	for (const kind of ['referral', 'api_keys', 'platform'] as const) {
		const href = safe[kind]
		if (href) return { href, kind }
	}
	return null
}

export function providerCatalogOutboundRel(
	kind: ProviderCatalogOutboundKind
): string {
	return kind === 'referral'
		? 'sponsored noopener noreferrer'
		: 'noopener noreferrer'
}
