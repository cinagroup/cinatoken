/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	validateDataPolicySearch,
	type DataPolicyFilters,
} from '../data-policies/data-policy-search'

export type PolicyWorkbenchFeature = 'presets' | 'guardrails' | 'data-policies'

/** Duplicate values remain arrays so the Web validator also sees ambiguous URLs. */
export function readPolicyWorkbenchSearch(
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
export function serializePolicyWorkbenchSearch(
	input: DataPolicyFilters
): string {
	const filters = validateDataPolicySearch(input)
	const params = new URLSearchParams()
	if (filters.q) params.set('q', filters.q)
	if (filters.status !== 'all') params.set('status', filters.status)
	return params.toString()
}
