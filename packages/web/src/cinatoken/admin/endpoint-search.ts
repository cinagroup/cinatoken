/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { endpointHasControls } from './endpoint-contracts'

export const ENDPOINT_LIST_FILTERS = [
	'all',
	'draft',
	'verified',
	'disabled',
	'expired',
] as const
export type EndpointListFilter = (typeof ENDPOINT_LIST_FILTERS)[number]
export type EndpointFilters = {
	q: string
	status: EndpointListFilter
	model: string
	provider: string
}
export function validateEndpointSearch(input: unknown): EndpointFilters {
	const params: Record<string, unknown> =
		input !== null && typeof input === 'object' && !Array.isArray(input)
			? (input as Record<string, unknown>)
			: {}
	const text = (value: unknown, maximum: number) =>
		typeof value === 'string' &&
		value.length <= maximum &&
		!endpointHasControls(value)
			? value.trim()
			: ''
	return {
		q: text(params.q, 512),
		model: text(params.model, 512),
		provider: text(params.provider, 512),
		status: ENDPOINT_LIST_FILTERS.includes(params.status as EndpointListFilter)
			? (params.status as EndpointListFilter)
			: 'all',
	}
}
