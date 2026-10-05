/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AdminUserListRow } from './users-contracts'

const prefix = 'cinatoken.adminUsers.'
const periodLabels: Record<AdminUserListRow['budget_period'], string> = {
	none: 'periodNone',
	daily: 'periodDaily',
	weekly: 'periodWeekly',
	monthly: 'periodMonthly',
}

function formatAmount(
	value: number,
	currency: 'USD' | 'CNY',
	locale: string
): string {
	return new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 2,
		maximumFractionDigits: 6,
	}).format(value)
}

function formatUtc(value: string, locale: string): string {
	return (
		new Intl.DateTimeFormat(locale, {
			timeZone: 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(value)) + ' UTC'
	)
}

type RowProps = {
	row: AdminUserListRow
	currency: 'USD' | 'CNY' | null
	locale: string
}

function UserBudget(props: RowProps) {
	const { t } = useTranslation()
	if (!props.currency)
		return (
			<span className='text-muted-foreground'>
				{t(prefix + 'amountUnavailable')}
			</span>
		)
	const max =
		props.row.budget_max === null
			? t(prefix + 'noLimit')
			: formatAmount(props.row.budget_max, props.currency, props.locale)
	return (
		<div className='space-y-1 text-xs'>
			<p>
				{t(prefix + 'spent')}:{' '}
				{formatAmount(props.row.budget_spent, props.currency, props.locale)}
				{' / '}
				{t(prefix + 'limit')}: {max}
			</p>
			<p className='text-muted-foreground'>
				{t(prefix + 'base')}:{' '}
				{formatAmount(props.row.budget_base, props.currency, props.locale)}
				{' · '}
				{t(prefix + periodLabels[props.row.budget_period])}
			</p>
			{props.row.budget_reset_at && (
				<p className='text-muted-foreground'>
					{t(prefix + 'resetAt')}:{' '}
					{formatUtc(props.row.budget_reset_at, props.locale)}
				</p>
			)}
		</div>
	)
}

function UserExtras(props: RowProps) {
	const { t } = useTranslation()
	return (
		<div className='space-y-1 text-xs'>
			{props.row.metadata && (
				<details>
					<summary className='cursor-pointer'>{t(prefix + 'metadata')}</summary>
					<pre className='bg-muted mt-1 max-h-32 overflow-auto rounded-md p-2 break-all whitespace-pre-wrap'>
						{props.row.metadata}
					</pre>
				</details>
			)}
			{props.row.charged_cost_factors &&
				Object.keys(props.row.charged_cost_factors).length > 0 && (
					<details>
						<summary className='cursor-pointer'>
							{t(prefix + 'factors')} (
							{Object.keys(props.row.charged_cost_factors).length})
						</summary>
						<pre className='bg-muted mt-1 max-h-32 overflow-auto rounded-md p-2 break-all whitespace-pre-wrap'>
							{JSON.stringify(props.row.charged_cost_factors, null, 2)}
						</pre>
					</details>
				)}
		</div>
	)
}

function rowLabels(row: AdminUserListRow) {
	return {
		external: [row.external_system, row.external_user_id]
			.filter(Boolean)
			.join(' · '),
		detailUrl: '/admin/users/' + encodeURIComponent(row.id),
	}
}

function MobileUserRow(props: RowProps) {
	const { t } = useTranslation()
	const labels = rowLabels(props.row)
	const status =
		props.row.status === 'active' || props.row.status === 'disabled'
			? t(prefix + props.row.status)
			: t(prefix + 'otherStatus', { status: props.row.status })
	return (
		<article className='bg-card space-y-3 rounded-xl border p-4'>
			<div className='flex flex-wrap items-start justify-between gap-2'>
				<div className='min-w-0'>
					<a
						href={labels.detailUrl}
						className='text-primary font-medium break-all underline-offset-2 hover:underline'
					>
						{props.row.email}
					</a>
					<p className='text-muted-foreground font-mono text-xs break-all'>
						{props.row.id}
					</p>
				</div>
				<span className='bg-muted rounded-md px-2 py-1 text-xs'>{status}</span>
			</div>
			{labels.external && (
				<p className='text-xs break-all'>{labels.external}</p>
			)}
			<UserBudget {...props} />
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'keysCount', {
					active: props.row.active_keys_count,
					total: props.row.keys_count,
				})}
				{' · '}
				{formatUtc(props.row.created_at, props.locale)}
			</p>
			<UserExtras {...props} />
		</article>
	)
}

function DesktopUserRow(props: RowProps) {
	const { t } = useTranslation()
	const labels = rowLabels(props.row)
	const status =
		props.row.status === 'active' || props.row.status === 'disabled'
			? t(prefix + props.row.status)
			: t(prefix + 'otherStatus', { status: props.row.status })
	return (
		<tr className='border-b last:border-b-0'>
			<td className='px-4 py-3 align-top'>
				<a
					href={labels.detailUrl}
					className='text-primary font-medium break-all underline-offset-2 hover:underline'
				>
					{props.row.email}
				</a>
				<p className='text-muted-foreground font-mono text-xs break-all'>
					{props.row.id}
				</p>
				<p className='text-muted-foreground mt-1 text-xs'>{status}</p>
			</td>
			<td className='max-w-44 px-4 py-3 align-top text-xs break-all'>
				{labels.external || '—'}
			</td>
			<td className='px-4 py-3 align-top'>
				<UserBudget {...props} />
			</td>
			<td className='px-4 py-3 align-top text-xs whitespace-nowrap'>
				{t(prefix + 'keysCount', {
					active: props.row.active_keys_count,
					total: props.row.keys_count,
				})}
			</td>
			<td className='px-4 py-3 align-top text-xs whitespace-nowrap'>
				{formatUtc(props.row.created_at, props.locale)}
			</td>
			<td className='max-w-32 px-4 py-3 align-top'>
				<UserExtras {...props} />
			</td>
		</tr>
	)
}

export function UserList(props: {
	rows: AdminUserListRow[]
	currency: 'USD' | 'CNY' | null
	locale: string
}) {
	const { t } = useTranslation()
	return (
		<section className='space-y-3'>
			<div className='space-y-3 md:hidden'>
				{props.rows.map((row) => (
					<MobileUserRow
						key={row.id}
						row={row}
						currency={props.currency}
						locale={props.locale}
					/>
				))}
			</div>
			<div className='bg-card hidden overflow-x-auto rounded-xl border md:block'>
				<table className='w-full min-w-200 text-left'>
					<thead className='bg-muted/50 text-muted-foreground text-xs'>
						<tr>
							<th className='px-4 py-3'>{t(prefix + 'user')}</th>
							<th className='px-4 py-3'>{t(prefix + 'identity')}</th>
							<th className='px-4 py-3'>{t(prefix + 'budget')}</th>
							<th className='px-4 py-3'>{t(prefix + 'keys')}</th>
							<th className='px-4 py-3'>{t(prefix + 'createdAt')}</th>
							<th className='px-4 py-3'>{t(prefix + 'metadata')}</th>
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<DesktopUserRow
								key={row.id}
								row={row}
								currency={props.currency}
								locale={props.locale}
							/>
						))}
					</tbody>
				</table>
			</div>
		</section>
	)
}
