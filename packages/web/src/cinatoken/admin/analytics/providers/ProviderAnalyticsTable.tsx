/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { ModelMetricCells } from '../models/ModelMetricCells'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from '../models/model-analytics-contracts'
import type { SortDirection, TokenMode } from '../models/model-analytics-domain'
import { ProviderModelDetails } from './ProviderModelDetails'
import {
	providerSortKeys,
	type ProviderSortKey,
} from './provider-analytics-domain'

const prefix = 'cinatoken.adminProviderAnalytics.'

export function ProviderAnalyticsTable(props: {
	rows: ModelProviderRow[]
	range: { startUtc: string; endUtc: string }
	tag: string
	active: { providerId: string } | null
	detail: ModelAnalyticsRow[] | undefined
	detailLoading: boolean
	detailError: boolean
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
	sortKey: ProviderSortKey
	sortDirection: SortDirection
	onSort: (key: ProviderSortKey) => void
	onToggle: (row: ModelProviderRow) => void
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
			<table className='w-full min-w-[1550px] text-left text-sm'>
				<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
					<tr>
						{providerSortKeys.map((key) => {
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
						const expanded = props.active?.providerId === row.provider_id
						return (
							<Fragment key={row.provider_id}>
								<tr className={expanded ? 'bg-primary/5' : 'hover:bg-muted/30'}>
									<td className='px-3 py-3'>
										<button
											type='button'
											className='text-primary max-w-56 text-left font-medium break-all hover:underline'
											aria-expanded={expanded}
											onClick={() => props.onToggle(row)}
										>
											{expanded ? '▾' : '▸'}{' '}
											{row.provider_name ?? row.provider_id}
										</button>
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
									<ProviderModelDetails
										row={row}
										range={props.range}
										tag={props.tag}
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
