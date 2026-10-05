/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ModelProviderRow } from '../models/model-analytics-contracts'
import type { SortDirection } from '../models/model-analytics-domain'

export const providerSortKeys = [
	'provider_name',
	'request_count',
	'input_tokens',
	'output_tokens',
	'cache_hit_rate',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'avg_charged_per_request',
	'success_rate',
	'avg_latency_ms',
	'avg_effective_ttft_ms',
	'avg_upstream_response_ms',
	'tokens_per_second',
	'failover_rate',
	'avg_attempts',
] as const
export type ProviderSortKey = (typeof providerSortKeys)[number]

export function sortProviderRows(
	rows: readonly ModelProviderRow[],
	key: ProviderSortKey,
	direction: SortDirection
): ModelProviderRow[] {
	const sign = direction === 'asc' ? 1 : -1
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const left =
				key === 'provider_name'
					? (a.row.provider_name ?? a.row.provider_id)
					: a.row[key]
			const right =
				key === 'provider_name'
					? (b.row.provider_name ?? b.row.provider_id)
					: b.row[key]
			if (left === null || left === undefined)
				return right === null || right === undefined
					? a.index - b.index
					: sign * -1
			if (right === null || right === undefined) return sign
			const order =
				typeof left === 'number' && typeof right === 'number'
					? left - right
					: String(left).localeCompare(String(right))
			return order === 0 ? a.index - b.index : order * sign
		})
		.map((entry) => entry.row)
}

export function providerCostTotals(rows: readonly ModelProviderRow[]): {
	standard: number | null
	charged: number
	metered: number
} {
	return rows.reduce<{
		standard: number | null
		charged: number
		metered: number
	}>(
		(sum, row) => ({
			standard:
				sum.standard === null || row.standard_cost === undefined
					? null
					: sum.standard + row.standard_cost,
			charged: sum.charged + row.charged_cost,
			metered: sum.metered + row.metered_cost,
		}),
		{ standard: 0, charged: 0, metered: 0 }
	)
}

export function providerLogHref(
	providerId: string,
	range: { startUtc: string; endUtc: string },
	model?: { model_id: string; route_group: string }
): string {
	const params = new URLSearchParams({
		provider_id: providerId,
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	if (model) {
		params.set('model_id', model.model_id)
		params.set('route_group', model.route_group)
	}
	return `/admin/request-logs?${params.toString()}`
}

export const providerCsvColumns = [
	'provider_id',
	'provider_name',
	'request_count',
	'input_tokens',
	'output_tokens',
	'cache_read_tokens',
	'cache_write_tokens',
	'cache_hit_rate',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'success_count',
	'error_count',
	'success_rate',
	'avg_latency_ms',
	'avg_first_reasoning_token_ms',
	'avg_first_token_ms',
	'avg_effective_ttft_ms',
	'avg_reasoning_phase_ms',
	'reasoning_ttft_rate',
	'content_ttft_rate',
	'avg_upstream_response_ms',
	'tokens_per_second',
	'failover_rate',
	'avg_attempts',
	'avg_charged_per_request',
	'range_start_utc',
	'range_end_utc',
] as const

function csvCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return ''
	let cell = String(value)
	if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(cell))
		cell = `'${cell}`
	return /[",\r\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell
}

/** Export only a confirmed snapshot with known billing currency. */
export function providerAnalyticsCsv(
	rows: readonly ModelProviderRow[],
	range: { startUtc: string; endUtc: string },
	currency: 'USD' | 'CNY' | null
): string {
	if (!currency) throw new TypeError('Billing currency unavailable')
	const lines = [providerCsvColumns.join(',')]
	for (const row of rows) {
		const record: Record<string, string | number | null | undefined> = {
			...row,
			range_start_utc: range.startUtc,
			range_end_utc: range.endUtc,
		}
		lines.push(providerCsvColumns.map((key) => csvCell(record[key])).join(','))
	}
	return '\uFEFF' + lines.join('\r\n')
}
