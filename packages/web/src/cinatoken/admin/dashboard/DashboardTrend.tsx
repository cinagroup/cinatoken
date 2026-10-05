/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { DashboardStats } from './dashboard-contracts'
import { bucketTime, formatTime } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'

export function TokenTrend(props: {
	rows: DashboardStats['timeseries']
	timezone: string
	locale: string
}) {
	const { t } = useTranslation()
	const rows = props.rows
	const width = 680
	const height = 180
	const top = 10
	const bottom = 166
	const maximum = Math.max(1, ...rows.map((row) => row.total_tokens))
	function points(field: 'input_tokens' | 'output_tokens'): string {
		return rows
			.map((row, index) => {
				const x =
					rows.length === 1 ? width / 2 : (index / (rows.length - 1)) * width
				const y = bottom - (row[field] / maximum) * (bottom - top)
				return `${x.toFixed(1)},${y.toFixed(1)}`
			})
			.join(' ')
	}
	return (
		<section
			className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
			aria-labelledby='dashboard-trend-title'
		>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h2 id='dashboard-trend-title' className='text-lg font-semibold'>
					{t(prefix + 'tokenTrend')}
				</h2>
				{rows.length > 0 ? (
					<p className='text-muted-foreground text-xs'>
						{formatTime(
							bucketTime(rows[0]!.bucket),
							props.timezone,
							props.locale
						)}
						{' – '}
						{formatTime(
							bucketTime(rows[rows.length - 1]!.bucket),
							props.timezone,
							props.locale
						)}
					</p>
				) : null}
			</div>
			{rows.length === 0 ? (
				<p className='text-muted-foreground py-12 text-center text-sm'>
					{t(prefix + 'noTrend')}
				</p>
			) : (
				<>
					<div className='bg-muted/20 mt-4 rounded-lg border p-3'>
						<svg
							className='h-44 w-full'
							viewBox={`0 0 ${width} ${height}`}
							preserveAspectRatio='none'
							aria-hidden='true'
						>
							<line
								x1='0'
								x2={width}
								y1={bottom}
								y2={bottom}
								stroke='currentColor'
								opacity='.2'
							/>
							<line
								x1='0'
								x2={width}
								y1={(top + bottom) / 2}
								y2={(top + bottom) / 2}
								stroke='currentColor'
								opacity='.1'
							/>
							<polyline
								points={points('input_tokens')}
								fill='none'
								stroke='#2563eb'
								strokeWidth='3'
								vectorEffect='non-scaling-stroke'
							/>
							<polyline
								points={points('output_tokens')}
								fill='none'
								stroke='#a855f7'
								strokeWidth='3'
								vectorEffect='non-scaling-stroke'
							/>
						</svg>
					</div>
					<div className='mt-3 flex flex-wrap gap-4 text-xs'>
						<span className='flex items-center gap-2'>
							<span
								className='h-2 w-3 rounded bg-blue-600'
								aria-hidden='true'
							/>
							{t(prefix + 'inputTokens')}
						</span>
						<span className='flex items-center gap-2'>
							<span
								className='h-2 w-3 rounded bg-purple-500'
								aria-hidden='true'
							/>
							{t(prefix + 'outputTokens')}
						</span>
					</div>
					<table className='sr-only'>
						<caption>{t(prefix + 'tokenTrend')}</caption>
						<thead>
							<tr>
								<th>{t(prefix + 'trendBucket')}</th>
								<th>{t(prefix + 'inputTokens')}</th>
								<th>{t(prefix + 'outputTokens')}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.bucket}>
									<th>{row.bucket}</th>
									<td>{row.input_tokens}</td>
									<td>{row.output_tokens}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			)}
		</section>
	)
}
