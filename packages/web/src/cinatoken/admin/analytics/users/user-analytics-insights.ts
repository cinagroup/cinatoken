/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { UserAnalyticsRow } from './user-analytics-contracts'

export type UserAnalyticsInsightsSummary = {
	requests: number
	successes: number | null
	errors: number
	other: number | null
	successRate: number | null
	standard: number | null
	charged: number
	metered: number
	costDifference: number
}
type InsightsRow = Pick<
	UserAnalyticsRow,
	| 'request_count'
	| 'success_count'
	| 'error_count'
	| 'standard_cost'
	| 'charged_cost'
	| 'metered_cost'
>

/** Older servers omit success_count. Preserve that uncertainty across the sum. */
export function summarizeUserAnalyticsRows(
	rows: readonly InsightsRow[]
): UserAnalyticsInsightsSummary {
	const totals: Omit<
		UserAnalyticsInsightsSummary,
		'other' | 'successRate' | 'costDifference'
	> = {
		requests: 0,
		successes: 0,
		errors: 0,
		standard: 0,
		charged: 0,
		metered: 0,
	}
	for (const row of rows) {
		totals.requests += row.request_count
		totals.errors += row.error_count
		totals.charged += row.charged_cost
		totals.metered += row.metered_cost
		totals.successes =
			totals.successes === null || row.success_count === undefined
				? null
				: totals.successes + row.success_count
		totals.standard =
			totals.standard === null || row.standard_cost === undefined
				? null
				: totals.standard + row.standard_cost
	}
	return {
		...totals,
		other:
			totals.successes === null
				? null
				: totals.requests - totals.successes - totals.errors,
		successRate:
			totals.successes !== null && totals.requests > 0
				? (totals.successes / totals.requests) * 100
				: null,
		costDifference: totals.charged - totals.metered,
	}
}
