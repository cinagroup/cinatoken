/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { DashboardComparison } from './DashboardComparison'
import type { DashboardSnapshot } from './dashboard-contracts'
import { formatMoney, formatNumber } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'
const panel = 'min-w-0 space-y-4 rounded-xl border p-5'
type Props = { snapshot: DashboardSnapshot; locale: string }

/** Only verified aggregate data is displayed; raw request details stay in logs. */
export function DashboardOperations(props: Props) {
	const { t } = useTranslation()
	const operations = props.snapshot.stats.operations
	if (!operations) return null
	const current = operations.current
	const money = (value: number) =>
		formatMoney(
			value,
			props.snapshot.displayConfig.billingCurrency,
			props.locale
		)
	const number = (value: number) => formatNumber(value, props.locale)
	const fraction = (value: number, total: number) =>
		total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—'
	const ratio = (value: number) =>
		current.standard > 0 ? `×${(value / current.standard).toFixed(2)}` : '—'
	const spread = current.charged - current.metered
	const bounds = new URLSearchParams({
		start_date: operations.window.startDate,
		// Stats bounds are half-open; log and reliability filters use inclusive seconds.
		end_date: new Date(
			Date.parse(operations.window.endDate.replace(' ', 'T') + 'Z') - 1000
		)
			.toISOString()
			.slice(0, 19)
			.replace('T', ' '),
		range: 'custom',
	})
	const errorBounds = new URLSearchParams(bounds)
	errorBounds.set('status', 'error')
	const logsHref = `/admin/request-logs?${errorBounds}`

	const costs = [
		{ label: 'spread', value: money(spread) },
		{ label: 'spreadRate', value: fraction(spread, current.charged) },
		{ label: 'chargeFactor', value: ratio(current.charged) },
		{ label: 'meteredFactor', value: ratio(current.metered) },
		{ label: 'failedCost', value: money(current.errorCost) },
	]
	const quality = [
		{
			label: 'failover',
			value: fraction(current.failoverRequests, current.failoverSamples),
			hint: `${number(current.failoverRequests)} / ${number(current.failoverSamples)}`,
		},
		{
			label: 'attempts',
			value: current.avgAttempts?.toFixed(2) ?? '—',
			hint: t(prefix + 'samples', { count: current.attemptsSamples }),
		},
		{ label: 'statusIncomplete', value: number(current.incomplete) },
		{ label: 'statusCancelled', value: number(current.cancelled) },
	]
	return (
		<>
			<DashboardComparison snapshot={props.snapshot} locale={props.locale} />
			<div className='grid gap-5 lg:grid-cols-2'>
				<section className={panel} aria-label={t(prefix + 'costEfficiency')}>
					<h2 className='font-medium'>{t(prefix + 'costEfficiency')}</h2>
					<dl className='space-y-3'>
						{costs.map((row) => (
							<div
								key={row.label}
								className='flex flex-wrap justify-between gap-2 text-sm'
							>
								<dt className='text-muted-foreground'>
									{t(prefix + row.label)}
								</dt>
								<dd className='font-mono tabular-nums'>{row.value}</dd>
							</div>
						))}
					</dl>
				</section>
				<section className={panel} aria-label={t(prefix + 'quality')}>
					<div className='flex flex-wrap justify-between gap-2'>
						<h2 className='font-medium'>{t(prefix + 'quality')}</h2>
						<a
							className='text-sm underline underline-offset-4'
							href='/admin/analytics/reliability'
						>
							{t(prefix + 'viewReliability')}
						</a>
					</div>
					<dl className='grid grid-cols-2 gap-4'>
						{quality.map((row) => (
							<div key={row.label}>
								<dt className='text-muted-foreground text-sm'>
									{t(prefix + row.label)}
								</dt>
								<dd className='mt-1 font-mono text-lg tabular-nums'>
									{row.value}
								</dd>
								{row.hint && (
									<dd className='text-muted-foreground text-xs'>{row.hint}</dd>
								)}
							</div>
						))}
					</dl>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'coverageBasis')}
					</p>
					<a
						href={logsHref}
						className='inline-block text-sm underline underline-offset-4'
					>
						{t(prefix + 'recentErrors')}
					</a>
					<dl className='flex flex-wrap gap-x-5 gap-y-2 text-xs'>
						{operations.errorCategories.map((row) => (
							<div key={row.category} className='flex gap-2'>
								<dt className='text-muted-foreground'>
									{t(prefix + 'category_' + row.category)}
								</dt>
								<dd className='font-mono tabular-nums'>{number(row.count)}</dd>
							</div>
						))}
					</dl>
				</section>
			</div>
			{operations.providers.length > 0 && (
				<section className={panel} aria-label={t(prefix + 'problemProviders')}>
					<h2 className='font-medium'>{t(prefix + 'problemProviders')}</h2>
					<ul className='divide-y'>
						{operations.providers.map((provider, index) => {
							const params = new URLSearchParams(errorBounds)
							params.set('provider_id', provider.id)
							const details = (
								<>
									<span className='min-w-0 break-words'>
										{provider.name || t(prefix + 'unknownProvider')}
										<span className='text-muted-foreground block text-xs'>
											{t(prefix + 'affectedUsers', {
												count: provider.affectedUsers,
											})}
										</span>
									</span>
									<span className='shrink-0 text-right font-mono text-sm tabular-nums'>
										{fraction(provider.errors, provider.requests)}
										<span className='text-muted-foreground block text-xs'>
											{number(provider.errors)} / {number(provider.requests)}
										</span>
									</span>
								</>
							)
							return (
								<li key={provider.id || index}>
									{provider.id ? (
										<a
											href={`/admin/request-logs?${params}`}
											className='flex justify-between gap-4 py-3 hover:underline'
										>
											{details}
										</a>
									) : (
										<div className='flex justify-between gap-4 py-3'>
											{details}
										</div>
									)}
								</li>
							)
						})}
					</ul>
				</section>
			)}
		</>
	)
}
