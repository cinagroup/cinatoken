/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type {
	DashboardDisplayConfig,
	DashboardStats,
} from './dashboard-contracts'
import { formatCompact, formatMoney, formatNumber } from './dashboard-format'
import {
	bucketLabel,
	trendGeometry,
	trendSeries,
	type TrendView,
} from './dashboard-trend'

const prefix = 'cinatoken.adminDashboard.'
const views = ['requests', 'tokens', 'cost', 'latency'] as const
export function TokenTrend(props: {
	rows: DashboardStats['timeseries']
	timezone: string
	locale: string
	currency: DashboardDisplayConfig['billingCurrency']
	granularity: 'hour' | 'day'
}) {
	const { t } = useTranslation()
	const [view, setView] = useState<TrendView>('requests')
	const [selected, setSelected] = useState('')
	const host = useRef<HTMLDivElement>(null)
	const [width, setWidth] = useState(600)
	useEffect(() => {
		const element = host.current
		if (!element) return
		const observer = new ResizeObserver((entries) =>
			setWidth(Math.max(260, entries[0]?.contentRect.width ?? 600))
		)
		observer.observe(element)
		return () => observer.disconnect()
	}, [])
	const geometry = trendGeometry(props.rows, view, props.granularity, width)
	const active =
		geometry.rows.find((row) => row.bucket === selected) ?? geometry.rows.at(-1)
	function valueLabel(value: number | null): string {
		if (value === null) return t(prefix + 'noSample')
		if (view === 'cost')
			return formatMoney(value, props.currency, props.locale, 6)
		if (view === 'latency') return `${formatNumber(value, props.locale)} ms`
		return formatNumber(value, props.locale)
	}
	return (
		<section
			className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
			aria-labelledby='dashboard-trend-title'
		>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<h2 id='dashboard-trend-title' className='text-lg font-semibold'>
					{t(prefix + 'operationalTrend')}
				</h2>
				<div
					role='group'
					aria-label={t(prefix + 'trendMetric')}
					className='flex flex-wrap gap-2'
				>
					{views.map((metric) => (
						<Button
							key={metric}
							size='sm'
							variant={view === metric ? 'default' : 'outline'}
							aria-pressed={view === metric}
							onClick={() => setView(metric)}
						>
							{t(prefix + metric)}
						</Button>
					))}
				</div>
			</div>
			<p className='text-muted-foreground mt-2 text-xs'>
				{t(prefix + 'bucketZone', { timezone: props.timezone })} ·{' '}
				{t(prefix + props.granularity)}
			</p>
			<div ref={host} className='min-w-0'>
				{geometry.rows.length === 0 ? (
					<p className='text-muted-foreground py-12 text-center text-sm'>
						{t(prefix + 'noTrend')}
					</p>
				) : (
					<>
						<svg
							className='mt-4 h-48 w-full'
							viewBox={`0 0 ${width} 192`}
							aria-hidden='true'
						>
							{[
								geometry.min,
								(geometry.min + geometry.max) / 2,
								geometry.max,
							].map((value, index) => (
								<g key={index}>
									<line
										x1={geometry.left}
										x2={geometry.right}
										y1={geometry.y(value)}
										y2={geometry.y(value)}
										stroke='currentColor'
										opacity='.12'
									/>
									<text
										x={geometry.left - 8}
										y={geometry.y(value) + 4}
										textAnchor='end'
										fill='currentColor'
										fontSize='11'
									>
										{formatCompact(value, props.locale)}
									</text>
								</g>
							))}
							{geometry.min < 0 && (
								<line
									x1={geometry.left}
									x2={geometry.right}
									y1={geometry.y(0)}
									y2={geometry.y(0)}
									stroke='currentColor'
									opacity='.4'
								/>
							)}
							{geometry.paths.map((path) => (
								<g key={path.field}>
									{path.segments.map((d, index) => (
										<path
											key={index}
											d={d}
											fill='none'
											stroke={path.color}
											strokeDasharray={path.dash}
											strokeWidth='2'
										/>
									))}
									{path.points.map((point) => (
										<circle
											key={point.bucket}
											cx={point.x}
											cy={point.y}
											r={point.bucket === active?.bucket ? 4 : 2.5}
											fill={path.color}
										/>
									))}
								</g>
							))}
							{active && (
								<line
									x1={geometry.x(active)}
									x2={geometry.x(active)}
									y1={geometry.top}
									y2={geometry.bottom}
									stroke='currentColor'
									strokeDasharray='3 4'
									opacity='.3'
								/>
							)}
						</svg>
						<div className='text-muted-foreground flex justify-between gap-3 text-xs'>
							<span>{bucketLabel(geometry.rows[0]!.bucket)}</span>
							{geometry.rows.length > 1 && (
								<span className='text-right'>
									{bucketLabel(geometry.rows.at(-1)!.bucket)}
								</span>
							)}
						</div>
						<div className='mt-4 flex flex-wrap items-end gap-4'>
							<label className='grid max-w-full gap-1 text-xs font-medium'>
								{t(prefix + 'inspectBucket')}
								<select
									className='bg-background h-10 max-w-full rounded-md border px-3 text-sm'
									value={active?.bucket ?? ''}
									onChange={(e) => setSelected(e.target.value)}
								>
									{geometry.rows.map((row) => (
										<option key={row.bucket} value={row.bucket}>
											{bucketLabel(row.bucket)}
										</option>
									))}
								</select>
							</label>
							<dl aria-live='polite' className='flex flex-wrap gap-x-6 gap-y-2'>
								{geometry.paths.map((path) => (
									<div key={path.field}>
										<dt className='text-muted-foreground flex items-center gap-2 text-xs'>
											<svg width='20' height='8' aria-hidden='true'>
												<line
													x1='0'
													x2='20'
													y1='4'
													y2='4'
													stroke={path.color}
													strokeWidth='2'
													strokeDasharray={path.dash}
												/>
											</svg>
											{t(prefix + path.label)}
											{view === 'cost' ? ` (${props.currency})` : ''}
										</dt>
										<dd className='mt-1 text-sm font-medium tabular-nums'>
											{valueLabel(active?.[path.field] ?? null)}
										</dd>
									</div>
								))}
							</dl>
						</div>
						<p className='text-muted-foreground mt-3 text-xs'>
							{t(prefix + 'trendGaps')}
						</p>
						<details className='mt-4'>
							<summary className='cursor-pointer py-2 text-sm font-medium'>
								{t(prefix + 'trendDetails')}
							</summary>
							<div className='overflow-x-auto'>
								<table className='w-full text-left text-sm'>
									<caption className='sr-only'>
										{t(prefix + 'operationalTrend')} · {t(prefix + view)}
									</caption>
									<thead>
										<tr>
											<th scope='col' className='p-2 whitespace-nowrap'>
												{t(prefix + 'trendBucket')}
											</th>
											{trendSeries[view].map((s) => (
												<th
													key={s.field}
													scope='col'
													className='p-2 text-right whitespace-nowrap'
												>
													{t(prefix + s.label)}
												</th>
											))}
										</tr>
									</thead>
									<tbody>
										{geometry.rows.map((row) => (
											<tr key={row.bucket} className='border-t'>
												<th
													scope='row'
													className='p-2 font-normal whitespace-nowrap'
												>
													{bucketLabel(row.bucket)}
												</th>
												{trendSeries[view].map((s) => (
													<td
														key={s.field}
														className='p-2 text-right whitespace-nowrap tabular-nums'
													>
														{valueLabel(row[s.field])}
													</td>
												))}
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</details>
					</>
				)}
			</div>
		</section>
	)
}
