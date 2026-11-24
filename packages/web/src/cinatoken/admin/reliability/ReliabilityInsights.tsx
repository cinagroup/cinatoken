/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatMoney, formatNumber } from '../dashboard/dashboard-format'
import type {
	ProviderReliability,
	ReliabilityDisplay,
} from './reliability-contracts'
import { summarizeReliabilityRows } from './reliability-domain'

const prefix = 'cinatoken.adminReliability.'
export function ReliabilityInsights(props: {
	rows: readonly ProviderReliability[]
	currency: ReliabilityDisplay['currency']
	locale: string
}) {
	const { t } = useTranslation()
	const summary = summarizeReliabilityRows(props.rows)
	function money(value: number | null): string {
		if (!props.currency) return t(prefix + 'amountUnavailable')
		if (value === null) return t(prefix + 'noValue')
		return formatMoney(value, props.currency, props.locale)
	}
	const cards = [
		['requests', formatNumber(summary.requests, props.locale)],
		[
			'successRate',
			summary.successRate === null
				? t(prefix + 'noSamples')
				: (summary.successRate / 100).toLocaleString(props.locale, {
						style: 'percent',
						minimumFractionDigits: 1,
						maximumFractionDigits: 1,
					}),
		],
		['errors', formatNumber(summary.errors, props.locale)],
		['chargedCost', money(summary.charged)],
		['meteredCost', money(summary.metered)],
		['costDifference', money(summary.costDifference)],
	]
	return (
		<section
			aria-label={t(prefix + 'insightsTitle')}
			className='bg-card min-w-0 space-y-4 rounded-xl border p-4'
		>
			<h2 className='text-lg font-semibold'>{t(prefix + 'insightsTitle')}</h2>
			<dl className='grid grid-cols-2 gap-4 lg:grid-cols-3'>
				{cards.map(([key, value]) => (
					<div key={key} className='min-w-0'>
						<dt className='text-muted-foreground text-xs'>{t(prefix + key)}</dt>
						<dd className='mt-1 text-lg font-semibold break-words tabular-nums'>
							{value}
						</dd>
					</div>
				))}
			</dl>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'outcomes', {
					success: formatNumber(summary.successes, props.locale),
					errors: formatNumber(summary.errors, props.locale),
					other: formatNumber(summary.other, props.locale),
				})}
			</p>
			{summary.requests > 0 && (
				<div
					aria-hidden='true'
					className='flex h-1.5 overflow-hidden rounded-full'
				>
					<div
						className='bg-primary'
						style={{
							width: `${(100 * summary.successes) / summary.requests}%`,
						}}
					/>
					<div
						className='bg-destructive'
						style={{ width: `${(100 * summary.errors) / summary.requests}%` }}
					/>
					<div
						className='bg-muted-foreground'
						style={{ width: `${(100 * summary.other) / summary.requests}%` }}
					/>
				</div>
			)}
			<details className='text-muted-foreground rounded-lg border p-3 text-xs'>
				<summary className='cursor-pointer font-medium'>
					{t(prefix + 'definitions')}
				</summary>
				<div className='mt-3 space-y-2 leading-relaxed'>
					<p>{t(prefix + 'summaryScope')}</p>
					<p>{t(prefix + 'outcomeNote')}</p>
					<p>{t(prefix + 'costNote', { standard: money(summary.standard) })}</p>
					<p>{t(prefix + 'failoverNote')}</p>
				</div>
			</details>
		</section>
	)
}
