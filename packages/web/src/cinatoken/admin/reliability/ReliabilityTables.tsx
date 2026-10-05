/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatMoney, formatNumber } from '../dashboard/dashboard-format'
import type {
	ModelProviderReliability,
	ProviderReliability,
	ReliabilityDisplay,
} from './reliability-contracts'

const prefix = 'cinatoken.adminReliability.'
const columns = [
	'avgLatency',
	'avgUpstream',
	'failoverRate',
	'avgAttempts',
	'standardCost',
	'chargedCost',
	'meteredCost',
] as const

type SharedRow = ProviderReliability | ModelProviderReliability

function ReliabilityCells(props: {
	row: SharedRow
	currency: ReliabilityDisplay['currency']
	locale: string
}) {
	const { t } = useTranslation()
	function money(value: number | undefined): string {
		if (!props.currency) return t(prefix + 'amountUnavailable')
		if (value === undefined) return t(prefix + 'noValue')
		return formatMoney(value, props.currency, props.locale)
	}
	function latency(value: number | null): string {
		return value === null
			? t(prefix + 'noValue')
			: `${formatNumber(Math.round(value), props.locale)} ms`
	}
	return (
		<>
			<td className='px-4 py-3 tabular-nums'>
				{formatNumber(props.row.request_count, props.locale)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{props.row.success_rate.toFixed(1)}%
			</td>
			{'error_count' in props.row && (
				<td className='px-4 py-3 tabular-nums'>
					{formatNumber(props.row.error_count, props.locale)}
				</td>
			)}
			<td className='px-4 py-3 tabular-nums'>
				{latency(props.row.avg_latency_ms)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{latency(props.row.avg_upstream_response_ms)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{props.row.failover_rate.toFixed(1)}%
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{props.row.avg_attempts === null
					? t(prefix + 'noValue')
					: props.row.avg_attempts.toFixed(2)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{money(props.row.standard_cost)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{money(props.row.charged_cost)}
			</td>
			<td className='px-4 py-3 tabular-nums'>
				{money(props.row.metered_cost)}
			</td>
		</>
	)
}

function ReliabilityTable(props: {
	kind: 'providers' | 'modelProviders'
	rows: ProviderReliability[] | ModelProviderReliability[]
	currency: ReliabilityDisplay['currency']
	locale: string
}) {
	const { t } = useTranslation()
	const isModel = props.kind === 'modelProviders'
	return (
		<section className='min-w-0 space-y-3'>
			<h2 className='text-lg font-semibold'>{t(prefix + props.kind)}</h2>
			<div className='bg-card overflow-x-auto rounded-xl border'>
				<table className='w-full min-w-max text-left text-sm'>
					<thead className='bg-muted/60 text-muted-foreground text-xs'>
						<tr>
							{isModel && (
								<th scope='col' className='px-4 py-3'>
									{t(prefix + 'model')}
								</th>
							)}
							<th scope='col' className='px-4 py-3'>
								{t(prefix + 'provider')}
							</th>
							<th scope='col' className='px-4 py-3'>
								{t(prefix + 'requests')}
							</th>
							<th scope='col' className='px-4 py-3'>
								{t(prefix + 'successRate')}
							</th>
							{!isModel && (
								<th scope='col' className='px-4 py-3'>
									{t(prefix + 'errors')}
								</th>
							)}
							{columns.map((column) => (
								<th scope='col' key={column} className='px-4 py-3'>
									{t(prefix + column)}
								</th>
							))}
						</tr>
					</thead>
					<tbody className='divide-y'>
						{props.rows.map((row) => (
							<tr
								key={
									isModel
										? `${(row as ModelProviderReliability).model_id}:${row.provider_id}`
										: row.provider_id
								}
								className='hover:bg-muted/30'
							>
								{isModel && (
									<th
										scope='row'
										className='max-w-56 px-4 py-3 font-medium break-all'
									>
										{(row as ModelProviderReliability).model_id}
									</th>
								)}
								<td className='max-w-56 px-4 py-3 font-medium break-all'>
									{row.provider_name || row.provider_id}
								</td>
								<ReliabilityCells
									row={row}
									currency={props.currency}
									locale={props.locale}
								/>
							</tr>
						))}
					</tbody>
				</table>
				{props.rows.length === 0 && (
					<p className='text-muted-foreground p-8 text-center text-sm'>
						{t(prefix + 'noData')}
					</p>
				)}
			</div>
		</section>
	)
}

export function ReliabilityTables(props: {
	providers: ProviderReliability[]
	modelProviders: ModelProviderReliability[]
	currency: ReliabilityDisplay['currency']
	locale: string
}) {
	return (
		<>
			<ReliabilityTable
				kind='providers'
				rows={props.providers}
				currency={props.currency}
				locale={props.locale}
			/>
			<ReliabilityTable
				kind='modelProviders'
				rows={props.modelProviders}
				currency={props.currency}
				locale={props.locale}
			/>
		</>
	)
}
