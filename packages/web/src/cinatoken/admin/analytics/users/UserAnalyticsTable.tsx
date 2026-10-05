/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelAnalyticsRow } from '../models/model-analytics-contracts'
import {
	formatAnalyticsMoney,
	formatTokens,
	type SortDirection,
	type TokenMode,
} from '../models/model-analytics-domain'
import { UserModelDetails } from './UserModelDetails'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import {
	formatLastActive,
	userLogHref,
	userSortKeys,
	type UserSortKey,
} from './user-analytics-domain'

const prefix = 'cinatoken.adminUserAnalytics.'

export function UserAnalyticsTable(props: {
	rows: UserAnalyticsRow[]
	range: { startUtc: string; endUtc: string }
	active: { email: string } | null
	detail: ModelAnalyticsRow[] | undefined
	detailLoading: boolean
	detailError: boolean
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	tokenMode: TokenMode
	sortKey: UserSortKey
	sortDirection: SortDirection
	onSort: (key: UserSortKey) => void
	onToggle: (row: UserAnalyticsRow) => void
	onRetry: () => void
}) {
	const { t } = useTranslation()
	function money(value: number | undefined): string {
		return (
			formatAnalyticsMoney(value, props.currency, props.locale) ??
			(props.currency ? '—' : t(prefix + 'hidden'))
		)
	}
	return (
		<div
			className='bg-card overflow-x-auto rounded-xl border'
			role='region'
			aria-label={t(prefix + 'table')}
			tabIndex={0}
		>
			<table className='w-full min-w-[1400px] text-left text-sm'>
				<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
					<tr>
						{userSortKeys.map((key) => {
							let order: 'ascending' | 'descending' | undefined
							let arrow = ''
							if (props.sortKey === key) {
								order =
									props.sortDirection === 'asc' ? 'ascending' : 'descending'
								arrow = props.sortDirection === 'asc' ? '↑' : '↓'
							}
							return (
								<th
									key={key}
									scope='col'
									aria-sort={order}
									className={`px-3 py-3 font-semibold whitespace-nowrap ${key === 'user_email' ? 'min-w-[200px]' : ''}`}
								>
									<button
										type='button'
										className='hover:text-foreground'
										onClick={() => props.onSort(key)}
									>
										{t(prefix + key)} {arrow}
									</button>
								</th>
							)
						})}
					</tr>
				</thead>
				<tbody className='divide-y'>
					{props.rows.map((row) => {
						const expanded = props.active?.email === row.user_email
						const budgetRate = row.budget_usage_rate
						const critical = budgetRate !== null && budgetRate >= 100
						const high = budgetRate !== null && budgetRate >= 80
						const budgetClass = critical
							? 'font-semibold text-red-700 dark:text-red-400'
							: high
								? 'font-medium text-amber-700 dark:text-amber-400'
								: ''
						const rowClass = expanded
							? 'bg-primary/5'
							: critical
								? 'bg-red-500/5 hover:bg-red-500/10'
								: high
									? 'bg-amber-500/5 hover:bg-amber-500/10'
									: 'hover:bg-muted/30'
						return (
							<Fragment key={row.user_email}>
								<tr className={rowClass}>
									<td className='min-w-[200px] px-3 py-3'>
										<div className='flex max-w-64 flex-col items-start gap-1'>
											<button
												type='button'
												className='text-primary text-left font-medium break-all hover:underline'
												aria-expanded={expanded}
												onClick={() => props.onToggle(row)}
											>
												{expanded ? '▾' : '▸'} {row.user_email}
											</button>
											{props.logsAllowed && (
												<a
													className='text-muted-foreground hover:text-primary text-xs underline'
													href={userLogHref(row.user_email, props.range)}
													aria-label={t(prefix + 'userLogs', {
														email: row.user_email,
													})}
												>
													{t(prefix + 'viewLogs')}
												</a>
											)}
										</div>
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{new Intl.NumberFormat(props.locale).format(
											row.request_count
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{formatTokens(
											row.input_tokens,
											props.tokenMode,
											props.locale
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{formatTokens(
											row.output_tokens,
											props.tokenMode,
											props.locale
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(row.standard_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(row.charged_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(row.metered_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{new Intl.NumberFormat(props.locale).format(
											row.distinct_models
										)}
									</td>
									<td className='px-3 py-3 whitespace-nowrap'>
										{formatLastActive(
											row.last_active_at,
											props.timezone,
											props.locale
										) ?? '—'}
									</td>
									<td className={`px-3 py-3 tabular-nums ${budgetClass}`}>
										{budgetRate === null
											? t(prefix + 'noBudgetRate')
											: `${budgetRate.toFixed(1)}%`}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{row.success_rate.toFixed(1)}%
									</td>
								</tr>
								{expanded && (
									<UserModelDetails
										row={row}
										range={props.range}
										detail={props.detail}
										loading={props.detailLoading}
										error={props.detailError}
										logsAllowed={props.logsAllowed}
										currency={props.currency}
										locale={props.locale}
										tokenMode={props.tokenMode}
										onRetry={props.onRetry}
									/>
								)}
							</Fragment>
						)
					})}
				</tbody>
			</table>
			{props.rows.length === 0 && (
				<p className='text-muted-foreground p-8 text-center'>
					{t(prefix + 'noData')}
				</p>
			)}
		</div>
	)
}
