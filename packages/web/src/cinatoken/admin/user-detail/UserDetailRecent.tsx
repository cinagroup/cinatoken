/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AuditLog } from '../audit-logs/audit-log-contracts'
import { auditDisplay } from '../audit-logs/audit-log-display'
import type { RequestLog } from '../request-logs/request-log-contracts'
import { safeLogText } from '../request-logs/request-log-domain'
import { userDetailRequestLogsUrl } from './user-detail-domain'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from './user-detail-format'

const prefix = 'cinatoken.adminUserDetail.'
type Currency = 'USD' | 'CNY' | null
function readSnapshot(
	raw: string | null | undefined
): Record<string, unknown> | null {
	if (!raw) return null
	try {
		const value: unknown = JSON.parse(raw)
		return value && typeof value === 'object' && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: null
	} catch {
		return null
	}
}
function snapshotSummary(row: AuditLog): string {
	if (!row.before_user_snapshot && !row.after_user_snapshot) return '—'
	const before = readSnapshot(row.before_user_snapshot)
	const after = readSnapshot(row.after_user_snapshot)
	if (!before && !after) return '—'
	const fields = [
		'email',
		'status',
		'external_system',
		'external_user_id',
		'budget_period',
		'budget_reset_at',
	]
	const changes: string[] = []
	for (const field of fields) {
		const b = before?.[field]
		const a = after?.[field]
		if (b === a) continue
		const display = (value: unknown) =>
			typeof value === 'string' ? safeLogText(value) : '—'
		changes.push(`${field}: ${display(b)} → ${display(a)}`)
	}
	return changes.slice(0, 4).join(' · ') || '—'
}
function auditMax(
	field: ReturnType<typeof auditDisplay>['beforeMax'],
	currency: Currency,
	locale: string,
	noLimit: string
): string {
	if (!currency || field.kind === 'missing') return '—'
	if (field.kind === 'null') return noLimit
	return formatUserDetailMoney(field.value, currency, locale)
}
export function UserDetailRecent(props: {
	userId: string
	logs: RequestLog[] | null
	audits: AuditLog[] | null
	logsDenied: boolean
	auditsDenied: boolean
	logsFailed: boolean
	auditsFailed: boolean
	currency: Currency
	timezone: string | null
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const requestUrl = userDetailRequestLogsUrl(props.userId)
	const auditUrl = `/admin/audit-logs?user_id=${encodeURIComponent(props.userId)}`
	return (
		<div className='grid min-w-0 gap-5'>
			<section className='bg-card min-w-0 space-y-3 rounded-xl border p-4 sm:p-6'>
				<div className='flex flex-wrap justify-between gap-2'>
					<h2 className='text-lg font-semibold'>
						{t(prefix + 'recentRequests')}
					</h2>
					<a className='text-primary text-sm underline' href={requestUrl}>
						{t(prefix + 'more')}
					</a>
				</div>
				{props.logsDenied ? (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'logsDenied')}
					</p>
				) : props.logsFailed ? (
					<p role='alert' className='text-sm'>
						{t(prefix + 'logsFailed')}
					</p>
				) : props.logs ? (
					<div className='overflow-x-auto'>
						<table className='w-full min-w-[920px] text-left text-xs'>
							<thead>
								<tr className='border-b'>
									<th className='p-2'>
										{t(prefix + 'time', { timezone: props.timezone ?? 'UTC' })}
									</th>
									<th className='p-2'>{t(prefix + 'model')}</th>
									<th className='p-2'>{t(prefix + 'group')}</th>
									<th className='p-2'>{t(prefix + 'provider')}</th>
									<th className='p-2'>{t(prefix + 'status')}</th>
									<th className='p-2'>{t(prefix + 'standard')}</th>
									<th className='p-2'>{t(prefix + 'charged')}</th>
									<th className='p-2'>{t(prefix + 'metered')}</th>
								</tr>
							</thead>
							<tbody>
								{props.logs.map((row) => (
									<tr key={row.id} className='border-b align-top'>
										<td className='p-2 whitespace-nowrap'>
											{formatUserDetailTime(
												row.created_at,
												locale,
												props.timezone
											)}
										</td>
										<td className='p-2 font-mono'>
											{row.model_name ?? row.model_id ?? '—'}
										</td>
										<td className='p-2'>{row.route_group ?? '—'}</td>
										<td className='p-2'>
											{row.provider_name ?? row.provider_id ?? '—'}
										</td>
										<td className='p-2'>{row.status}</td>
										<td className='p-2 tabular-nums'>
											{formatUserDetailMoney(
												row.standard_cost,
												props.currency,
												locale
											)}
										</td>
										<td className='p-2 tabular-nums'>
											{formatUserDetailMoney(
												row.charged_cost,
												props.currency,
												locale
											)}
										</td>
										<td className='p-2 tabular-nums'>
											{formatUserDetailMoney(
												row.metered_cost,
												props.currency,
												locale
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
						{props.logs.length === 0 && (
							<p className='p-2 text-sm'>{t(prefix + 'empty')}</p>
						)}
					</div>
				) : (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'loading')}
					</p>
				)}
			</section>
			<section className='bg-card min-w-0 space-y-3 rounded-xl border p-4 sm:p-6'>
				<div className='flex flex-wrap justify-between gap-2'>
					<h2 className='text-lg font-semibold'>
						{t(prefix + 'recentAudits')}
					</h2>
					<a className='text-primary text-sm underline' href={auditUrl}>
						{t(prefix + 'more')}
					</a>
				</div>
				{props.auditsDenied ? (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'logsDenied')}
					</p>
				) : props.auditsFailed ? (
					<p role='alert' className='text-sm'>
						{t(prefix + 'logsFailed')}
					</p>
				) : props.audits ? (
					<div className='overflow-x-auto'>
						<table className='w-full min-w-[880px] text-left text-xs'>
							<thead>
								<tr className='border-b'>
									<th className='p-2'>
										{t(prefix + 'time', { timezone: props.timezone ?? 'UTC' })}
									</th>
									<th className='p-2'>{t(prefix + 'event')}</th>
									<th className='p-2'>{t(prefix + 'source')}</th>
									<th className='p-2'>{t(prefix + 'delta')}</th>
									<th className='p-2'>{t(prefix + 'maxChange')}</th>
									<th className='p-2'>{t(prefix + 'snapshot')}</th>
								</tr>
							</thead>
							<tbody>
								{props.audits.map((row) => {
									const display = auditDisplay(row)
									return (
										<tr key={row.id} className='border-b align-top'>
											<td className='p-2 whitespace-nowrap'>
												{formatUserDetailTime(
													row.created_at,
													locale,
													props.timezone
												)}
											</td>
											<td className='p-2'>
												{row.event_type}
												<span className='text-muted-foreground block'>
													{row.actor_type}
												</span>
											</td>
											<td className='p-2'>
												{row.source ?? '—'}
												<span className='text-muted-foreground block font-mono'>
													{row.correlation_id ?? row.request_log_id ?? ''}
												</span>
											</td>
											<td className='p-2 tabular-nums'>
												{display.deltaSpent.kind === 'value'
													? formatUserDetailMoney(
															display.deltaSpent.value,
															props.currency,
															locale
														)
													: '—'}
											</td>
											<td className='p-2 tabular-nums'>
												{auditMax(
													display.beforeMax,
													props.currency,
													locale,
													t(prefix + 'noLimit')
												)}{' '}
												→{' '}
												{auditMax(
													display.afterMax,
													props.currency,
													locale,
													t(prefix + 'noLimit')
												)}
											</td>
											<td className='max-w-60 p-2 break-words'>
												{snapshotSummary(row)}
											</td>
										</tr>
									)
								})}
							</tbody>
						</table>
						{props.audits.length === 0 && (
							<p className='p-2 text-sm'>{t(prefix + 'empty')}</p>
						)}
					</div>
				) : (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'loading')}
					</p>
				)}
			</section>
		</div>
	)
}
