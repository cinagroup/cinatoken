/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import type { AnalyticsProviderDirectory } from '../providers/analytics-provider-directory'
import { AnalyticsQualityHelp } from './AnalyticsQualityMetrics'
import { ModelMetricCells } from './ModelMetricCells'
import { ModelProviderDetails } from './ModelProviderDetails'
import type { AnalyticsDetailState } from './analytics-drilldowns'
import { analyticsVisibleColumns, type AnalyticsView } from './analytics-view'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from './model-analytics-contracts'
import {
	modelSortKeys,
	type ModelSortKey,
	type SortDirection,
	type TokenMode,
} from './model-analytics-domain'

const prefix = 'cinatoken.adminModelAnalytics.'

export function ModelAnalyticsTable(props: {
	directory?: AnalyticsProviderDirectory
	view?: AnalyticsView
	emptyMessage?: string
	rows: ModelAnalyticsRow[]
	range: { startUtc: string; endUtc: string }
	details: ReadonlyMap<string, AnalyticsDetailState<ModelProviderRow>>
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
	sortKey: ModelSortKey
	sortDirection: SortDirection
	onSort: (key: ModelSortKey) => void
	onToggle: (row: ModelAnalyticsRow) => void
}) {
	const { t } = useTranslation()
	const view = props.view ?? 'all'
	const columns = analyticsVisibleColumns(modelSortKeys, view)
	const width = {
		overview: 'min-w-[800px]',
		cost: 'min-w-[1100px]',
		performance: 'min-w-[1250px]',
		all: 'min-w-[1950px]',
	}[view]
	return (
		<div className='bg-card rounded-xl border'>
			<AnalyticsQualityHelp />
			<div
				className='overflow-x-auto'
				role='region'
				aria-label={t(prefix + 'table')}
				tabIndex={0}
			>
				<table className={`w-full text-left text-sm ${width}`}>
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
										className='px-3 py-3 font-semibold whitespace-nowrap'
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
							const detail = props.details.get(
								JSON.stringify([row.model_id, row.route_group])
							)
							const expanded = detail !== undefined
							return (
								<Fragment key={JSON.stringify([row.model_id, row.route_group])}>
									<tr
										className={expanded ? 'bg-primary/5' : 'hover:bg-muted/30'}
									>
										<td className='px-3 py-3'>
											<button
												type='button'
												className='text-primary max-w-56 text-left font-medium break-all hover:underline'
												aria-expanded={expanded}
												aria-label={t(prefix + 'toggleModelDetails', {
													model: row.model_id,
													group: row.route_group,
												})}
												onClick={() => props.onToggle(row)}
											>
												{expanded ? '▾' : '▸'} {row.model_id}
											</button>
										</td>
										<td className='px-3 py-3 font-mono break-all'>
											{row.route_group}
										</td>
										<ModelMetricCells
											row={row}
											kind='main'
											view={view}
											currency={props.currency}
											locale={props.locale}
											tokenMode={props.tokenMode}
										/>
									</tr>
									{detail && (
										<ModelProviderDetails
											directory={props.directory}
											colSpan={columns.length}
											row={row}
											range={props.range}
											detail={detail.rows}
											loading={detail.loading}
											error={detail.error}
											logsAllowed={props.logsAllowed}
											currency={props.currency}
											locale={props.locale}
											tokenMode={props.tokenMode}
											onRetry={detail.retry}
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
		</div>
	)
}
