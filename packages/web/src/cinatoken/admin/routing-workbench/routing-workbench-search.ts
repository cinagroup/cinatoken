/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	validateEndpointSearch,
	type EndpointFilters,
} from '../endpoint-search'
import { validateModelSearch } from '../model-search'
import { validateProviderSearch } from '../provider-search'
import type { ProviderFilters } from '../providers/provider-form'
import { validateRouteFilters, type RouteFilters } from '../routes/route-domain'

export type RoutingWorkbenchFeature =
	'providers' | 'models' | 'endpoints' | 'routes'
export type RoutingWorkbenchSearch =
	| ProviderFilters
	| ReturnType<typeof validateModelSearch>
	| EndpointFilters
	| RouteFilters

/** Keep duplicate URL parameters visible to the same validators used by Web. */
export function readRoutingWorkbenchSearch(
	search: string
): Record<string, unknown> {
	const params = new URLSearchParams(search)
	return Object.fromEntries(
		[...new Set(params.keys())].map((key) => {
			const values = params.getAll(key)
			return [key, values.length === 1 ? values[0] : values]
		})
	)
}

export function validateRoutingWorkbenchSearch(
	input: unknown,
	feature: RoutingWorkbenchFeature
): RoutingWorkbenchSearch {
	switch (feature) {
		case 'providers':
			return validateProviderSearch(input)
		case 'models':
			return validateModelSearch(input)
		case 'endpoints':
			return validateEndpointSearch(input)
		case 'routes':
			return validateRouteFilters(input)
	}
}

/** Write only validated canonical filters, including an explicit invalid marker. */
export function serializeRoutingWorkbenchSearch(
	input: RoutingWorkbenchSearch,
	feature: RoutingWorkbenchFeature
): string {
	const value = validateRoutingWorkbenchSearch(input, feature)
	const defaults = validateRoutingWorkbenchSearch({}, feature)
	const params = new URLSearchParams()
	for (const [key, item] of Object.entries(value)) {
		if (item === true) params.set(key, 'true')
		else if (
			typeof item === 'string' &&
			item &&
			Reflect.get(defaults, key) !== item
		)
			params.set(key, item)
	}
	return params.toString()
}

/** An edit link is one use; consuming it preserves the surrounding query. */
export function consumeRoutingModelEdit(search: string): string {
	const params = new URLSearchParams(search)
	params.delete('edit')
	params.delete('invalidEdit')
	return params.toString()
}
