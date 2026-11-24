/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { AnalyticsQualityHelp } from '../models/AnalyticsQualityMetrics'
import { ModelMetricCells } from '../models/ModelMetricCells'
import type { AnalyticsDetailState } from '../models/analytics-drilldowns'
import {
	analyticsVisibleColumns,
	type AnalyticsView,
} from '../models/analytics-view'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from '../models/model-analytics-contracts'
import type { SortDirection, TokenMode } from '../models/model-analytics-domain'
import { ProviderDimensionInfo } from './ProviderDimensionInfo'
import { ProviderModelDetails } from './ProviderModelDetails'
import type { AnalyticsProviderDirectory } from './analytics-provider-directory'
import {
	providerSortKeys,
	type ProviderSortKey,
} from './provider-analytics-domain'

const prefix = 'cinatoken.adminProviderAnalytics.'

export function ProviderAnalyticsTable(props: {
	directory?: AnalyticsProviderDirectory
	view?: AnalyticsView
	emptyMessage?: string
	rows: ModelProviderRow[]
	range: { startUtc: string; endUtc: string }
	tag: string
	details: ReadonlyMap<string, AnalyticsDetailState<ModelAnalyticsRow>>
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
	sortKey: ProviderSortKey
	sortDirection: SortDirection
	onSort: (key: ProviderSortKey) => void
	onToggle: (row: ModelProviderRow) => void
}) {
	const { t } = useTranslation()
	const view = props.view ?? 'all'
	const columns = analyticsVisibleColumns(providerSortKeys, view)
	const width = {
		overview: 'min-w-[850px]',
		cost: 'min-w-[1150px]',
		performance: 'min-w-[1300px]',
		all: 'min-w-[2000px]',
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
							const detail = props.details.get(row.provider_id)
							const expanded = detail !== undefined
							return (
								<Fragment key={row.provider_id}>
									<tr
										className={expanded ? 'bg-primary/5' : 'hover:bg-muted/30'}
									>
										<td className='px-3 py-3'>
											<button
												type='button'
												className='text-primary max-w-56 text-left font-medium break-all hover:underline'
												aria-expanded={expanded}
												aria-label={t(prefix + 'toggleProviderDetails', {
													provider: row.provider_name ?? row.provider_id,
													id: row.provider_id,
												})}
												onClick={() => props.onToggle(row)}
											>
												{expanded ? '▾' : '▸'}{' '}
												{row.provider_name ?? row.provider_id}
											</button>
										</td>
										<td className='px-3 py-3'>
											<ProviderDimensionInfo
												providerId={row.provider_id}
												directory={props.directory}
												locale={props.locale}
											/>
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
										<ProviderModelDetails
											colSpan={columns.length}
											row={row}
											range={props.range}
											tag={props.tag}
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
