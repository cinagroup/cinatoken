/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ModelMetricCells } from './ModelMetricCells'
import { ModelProviderDetails } from './ModelProviderDetails'
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
	rows: ModelAnalyticsRow[]
	range: { startUtc: string; endUtc: string }
	active: { modelId: string; routeGroup: string } | null
	detail: ModelProviderRow[] | undefined
	detailLoading: boolean
	detailError: boolean
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
	sortKey: ModelSortKey
	sortDirection: SortDirection
	onSort: (key: ModelSortKey) => void
	onToggle: (row: ModelAnalyticsRow) => void
	onRetry: () => void
}) {
	const { t } = useTranslation()
	return (
		<div
			className='bg-card overflow-x-auto rounded-xl border'
			role='region'
			aria-label={t(prefix + 'table')}
			tabIndex={0}
		>
			<table className='w-full min-w-[1650px] text-left text-sm'>
				<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
					<tr>
						{modelSortKeys.map((key) => {
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
						const expanded =
							props.active?.modelId === row.model_id &&
							props.active.routeGroup === row.route_group
						return (
							<Fragment key={JSON.stringify([row.model_id, row.route_group])}>
								<tr className={expanded ? 'bg-primary/5' : 'hover:bg-muted/30'}>
									<td className='px-3 py-3'>
										<button
											type='button'
											className='text-primary max-w-56 text-left font-medium break-all hover:underline'
											aria-expanded={expanded}
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
										currency={props.currency}
										locale={props.locale}
										tokenMode={props.tokenMode}
									/>
								</tr>
								{expanded && (
									<ModelProviderDetails
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
