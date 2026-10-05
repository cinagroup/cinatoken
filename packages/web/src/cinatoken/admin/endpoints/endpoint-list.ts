/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { AdminEndpoint } from '../endpoint-contracts'
import type { EndpointFilters } from '../endpoint-search'
import { endpointIsExpired } from './endpoint-form'

export function filterEndpoints(
	rows: AdminEndpoint[],
	filters: EndpointFilters,
	now = Date.now()
): AdminEndpoint[] {
	const needle = filters.q.toLocaleLowerCase()
	return rows.filter((row) => {
		if (filters.model && row.model_id !== filters.model) return false
		if (filters.provider && row.provider_id !== filters.provider) return false
		if (filters.status === 'expired') {
			if (!endpointIsExpired(row, now)) return false
		} else if (filters.status !== 'all' && row.status !== filters.status)
			return false
		if (!needle) return true
		return [
			row.id,
			row.model_id,
			row.provider_id,
			row.provider_slug,
			row.tag,
		].some((value) => value.toLocaleLowerCase().includes(needle))
	})
}
