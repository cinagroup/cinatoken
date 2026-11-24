/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ModelAnalyticsRow } from './model-analytics-contracts'

export type AnalyticsInsightsSummary = {
	requests: number
	successes: number
	errors: number
	other: number
	successRate: number | null
	standard: number | null
	charged: number
	metered: number
	costDifference: number
}

type InsightsRow = Pick<
	ModelAnalyticsRow,
	| 'request_count'
	| 'success_count'
	| 'error_count'
	| 'standard_cost'
	| 'charged_cost'
	| 'metered_cost'
>

/** Summarize validated rows using exact counts, never averages of row rates. */
export function summarizeAnalyticsRows(
	rows: readonly InsightsRow[]
): AnalyticsInsightsSummary {
	const totals: Omit<
		AnalyticsInsightsSummary,
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
		totals.successes += row.success_count
		totals.errors += row.error_count
		totals.charged += row.charged_cost
		totals.metered += row.metered_cost
		totals.standard =
			totals.standard === null || row.standard_cost === undefined
				? null
				: totals.standard + row.standard_cost
	}
	return {
		...totals,
		other: totals.requests - totals.successes - totals.errors,
		successRate:
			totals.requests > 0 ? (totals.successes / totals.requests) * 100 : null,
		costDifference: totals.charged - totals.metered,
	}
}
