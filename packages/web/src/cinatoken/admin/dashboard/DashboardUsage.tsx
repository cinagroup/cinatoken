/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
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
	const [view, setView] = useState<'models' | 'users'>('models')
	const models = view === 'models'
	const rows = models
		? props.stats.modelDistribution.map((row) => ({
				...row,
				name: row.model_id,
			}))
		: props.stats.topUsers.map((row) => ({ ...row, name: row.user_email }))
	const maximum = Math.max(
		0,
		...rows.map((row) => (models ? row.request_count : row.charged_cost))
	)
	return (
		<section
			className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
			aria-labelledby='dashboard-usage-title'
		>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<h2 id='dashboard-usage-title' className='text-lg font-semibold'>
					{t(prefix + (models ? 'modelDistribution' : 'topUsers'))}
				</h2>
				<div
					className='flex gap-2'
					role='group'
					aria-label={t(prefix + 'usageView')}
				>
					<Button
						size='sm'
						variant={models ? 'default' : 'outline'}
						aria-pressed={models}
						onClick={() => setView('models')}
					>
						{t(prefix + 'model')}
					</Button>
					<Button
						size='sm'
						variant={models ? 'outline' : 'default'}
						aria-pressed={!models}
						onClick={() => setView('users')}
					>
						{t(prefix + 'user')}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground mt-2 text-xs'>
				{t(prefix + (models ? 'rankRequests' : 'rankCost'))}
			</p>
			{rows.length === 0 ? (
				<p className='text-muted-foreground py-8 text-sm'>
					{t(prefix + (models ? 'noModels' : 'noUsers'))}
				</p>
			) : (
				<div className='mt-4 overflow-x-auto'>
					<table className='w-full text-left text-sm'>
						<thead className='text-muted-foreground border-b text-xs'>
							<tr>
								<th scope='col' className='min-w-36 p-2 whitespace-nowrap'>
									{t(prefix + (models ? 'model' : 'user'))}
								</th>
								{['requests', 'tokens', 'cost'].map((key) => (
									<th
										key={key}
										scope='col'
										className='p-2 text-right whitespace-nowrap'
									>
										{t(prefix + key)}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr key={row.name} className='border-b last:border-0'>
									<th
										scope='row'
										className='max-w-80 p-2 font-normal break-all'
									>
										{row.name}
										<div
											className='bg-muted mt-2 h-1 rounded'
											aria-hidden='true'
										>
											<div
												className='h-full rounded bg-blue-600'
												style={{
													width: `${maximum > 0 ? Math.max(0, ((models ? row.request_count : row.charged_cost) / maximum) * 100) : 0}%`,
												}}
											/>
										</div>
									</th>
									<td className='p-2 text-right whitespace-nowrap tabular-nums'>
										{formatNumber(row.request_count, props.locale)}
									</td>
									<td className='p-2 text-right whitespace-nowrap tabular-nums'>
										{formatNumber(row.total_tokens, props.locale)}
									</td>
									<td className='p-2 text-right whitespace-nowrap tabular-nums'>
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
			<Link
				to={models ? '/admin/analytics/models' : '/admin/analytics/users'}
				className='text-primary mt-4 inline-flex py-2 text-sm underline underline-offset-4'
			>
				{t(prefix + 'viewAnalytics')}
			</Link>
		</section>
	)
}
