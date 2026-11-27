/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { DashboardSnapshot } from './dashboard-contracts'
import { formatMoney, formatNumber } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'
const panel = 'min-w-0 space-y-4 rounded-xl border p-5'
export function DashboardComparison(props: {
	snapshot: DashboardSnapshot
	locale: string
}) {
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
	const timing = (value: number | null) =>
		value === null ? '—' : `${number(Math.round(value))} ms`
	const fraction = (value: number, total: number) =>
		total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '—'
	const comparisonRows = [
		{
			label: t(prefix + 'requests'),
			render: (p: typeof current) => number(p.requests),
		},
		{
			label: t(prefix + 'successRate'),
			render: (p: typeof current) => fraction(p.success, p.requests),
		},
		{
			label: t(prefix + 'ttftP95'),
			render: (p: typeof current) => timing(p.ttftP95),
		},
		{
			label: t(prefix + 'latencyP95'),
			render: (p: typeof current) => timing(p.latencyP95),
		},
		{
			label: t(prefix + 'rangeCost'),
			render: (p: typeof current) => money(p.charged),
		},
		{
			label: t(prefix + 'meteredLabel'),
			render: (p: typeof current) => money(p.metered),
		},
	]
	const date = (sql: string) =>
		new Intl.DateTimeFormat(props.locale, {
			dateStyle: 'short',
			timeStyle: 'short',
			timeZone: props.snapshot.displayConfig.businessTimezone,
		}).format(new Date(sql.replace(' ', 'T') + 'Z'))
	return (
		<section className={panel} aria-label={t(prefix + 'periodComparison')}>
			<h2 className='font-medium'>{t(prefix + 'periodComparison')}</h2>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'previousWindow', {
					start: date(operations.window.previousStart),
					end: date(operations.window.previousEnd),
				})}
			</p>
			<div className='grid gap-4 sm:grid-cols-2'>
				{(['ttft', 'latency'] as const).map((metric) => (
					<div key={metric} className='bg-muted/40 rounded-lg p-4'>
						<h3 className='text-muted-foreground text-sm'>
							{t(prefix + (metric === 'ttft' ? 'ttftP95' : 'latencyP95'))}
						</h3>
						<p className='mt-2 font-mono text-2xl tabular-nums'>
							{timing(current[`${metric}P95`])}
						</p>
						<p className='text-muted-foreground mt-1 text-xs'>
							P50 {timing(current[`${metric}P50`])} ·{' '}
							{t(prefix + 'samples', { count: current[`${metric}Samples`] })}
						</p>
					</div>
				))}
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'timingBasis')}
			</p>
			<div className='overflow-x-auto'>
				<table className='w-full text-sm'>
					<thead>
						<tr className='border-b text-left'>
							<th scope='col' className='py-2 font-medium'>
								{t(prefix + 'metric')}
							</th>
							<th scope='col' className='text-right font-medium'>
								{t(prefix + 'selectedRange')}
							</th>
							<th scope='col' className='pl-4 text-right font-medium'>
								{t(prefix + 'previousRange')}
							</th>
						</tr>
					</thead>
					<tbody>
						{comparisonRows.map((row) => (
							<tr key={row.label} className='border-b last:border-0'>
								<th scope='row' className='py-2 text-left font-normal'>
									{row.label}
								</th>
								<td className='text-right font-mono tabular-nums'>
									{row.render(current)}
								</td>
								<td className='text-muted-foreground pl-4 text-right font-mono tabular-nums'>
									{row.render(operations.previous)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}
