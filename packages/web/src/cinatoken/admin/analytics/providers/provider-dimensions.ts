/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AnalyticsProviderDirectory } from './analytics-provider-directory'

export type ProviderDimension = {
	key: string
	kind: string | null
	label: string
	status: 'current' | 'missing' | 'unavailable' | 'virtual'
}
export type ProviderDimensionLabels = {
	unclassified: string
	custom: string
	unknown: string
	unavailable: string
	rest: string
	mcp: string
}

export function providerDimension(
	id: string,
	directory: AnalyticsProviderDirectory,
	locale: string,
	labels: ProviderDimensionLabels
): ProviderDimension {
	if (id === 'octafuse-tools')
		return {
			key: 'virtual:rest',
			kind: 'gateway-tools',
			label: labels.rest,
			status: 'virtual',
		}
	if (id === 'octafuse-mcp')
		return {
			key: 'virtual:mcp',
			kind: 'gateway-mcp',
			label: labels.mcp,
			status: 'virtual',
		}
	if (directory.status !== 'ready')
		return {
			key: 'unavailable',
			kind: null,
			label: labels.unavailable,
			status: 'unavailable',
		}
	const provider = directory.providers.get(id)
	if (!provider)
		return {
			key: 'missing',
			kind: null,
			label: labels.unknown,
			status: 'missing',
		}
	const kind = provider.kind?.trim() ?? ''
	let label: string
	if (!kind) label = labels.unclassified
	else if (kind === '__custom__') label = labels.custom
	else {
		const translated = provider.kind_labels
		const first = locale.toLowerCase().startsWith('zh')
			? translated?.zh
			: translated?.en
		const second = locale.toLowerCase().startsWith('zh')
			? translated?.en
			: translated?.zh
		label = first?.trim() || second?.trim() || kind
	}
	return { key: `kind:${kind}`, kind, label, status: 'current' }
}

export function providerKindFilterBlocked(
	key: string,
	directory: AnalyticsProviderDirectory
): boolean {
	return (
		Boolean(key) &&
		key !== 'virtual:rest' &&
		key !== 'virtual:mcp' &&
		directory.status !== 'ready'
	)
}

export function filterProviderDimensions<
	T extends { provider_id: string; provider_name: string | null },
>(
	rows: readonly T[],
	search: string,
	kindKey: string,
	dimensions: ReadonlyMap<string, ProviderDimension>
): T[] {
	const query = search.trim().toLowerCase()
	return rows.filter((row) => {
		const dimension = dimensions.get(row.provider_id)
		if (kindKey && dimension?.key !== kindKey) return false
		return (
			row.provider_id.toLowerCase().includes(query) ||
			(row.provider_name?.toLowerCase().includes(query) ?? false) ||
			(dimension !== undefined &&
				dimension.kind !== null &&
				dimension.label.toLowerCase().includes(query))
		)
	})
}
