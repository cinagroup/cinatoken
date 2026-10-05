/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { formatTime } from '../dashboard/dashboard-format'
import type { ReliabilityRecentError } from './reliability-contracts'

const prefix = 'cinatoken.adminReliability.'

export function ReliabilityRecentErrors(props: {
	rows: ReliabilityRecentError[]
	timezone: string | null
	locale: string
}) {
	const { t } = useTranslation()
	const timezone = props.timezone ?? 'UTC'
	return (
		<section className='min-w-0 space-y-3'>
			<div className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h2 className='text-lg font-semibold'>
						{t(prefix + 'recentErrors')}
					</h2>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'recentIndependent')}
					</p>
				</div>
				<a
					className='text-primary text-sm underline-offset-4 hover:underline'
					href='/admin/request-logs?status=error'
				>
					{t(prefix + 'viewAllErrors')}
				</a>
			</div>
			<div className='bg-card overflow-x-auto rounded-xl border'>
				<table className='min-w-full text-left text-sm'>
					<thead className='bg-muted/60 text-muted-foreground text-xs'>
						<tr>
							<th scope='col' className='px-4 py-3 whitespace-nowrap'>
								{t(prefix + 'time')} ({timezone})
							</th>
							<th scope='col' className='px-4 py-3'>
								{t(prefix + 'modelProvider')}
							</th>
							<th scope='col' className='px-4 py-3'>
								{t(prefix + 'errors')}
							</th>
						</tr>
					</thead>
					<tbody className='divide-y'>
						{props.rows.map((row) => (
							<tr key={row.id}>
								<td className='px-4 py-3 whitespace-nowrap tabular-nums'>
									{formatTime(row.created_at, timezone, props.locale)}
								</td>
								<td className='max-w-56 px-4 py-3 break-all'>
									<span className='block font-medium'>
										{row.model_id ?? '—'}
									</span>
									<span className='text-muted-foreground text-xs'>
										{row.provider_name || row.provider_id || '—'}
									</span>
								</td>
								<td className='text-destructive px-4 py-3'>
									{t(prefix + 'requestFailed')}
								</td>
							</tr>
						))}
					</tbody>
				</table>
				{props.rows.length === 0 && (
					<p className='text-muted-foreground p-8 text-center text-sm'>
						{t(prefix + 'noRecentErrors')}
					</p>
				)}
			</div>
		</section>
	)
}
