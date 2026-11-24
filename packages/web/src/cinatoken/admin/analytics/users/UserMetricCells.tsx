/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	formatAnalyticsMoney,
	formatTokens,
	type TokenMode,
} from '../models/model-analytics-domain'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import {
	formatLastActive,
	formatUserAnalyticsWallet,
	userAnalyticsWalletBalance,
	type UserSortKey,
} from './user-analytics-domain'

const prefix = 'cinatoken.adminUserAnalytics.'
export function UserMetricCells(props: {
	row: UserAnalyticsRow
	columns: readonly UserSortKey[]
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	tokenMode: TokenMode
	budgetClass: string
}) {
	const { t } = useTranslation()
	function value(key: UserSortKey): string {
		const row = props.row
		if (key === 'input_tokens' || key === 'output_tokens')
			return formatTokens(row[key], props.tokenMode, props.locale)
		if (
			key === 'standard_cost' ||
			key === 'charged_cost' ||
			key === 'metered_cost'
		)
			return (
				formatAnalyticsMoney(row[key], props.currency, props.locale) ??
				(props.currency ? '—' : t(prefix + 'hidden'))
			)
		if (
			key === 'wallet_granted' ||
			key === 'wallet_spent' ||
			key === 'wallet_balance'
		)
			return (
				formatUserAnalyticsWallet(
					key === 'wallet_balance' ? userAnalyticsWalletBalance(row) : row[key],
					props.currency,
					props.locale
				) ?? (props.currency ? '—' : t(prefix + 'hidden'))
			)
		if (key === 'last_active_at')
			return (
				formatLastActive(row.last_active_at, props.timezone, props.locale) ??
				'—'
			)
		if (key === 'budget_usage_rate')
			return row.budget_usage_rate === null
				? t(prefix + 'noBudgetRate')
				: `${row.budget_usage_rate.toFixed(1)}%`
		if (key === 'success_rate') return `${row.success_rate.toFixed(1)}%`
		if (key === 'request_count' || key === 'distinct_models')
			return new Intl.NumberFormat(props.locale).format(row[key])
		return row.user_email
	}
	return props.columns
		.filter((key) => key !== 'user_email')
		.map((key) => (
			<td
				key={key}
				className={`px-3 py-3 whitespace-nowrap tabular-nums ${key === 'budget_usage_rate' ? props.budgetClass : ''}`}
			>
				{value(key)}
			</td>
		))
}
