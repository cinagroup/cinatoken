/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type {
	DashboardDisplayConfig,
	DashboardStats,
} from './dashboard-contracts'
import { formatMoney, formatNumber } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'

export function UsagePanels(props: {
	stats: DashboardStats
	currency: DashboardDisplayConfig['billingCurrency']
	locale: string
}) {
	const { t } = useTranslation()
	const maximum = Math.max(
		1,
		...props.stats.modelDistribution.map((row) => row.request_count)
	)
	return (
		<div className='grid gap-5 xl:grid-cols-2'>
			<section
				className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
				aria-labelledby='dashboard-models-title'
			>
				<h2 id='dashboard-models-title' className='text-lg font-semibold'>
					{t(prefix + 'modelDistribution')}
				</h2>
				{props.stats.modelDistribution.length === 0 ? (
					<p className='text-muted-foreground py-8 text-sm'>
						{t(prefix + 'noModels')}
					</p>
				) : (
					<ol className='mt-4 space-y-4'>
						{props.stats.modelDistribution.map((row) => (
							<li key={row.model_id} className='min-w-0'>
								<div className='flex items-baseline justify-between gap-3 text-sm'>
									<span
										className='min-w-0 truncate font-medium'
										title={row.model_id}
									>
										{row.model_id}
									</span>
									<span className='shrink-0 tabular-nums'>
										{formatNumber(row.request_count, props.locale)}
									</span>
								</div>
								<div
									className='bg-muted mt-1 h-2 overflow-hidden rounded-full'
									aria-hidden='true'
								>
									<div
										className='h-full rounded-full bg-blue-600'
										style={{
											width: `${row.request_count === 0 ? 0 : Math.max(2, (row.request_count / maximum) * 100)}%`,
										}}
									/>
								</div>
								<p className='text-muted-foreground mt-1 text-xs'>
									{formatMoney(row.charged_cost, props.currency, props.locale)}
								</p>
							</li>
						))}
					</ol>
				)}
			</section>
			<section
				className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
				aria-labelledby='dashboard-users-title'
			>
				<h2 id='dashboard-users-title' className='text-lg font-semibold'>
					{t(prefix + 'topUsers')}
				</h2>
				{props.stats.topUsers.length === 0 ? (
					<p className='text-muted-foreground py-8 text-sm'>
						{t(prefix + 'noUsers')}
					</p>
				) : (
					<div className='mt-4 overflow-x-auto'>
						<table className='w-full text-left text-sm'>
							<thead className='text-muted-foreground border-b text-xs'>
								<tr>
									<th scope='col' className='pr-3 pb-2 font-medium'>
										{t(prefix + 'user')}
									</th>
									<th scope='col' className='pr-3 pb-2 text-right font-medium'>
										{t(prefix + 'requests')}
									</th>
									<th scope='col' className='pb-2 text-right font-medium'>
										{t(prefix + 'cost')}
									</th>
								</tr>
							</thead>
							<tbody>
								{props.stats.topUsers.map((row) => (
									<tr key={row.user_email} className='border-b last:border-0'>
										<th
											scope='row'
											className='max-w-44 py-2 pr-3 font-normal break-all'
										>
											{row.user_email}
										</th>
										<td className='py-2 pr-3 text-right tabular-nums'>
											{formatNumber(row.request_count, props.locale)}
										</td>
										<td className='py-2 text-right tabular-nums'>
											{formatMoney(
												row.charged_cost,
												props.currency,
												props.locale
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	)
}
