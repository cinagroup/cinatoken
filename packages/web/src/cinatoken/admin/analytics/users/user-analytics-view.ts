/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UserAnalyticsRow } from './user-analytics-contracts'
import { userSortKeys, type UserSortKey } from './user-analytics-domain'

export type UserAnalyticsView = 'overview' | 'cost' | 'budget' | 'all'
const columns: Record<
	Exclude<UserAnalyticsView, 'all'>,
	readonly UserSortKey[]
> = {
	overview: [
		'charged_cost',
		'distinct_models',
		'last_active_at',
		'success_rate',
	],
	cost: [
		'input_tokens',
		'output_tokens',
		'standard_cost',
		'charged_cost',
		'metered_cost',
	],
	budget: [
		'wallet_granted',
		'wallet_spent',
		'wallet_balance',
		'budget_usage_rate',
		'last_active_at',
	],
}
export function userVisibleColumns(view: UserAnalyticsView): UserSortKey[] {
	return userSortKeys.filter(
		(key) =>
			view === 'all' ||
			key === 'user_email' ||
			key === 'request_count' ||
			columns[view].includes(key)
	)
}
export function filterUserAnalyticsRows(
	rows: readonly UserAnalyticsRow[],
	search: string
): UserAnalyticsRow[] {
	const query = search.trim().toLowerCase()
	return rows.filter((row) => row.user_email.toLowerCase().includes(query))
}
