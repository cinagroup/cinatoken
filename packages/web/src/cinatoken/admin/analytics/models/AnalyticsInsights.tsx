/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AnalyticsInsightsSummary } from './analytics-insights'
import { formatAnalyticsMoney } from './model-analytics-domain'

const prefix = 'cinatoken.adminModelAnalytics.'

export function AnalyticsInsights(props: {
	summary: AnalyticsInsightsSummary
	currency: 'USD' | 'CNY' | null
	locale: string
	scope: 'models' | 'providers'
}) {
	const { t } = useTranslation()
	const summary = props.summary
	const count = (value: number): string => value.toLocaleString(props.locale)
	const cards = [
		{ key: 'insightsRequests', value: count(summary.requests) },
		{
			key: 'insightsSuccessRate',
			value:
				summary.successRate === null
					? t(prefix + 'insightsNoSamples')
					: (summary.successRate / 100).toLocaleString(props.locale, {
							style: 'percent',
							minimumFractionDigits: 1,
							maximumFractionDigits: 1,
						}),
		},
		{ key: 'insightsErrors', value: count(summary.errors) },
		{
			key: 'insightsCostDifference',
			value: props.currency
				? formatAnalyticsMoney(
						summary.costDifference,
						props.currency,
						props.locale
					)
				: t(prefix + 'hidden'),
		},
	]
	return (
		<section
			aria-label={t(prefix + 'insightsTitle')}
			className='bg-card flex min-w-0 flex-col gap-4 rounded-xl border p-4'
		>
			<h2 className='text-sm font-semibold'>{t(prefix + 'insightsTitle')}</h2>
			<dl className='grid min-w-0 grid-cols-2 gap-4 lg:grid-cols-4'>
				{cards.map((card) => (
					<div key={card.key} className='flex min-w-0 flex-col gap-1'>
						<dt className='text-muted-foreground text-xs'>
							{t(prefix + card.key)}
						</dt>
						<dd className='text-lg font-semibold break-words tabular-nums'>
							{card.value}
						</dd>
					</div>
				))}
			</dl>
			<div className='flex flex-col gap-2'>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'insightsOutcomes', {
						success: count(summary.successes),
						errors: count(summary.errors),
						other: count(summary.other),
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
								width: `${(summary.successes / summary.requests) * 100}%`,
							}}
						/>
						<div
							className='bg-destructive'
							style={{ width: `${(summary.errors / summary.requests) * 100}%` }}
						/>
						<div
							className='bg-muted-foreground'
							style={{ width: `${(summary.other / summary.requests) * 100}%` }}
						/>
					</div>
				)}
			</div>
			<details className='text-muted-foreground rounded-lg border p-3 text-xs'>
				<summary className='cursor-pointer font-medium'>
					{t(prefix + 'insightsDefinitions')}
				</summary>
				<div className='mt-3 flex flex-col gap-2 leading-relaxed'>
					<p>
						{t(
							prefix +
								(props.scope === 'models'
									? 'insightsScopeModels'
									: 'insightsScopeProviders')
						)}
					</p>
					<p>{t(prefix + 'insightsRateNote')}</p>
					<p>{t(prefix + 'insightsOtherNote')}</p>
					<p>{t(prefix + 'insightsCostNote')}</p>
				</div>
			</details>
		</section>
	)
}
