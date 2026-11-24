/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { SortDirection } from '../models/model-analytics-domain'
import type { UserAnalyticsRow } from './user-analytics-contracts'

export const userSortKeys = [
	'user_email',
	'request_count',
	'input_tokens',
	'output_tokens',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'distinct_models',
	'last_active_at',
	'wallet_granted',
	'wallet_spent',
	'wallet_balance',
	'budget_usage_rate',
	'success_rate',
] as const
export type UserSortKey = (typeof userSortKeys)[number]

export function sortUserRows(
	rows: readonly UserAnalyticsRow[],
	key: UserSortKey,
	direction: SortDirection
): UserAnalyticsRow[] {
	const sign = direction === 'asc' ? 1 : -1
	return rows
		.map((row, index) => ({ row, index }))
		.sort((a, b) => {
			const left =
				key === 'wallet_balance'
					? userAnalyticsWalletBalance(a.row)
					: a.row[key]
			const right =
				key === 'wallet_balance'
					? userAnalyticsWalletBalance(b.row)
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

export function userCostTotals(rows: readonly UserAnalyticsRow[]): {
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

export function userLogHref(
	email: string,
	range: { startUtc: string; endUtc: string },
	model?: { model_id: string; route_group: string }
): string {
	const params = new URLSearchParams({
		user_email: email,
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	if (model) {
		params.set('model_id', model.model_id)
		params.set('route_group', model.route_group)
	}
	return `/admin/request-logs?${params.toString()}`
}

export function formatLastActive(
	isoUtc: string | null,
	timezone: string | null,
	locale: string
): string | null {
	if (!isoUtc) return null
	return new Intl.DateTimeFormat(locale, {
		timeZone: timezone ?? 'UTC',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		timeZoneName: 'short',
	}).format(new Date(isoUtc))
}

export const userCsvColumns = [
	'user_email',
	'request_count',
	'input_tokens',
	'output_tokens',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'distinct_models',
	'last_active_at',
	'budget_max',
	'budget_spent',
	'budget_usage_rate_pct',
	'success_rate_pct',
	'error_count',
	'range_start_utc',
	'range_end_utc',
	'user_id',
	'wallet_granted',
	'wallet_spent',
	'wallet_balance',
] as const

function csvCell(value: string | number | null | undefined): string {
	if (value === null || value === undefined) return ''
	let cell = String(value)
	if (typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/u.test(cell))
		cell = `'${cell}`
	return /[",\r\n]/u.test(cell) ? `"${cell.replace(/"/gu, '""')}"` : cell
}

/** The budget values are current joined-user snapshots grouped by log email. */
export function userAnalyticsCsv(
	rows: readonly UserAnalyticsRow[],
	range: { startUtc: string; endUtc: string },
	currency: 'USD' | 'CNY' | null
): string {
	if (!currency) throw new TypeError('Billing currency unavailable')
	const lines = [userCsvColumns.join(',')]
	for (const row of rows) {
		const record: Record<string, string | number | null | undefined> = {
			...row,
			budget_usage_rate_pct: row.budget_usage_rate,
			success_rate_pct: row.success_rate,
			range_start_utc: range.startUtc,
			range_end_utc: range.endUtc,
			wallet_balance: userAnalyticsWalletBalance(row),
		}
		lines.push(userCsvColumns.map((key) => csvCell(record[key])).join(','))
	}
	return '\uFEFF' + lines.join('\r\n')
}

/** Email groups can join several accounts; only a proven single account has a balance. */
export function userAnalyticsWalletBalance(
	row: UserAnalyticsRow
): number | null {
	if (!row.user_id || row.wallet_granted == null || row.wallet_spent == null)
		return null
	const difference = row.wallet_granted - row.wallet_spent
	return Number.isFinite(difference) ? Number(difference.toFixed(6)) : null
}
export function formatUserAnalyticsWallet(
	value: number | null | undefined,
	currency: 'USD' | 'CNY' | null,
	locale: string
): string | null {
	if (value == null || !currency) return null
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	}).format(value)
}
export function userKeyLogHref(
	userId: string,
	apiKeyId: string,
	range: { startUtc: string; endUtc: string },
	model?: { model_id: string; route_group: string }
): string {
	const params = new URLSearchParams({
		user_id: userId,
		api_key_id: apiKeyId,
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	if (model) {
		params.set('model_id', model.model_id)
		params.set('route_group', model.route_group)
	}
	return '/admin/request-logs?' + params.toString()
}
