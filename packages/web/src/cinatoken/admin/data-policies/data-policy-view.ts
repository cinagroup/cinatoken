/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { DataPolicyListRow } from './data-policy-contracts'
import type { DataPolicyFilters } from './data-policy-search'

export function filterDataPolicies(
	rows: readonly DataPolicyListRow[],
	filters: DataPolicyFilters
): DataPolicyListRow[] {
	const query = filters.q.toLocaleLowerCase()
	return rows.filter((row) => {
		if (filters.status !== 'all' && row.effective_status !== filters.status)
			return false
		if (!query) return true
		return [
			row.route_target_id,
			row.model_id,
			row.provider_id,
			row.provider_name,
			row.provider_model_name,
			row.upstream_protocol,
			row.route_group ?? '',
		]
			.join(' ')
			.toLocaleLowerCase()
			.includes(query)
	})
}

export function dataPolicySummary(rows: readonly DataPolicyListRow[]): {
	total: number
	verified: number
	unconfigured: number
} {
	return {
		total: rows.length,
		verified: rows.filter((row) => row.effective_status === 'verified').length,
		unconfigured: rows.filter((row) => row.subject_fingerprint === null).length,
	}
}
