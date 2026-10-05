/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export type DataPolicyStatusFilter = 'all' | 'verified' | 'expired' | 'unknown'

export type DataPolicyFilters = {
	q: string
	status: DataPolicyStatusFilter
}

export const emptyDataPolicyFilters: DataPolicyFilters = {
	q: '',
	status: 'all',
}

function removeControls(value: string): string {
	return Array.from(value)
		.filter((character) => {
			const code = character.charCodeAt(0)
			return code >= 32 && code !== 127
		})
		.join('')
}

/** Router search parameters are untrusted, including on a direct URL visit. */
export function validateDataPolicySearch(input: unknown): DataPolicyFilters {
	if (input === null || typeof input !== 'object' || Array.isArray(input))
		return emptyDataPolicyFilters
	const value = input as Record<string, unknown>
	const q =
		typeof value.q === 'string'
			? removeControls(value.q).trim().slice(0, 200)
			: ''
	const status = value.status
	return {
		q,
		status:
			status === 'verified' || status === 'expired' || status === 'unknown'
				? status
				: 'all',
	}
}
