/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { AuditLogTable } from '../audit-logs/AuditLogTable'
import type { AuditLog } from '../audit-logs/audit-log-contracts'
import { RequestChargeSplit } from '../request-logs/RequestChargeSplit'
import { requestChargeAmount } from '../request-logs/request-charge-split'
import type { RequestLog } from '../request-logs/request-log-contracts'
import { userDetailRequestLogsUrl } from './user-detail-domain'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from './user-detail-format'

const prefix = 'cinatoken.adminUserDetail.'
type Currency = 'USD' | 'CNY' | null
type RecentProps = {
	userId: string
	logs: RequestLog[] | null
	audits: AuditLog[] | null
	logsDenied: boolean
	auditsDenied: boolean
	logsFailed: boolean
	auditsFailed: boolean
	currency: Currency
	timezone: string | null
}
export function UserDetailRecent(props: RecentProps) {
	const { t } = useTranslation()
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
				<RecentRequests {...props} />
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
				<RecentAudits {...props} />
			</section>
		</div>
	)
}

function RecentRequests(props: RecentProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	if (props.logsDenied)
		return (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'logsDenied')}
			</p>
		)
	if (props.logsFailed)
		return (
			<p role='alert' className='text-sm'>
				{t(prefix + 'logsFailed')}
			</p>
		)
	if (!props.logs)
		return (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'loading')}
			</p>
		)
	return (
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
								{formatUserDetailTime(row.created_at, locale, props.timezone)}
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
									requestChargeAmount(row.charged_cost),
									props.currency,
									locale
								)}
								<RequestChargeSplit
									log={row}
									currency={props.currency}
									compact
								/>
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
	)
}

function RecentAudits(props: RecentProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	if (props.auditsDenied)
		return (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'logsDenied')}
			</p>
		)
	if (props.auditsFailed)
		return (
			<p role='alert' className='text-sm'>
				{t(prefix + 'logsFailed')}
			</p>
		)
	if (!props.audits)
		return (
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'loading')}
			</p>
		)
	return (
		<AuditLogTable
			page={{
				data: props.audits,
				total: props.audits.length,
				page: 1,
				page_size: 5,
			}}
			currency={props.currency}
			timezone={props.timezone}
			locale={locale}
			context={props.userId}
		/>
	)
}
