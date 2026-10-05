/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { DashboardStats } from './dashboard-contracts'
import { formatTime } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'

export function RecentPanel(props: {
	rows: DashboardStats['recentLogs']
	kind: 'requests' | 'errors'
	timezone: string
	locale: string
}) {
	const { t } = useTranslation()
	const isError = props.kind === 'errors'
	const title = t(prefix + (isError ? 'recentErrors' : 'recentRequests'))
	return (
		<section
			className='bg-card min-w-0 rounded-xl border p-4 shadow-sm sm:p-5'
			aria-label={title}
		>
			<h2 className='text-lg font-semibold'>{title}</h2>
			{props.rows.length === 0 ? (
				<p className='text-muted-foreground py-8 text-sm'>
					{t(prefix + (isError ? 'noErrors' : 'noRequests'))}
				</p>
			) : (
				<ul className='mt-3 divide-y'>
					{props.rows.map((row) => (
						<li
							key={row.id}
							className='flex min-w-0 flex-wrap items-start justify-between gap-2 py-3 text-sm'
						>
							<div className='min-w-0'>
								<p className='font-medium break-all'>
									{row.model_id || t(prefix + 'unknownModel')}
								</p>
								<p className='text-muted-foreground text-xs break-all'>
									{row.provider_name ||
										row.provider_id ||
										t(prefix + 'unknownProvider')}
								</p>
								<p
									className={`mt-1 text-xs ${isError ? 'text-destructive' : 'text-muted-foreground'}`}
								>
									{isError
										? t(prefix + 'failureSummary')
										: t(
												prefix +
													{
														success: 'statusSuccess',
														error: 'statusError',
														incomplete: 'statusIncomplete',
														cancelled: 'statusCancelled',
													}[row.status]
											)}
								</p>
							</div>
							<time
								className='text-muted-foreground shrink-0 text-xs'
								dateTime={row.created_at}
							>
								{formatTime(row.created_at, props.timezone, props.locale)}
							</time>
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
