/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from './model-analytics-contracts'

export type AnalyticsView = 'overview' | 'cost' | 'performance' | 'all'

const identityColumns = new Set([
	'model_id',
	'route_group',
	'provider_name',
	'provider_kind',
	'provider_id',
	'request_count',
])
const viewColumns: Record<
	Exclude<AnalyticsView, 'all'>,
	ReadonlySet<string>
> = {
	overview: new Set([
		'charged_cost',
		'success_rate',
		'avg_effective_ttft_ms',
		'failover_request_rate',
		'distinct_models',
	]),
	cost: new Set([
		'standard_cost',
		'charged_cost',
		'metered_cost',
		'avg_charged_per_request',
		'input_tokens',
		'output_tokens',
		'cache_hit_rate',
	]),
	performance: new Set([
		'success_rate',
		'avg_latency_ms',
		'avg_effective_ttft_ms',
		'avg_upstream_response_ms',
		'stream_tokens_per_second',
		'failover_request_rate',
		'avg_attempts',
	]),
}

export function analyticsColumnVisible(
	key: string,
	view: AnalyticsView
): boolean {
	return (
		view === 'all' || identityColumns.has(key) || viewColumns[view].has(key)
	)
}

export function analyticsVisibleColumns<T extends string>(
	keys: readonly T[],
	view: AnalyticsView
): T[] {
	return keys.filter((key) => analyticsColumnVisible(key, view))
}

export function filterModelAnalyticsRows<
	T extends Pick<ModelAnalyticsRow, 'model_id' | 'route_group'>,
>(rows: readonly T[], search: string): T[] {
	const query = search.trim().toLowerCase()
	return rows.filter(
		(row) =>
			row.model_id.toLowerCase().includes(query) ||
			row.route_group.toLowerCase().includes(query)
	)
}

export function filterProviderAnalyticsRows<
	T extends Pick<ModelProviderRow, 'provider_name' | 'provider_id'>,
>(rows: readonly T[], search: string): T[] {
	const query = search.trim().toLowerCase()
	return rows.filter(
		(row) =>
			row.provider_id.toLowerCase().includes(query) ||
			(row.provider_name?.toLowerCase().includes(query) ?? false)
	)
}
