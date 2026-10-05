/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ModelAnalyticsRow } from './model-analytics-contracts'

export function modelLogHref(
	row: Pick<ModelAnalyticsRow, 'model_id' | 'route_group'>,
	range: { startUtc: string; endUtc: string },
	provider?: { provider_id: string }
): string {
	const params = new URLSearchParams({
		model_id: row.model_id,
		route_group: row.route_group,
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	if (provider) params.set('provider_id', provider.provider_id)
	return `/admin/request-logs?${params.toString()}`
}

export function modelCostTotals(rows: readonly ModelAnalyticsRow[]): {
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

export const modelSortKeys = [
	'model_id',
	'route_group',
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
export type ModelSortKey = (typeof modelSortKeys)[number]
export type SortDirection = 'asc' | 'desc'
export type TokenMode = 'compact' | 'numeric'

export function sortModelRows(
	rows: readonly ModelAnalyticsRow[],
	key: ModelSortKey,
	direction: SortDirection
): ModelAnalyticsRow[] {
	const sign = direction === 'asc' ? 1 : -1
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const left = a.row[key]
			const right = b.row[key]
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

export function formatTokens(
	value: number,
	mode: TokenMode,
	locale: string
): string {
	if (mode === 'numeric') return new Intl.NumberFormat(locale).format(value)
	const abs = Math.abs(value)
	const divisor = abs >= 1e9 ? 1e9 : abs >= 1e6 ? 1e6 : abs >= 1e3 ? 1e3 : 1
	const suffix =
		divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : divisor === 1e3 ? 'K' : ''
	return divisor === 1
		? String(value)
		: `${Number((value / divisor).toFixed(2))}${suffix}`
}

export function formatAnalyticsMoney(
	value: number | undefined,
	currency: 'USD' | 'CNY' | null,
	locale: string,
	digits = 4
): string | null {
	if (!currency || value === undefined) return null
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: digits,
	}).format(value)
}

export function ttftPrimary(
	row:
		| ModelAnalyticsRow
		| {
				avg_first_reasoning_token_ms: number | null
				avg_first_token_ms: number | null
				avg_effective_ttft_ms: number | null
				reasoning_ttft_rate: number
		  }
): { kind: 'R' | 'C' | ''; value: number } | null {
	if (row.reasoning_ttft_rate > 0 && row.avg_first_reasoning_token_ms !== null)
		return { kind: 'R', value: row.avg_first_reasoning_token_ms }
	if (row.avg_first_token_ms !== null)
		return { kind: 'C', value: row.avg_first_token_ms }
	if (row.avg_effective_ttft_ms !== null)
		return { kind: '', value: row.avg_effective_ttft_ms }
	return null
}

export const modelCsvColumns = [
	'model_id',
	'route_group',
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
	let text = String(value)
	if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(text))
		text = `'${text}`
	return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
}

/** Caller must pass the confirmed, sorted snapshot and a verified billing currency. */
export function modelAnalyticsCsv(
	rows: readonly ModelAnalyticsRow[],
	range: { startUtc: string; endUtc: string },
	currency: 'USD' | 'CNY' | null
): string {
	if (!currency) throw new TypeError('Billing currency unavailable')
	const lines = [modelCsvColumns.join(',')]
	for (const row of rows) {
		const record: Record<string, string | number | null | undefined> = {
			...row,
			range_start_utc: range.startUtc,
			range_end_utc: range.endUtc,
		}
		lines.push(modelCsvColumns.map((key) => csvCell(record[key])).join(','))
	}
	return '\uFEFF' + lines.join('\r\n')
}
