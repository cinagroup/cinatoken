/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import {
	type SortDirection,
	type TokenMode,
} from '../models/model-analytics-domain'
import { UserKeyDetails } from './UserKeyDetails'
import { UserMetricCells } from './UserMetricCells'
import { UserModelDetails } from './UserModelDetails'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import { userLogHref, type UserSortKey } from './user-analytics-domain'
import type { UserAnalyticsDetailState } from './user-analytics-drilldowns'
import {
	userVisibleColumns,
	type UserAnalyticsView,
} from './user-analytics-view'

const prefix = 'cinatoken.adminUserAnalytics.'

export function UserAnalyticsTable(props: {
	rows: UserAnalyticsRow[]
	range: { startUtc: string; endUtc: string }
	details: ReadonlyMap<string, UserAnalyticsDetailState>
	view: UserAnalyticsView
	emptyMessage?: string
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	tokenMode: TokenMode
	sortKey: UserSortKey
	sortDirection: SortDirection
	onSort: (key: UserSortKey) => void
	onToggle: (row: UserAnalyticsRow, kind?: 'models' | 'keys') => void
}) {
	const { t } = useTranslation()
	const columns = userVisibleColumns(props.view)

	return (
		<div
			className='bg-card overflow-x-auto rounded-xl border'
			role='region'
			aria-label={t(prefix + 'table')}
			tabIndex={0}
		>
			<table
				className={`w-full text-left text-sm ${props.view === 'all' ? 'min-w-[1400px]' : 'min-w-[800px]'}`}
			>
				<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
					<tr>
						{columns.map((key) => {
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
						const detail = props.details.get(row.user_email)
						const expanded = Boolean(detail)
						const budgetRate = row.budget_usage_rate
						const critical = budgetRate !== null && budgetRate >= 100
						const high = budgetRate !== null && budgetRate >= 80
						let budgetClass = '',
							rowClass = 'hover:bg-muted/30'
						if (high) {
							budgetClass = 'font-medium text-amber-700 dark:text-amber-400'
							rowClass = 'bg-amber-500/5 hover:bg-amber-500/10'
						}
						if (critical) {
							budgetClass = 'font-semibold text-red-700 dark:text-red-400'
							rowClass = 'bg-red-500/5 hover:bg-red-500/10'
						}
						if (expanded) rowClass = 'bg-primary/5'
						return (
							<Fragment key={row.user_email}>
								<tr className={rowClass}>
									<td className='min-w-[200px] px-3 py-3'>
										<div className='flex max-w-64 flex-col items-start gap-1'>
											<button
												type='button'
												className='text-primary text-left font-medium break-all hover:underline'
												aria-expanded={detail?.kind === 'models'}
												aria-label={t(prefix + 'toggleUserModels', {
													email: row.user_email,
												})}
												onClick={() => props.onToggle(row)}
											>
												{detail?.kind === 'models' ? '▾' : '▸'} {row.user_email}
											</button>
											<button
												type='button'
												className='text-primary disabled:text-muted-foreground text-xs underline disabled:no-underline'
												disabled={!row.user_id}
												aria-expanded={detail?.kind === 'keys'}
												aria-label={t(prefix + 'toggleUserKeys', {
													email: row.user_email,
												})}
												onClick={() => props.onToggle(row, 'keys')}
											>
												{t(prefix + 'viewKeys')}
											</button>
											{!row.user_id && (
												<span className='text-muted-foreground text-xs'>
													{t(prefix + 'keysUnavailable')}
												</span>
											)}
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
									<UserMetricCells
										row={row}
										columns={columns}
										currency={props.currency}
										timezone={props.timezone}
										locale={props.locale}
										tokenMode={props.tokenMode}
										budgetClass={budgetClass}
									/>
								</tr>
								{detail?.kind === 'models' && (
									<UserModelDetails
										colSpan={columns.length}
										row={row}
										range={props.range}
										detail={detail.state.rows}
										loading={detail.state.loading}
										error={detail.state.error}
										logsAllowed={props.logsAllowed}
										currency={props.currency}
										locale={props.locale}
										tokenMode={props.tokenMode}
										onRetry={detail.state.retry}
									/>
								)}
								{detail?.kind === 'keys' && (
									<UserKeyDetails
										colSpan={columns.length}
										row={row}
										range={props.range}
										keys={detail.state.rows}
										loading={detail.state.loading}
										error={detail.state.error}
										models={detail.keyModels}
										logsAllowed={props.logsAllowed}
										currency={props.currency}
										timezone={props.timezone}
										locale={props.locale}
										tokenMode={props.tokenMode}
										onToggleKey={detail.toggleKey}
										onRetry={detail.state.retry}
									/>
								)}
							</Fragment>
						)
					})}
				</tbody>
			</table>
			{props.rows.length === 0 && (
				<p className='text-muted-foreground p-8 text-center'>
					{props.emptyMessage ?? t(prefix + 'noData')}
				</p>
			)}
		</div>
	)
}
