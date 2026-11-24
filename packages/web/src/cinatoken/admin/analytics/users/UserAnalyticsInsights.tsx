/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatAnalyticsMoney } from '../models/model-analytics-domain'
import type { UserAnalyticsInsightsSummary } from './user-analytics-insights'

const prefix = 'cinatoken.adminUserAnalytics.'
export function UserAnalyticsInsights(props: {
	summary: UserAnalyticsInsightsSummary
	currency: 'USD' | 'CNY' | null
	locale: string
}) {
	const { t } = useTranslation()
	const summary = props.summary
	const count = (value: number | null): string =>
		value === null
			? t(prefix + 'insightsUnknown')
			: value.toLocaleString(props.locale)
	const money = (value: number | null): string =>
		formatAnalyticsMoney(value ?? undefined, props.currency, props.locale) ??
		(props.currency ? '—' : t(prefix + 'hidden'))
	function successRate(): string {
		if (summary.successRate === null)
			return t(
				prefix +
					(summary.requests === 0 ? 'insightsNoSamples' : 'insightsUnknown')
			)
		return (summary.successRate / 100).toLocaleString(props.locale, {
			style: 'percent',
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		})
	}
	const cards = [
		['insightsRequests', count(summary.requests)],
		['insightsSuccessRate', successRate()],
		['insightsErrors', count(summary.errors)],
		['charged_cost', money(summary.charged)],
		['metered_cost', money(summary.metered)],
		['insightsCostDifference', money(summary.costDifference)],
	]
	return (
		<section
			aria-label={t(prefix + 'insightsTitle')}
			className='bg-card min-w-0 space-y-4 rounded-xl border p-4'
		>
			<h2 className='text-sm font-semibold'>{t(prefix + 'insightsTitle')}</h2>
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
				{t(prefix + 'insightsOutcomes', {
					success: count(summary.successes),
					errors: count(summary.errors),
					other: count(summary.other),
				})}
			</p>
			{summary.requests > 0 &&
				summary.successes !== null &&
				summary.other !== null && (
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
			<details className='text-muted-foreground rounded-lg border p-3 text-xs'>
				<summary className='cursor-pointer font-medium'>
					{t(prefix + 'insightsDefinitions')}
				</summary>
				<div className='mt-3 space-y-2 leading-relaxed'>
					<p>{t(prefix + 'insightsScopeUsers')}</p>
					<p>{t(prefix + 'insightsExactCounts')}</p>
					<p>{t(prefix + 'insightsCostNote')}</p>
					<p>
						{t(prefix + 'budgetScope')} {t(prefix + 'walletScope')}
					</p>
				</div>
			</details>
		</section>
	)
}
