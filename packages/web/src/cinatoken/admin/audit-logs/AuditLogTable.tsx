/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { safeLogJson, safeLogText } from '../request-logs/request-log-domain'
import type { AuditLog, AuditLogPage } from './audit-log-contracts'
import {
	auditDiffs,
	auditDisplay,
	auditTime,
	type AuditSnapshotField,
} from './audit-log-display'
import { parseAuditActorId, shortAuditId } from './audit-log-domain'

const prefix = 'cinatoken.adminAuditLogs.'
function formatMoney(
	value: number,
	currency: string,
	locale: string,
	signed = false
): string {
	const amount = new Intl.NumberFormat(locale, {
		style: 'currency',
		currency,
		minimumFractionDigits: 6,
		maximumFractionDigits: 6,
	}).format(value)
	return signed && value > 0 ? `+${amount}` : amount
}
function AuditMoney(props: {
	field: AuditSnapshotField<number>
	currency: string | null
	locale: string
	signed?: boolean
	max?: boolean
}) {
	const { t } = useTranslation()
	if (props.field.kind === 'missing' || !props.currency) return '—'
	if (props.field.kind === 'null')
		return props.max ? t(prefix + 'noLimit') : '—'
	return formatMoney(
		props.field.value,
		props.currency,
		props.locale,
		props.signed
	)
}
function AuditText(props: {
	field: AuditSnapshotField<string>
	date?: boolean
	timezone: string | null
	locale: string
}) {
	const { t } = useTranslation()
	if (props.field.kind === 'missing') return '—'
	if (props.field.kind === 'null') return t(prefix + 'nullValue')
	return props.date
		? auditTime(props.field.value, props.timezone, props.locale)
		: safeLogText(props.field.value)
}
function RawPanel(props: { title: string; raw: string | null | undefined }) {
	const { t } = useTranslation()
	const [copied, setCopied] = useState(false)
	const safe = safeLogJson(props.raw)
	if (!safe) return null
	return (
		<section className='min-w-0 rounded-lg border p-3'>
			<div className='mb-2 flex items-center justify-between gap-2'>
				<h3 className='text-sm font-medium'>{props.title}</h3>
				<Button
					type='button'
					variant='outline'
					size='sm'
					onClick={() => {
						void navigator.clipboard.writeText(safe).then(
							() => setCopied(true),
							() => setCopied(false)
						)
					}}
				>
					{t(prefix + (copied ? 'copied' : 'copy'))}
				</Button>
			</div>
			<pre className='bg-muted max-h-60 overflow-auto rounded-md p-3 text-xs break-all whitespace-pre-wrap'>
				{safe}
			</pre>
		</section>
	)
}
function AuditDetail(props: {
	log: AuditLog
	timezone: string | null
	locale: string
	onClose: () => void
}) {
	const { t } = useTranslation()
	const diffs = auditDiffs(
		props.log,
		t(prefix + 'missingSnapshot'),
		t(prefix + 'nullValue')
	)
	return (
		<div
			className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-5'
			role='presentation'
			onClick={props.onClose}
		>
			<div
				role='dialog'
				aria-modal='true'
				aria-labelledby='audit-change-detail-title'
				className='bg-card flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-2xl'
				onClick={(event) => event.stopPropagation()}
			>
				<div className='flex items-start justify-between gap-3 border-b p-4 sm:p-5'>
					<div className='min-w-0'>
						<h2
							id='audit-change-detail-title'
							className='text-lg font-semibold'
						>
							{t(prefix + 'labels.changeDetailTitle')}
						</h2>
						<p className='text-muted-foreground mt-1 flex flex-wrap gap-2 text-xs'>
							<span className='font-mono'>{props.log.event_type}</span>
							<span>
								{auditTime(props.log.created_at, props.timezone, props.locale)}
							</span>
							<span>{props.log.user_email ?? '—'}</span>
						</p>
					</div>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'close')}
					</Button>
				</div>
				<div className='space-y-4 overflow-y-auto p-4 sm:p-5'>
					{diffs.length ? (
						diffs.map((row, index) => (
							<div
								key={`${row.group}-${row.field}-${index}`}
								className='rounded-lg border p-3'
							>
								<div className='mb-2 flex flex-wrap items-center gap-2 text-sm'>
									<span className='bg-muted rounded px-2 py-0.5 text-xs'>
										{t(
											prefix +
												(row.group === 'snapshot'
													? 'labels.userSnapshot'
													: 'labels.extraJson')
										)}
									</span>
									<span className='font-mono font-medium break-all'>
										{row.field}
									</span>
								</div>
								<div className='grid gap-3 sm:grid-cols-2'>
									<div className='min-w-0'>
										<p className='text-muted-foreground mb-1 text-xs'>
											{t(prefix + 'labels.originalValue')}
										</p>
										<pre className='max-h-48 overflow-auto rounded bg-amber-500/10 p-3 text-xs break-all whitespace-pre-wrap'>
											{row.before}
										</pre>
									</div>
									<div className='min-w-0'>
										<p className='text-muted-foreground mb-1 text-xs'>
											{t(prefix + 'labels.changedValue')}
										</p>
										<pre className='max-h-48 overflow-auto rounded bg-sky-500/10 p-3 text-xs break-all whitespace-pre-wrap'>
											{row.after}
										</pre>
									</div>
								</div>
							</div>
						))
					) : (
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'labels.noChangeDetail')}
						</p>
					)}
					<RawPanel
						title={t(prefix + 'beforeSnapshot')}
						raw={props.log.before_user_snapshot}
					/>
					<RawPanel
						title={t(prefix + 'afterSnapshot')}
						raw={props.log.after_user_snapshot}
					/>
					<RawPanel
						title={t(prefix + 'changedFields')}
						raw={props.log.changed_fields}
					/>
					<RawPanel
						title={t(prefix + 'rawPayload')}
						raw={props.log.change_payload}
					/>
				</div>
			</div>
		</div>
	)
}
export function AuditLogTable(props: {
	page: AuditLogPage
	currency: string | null
	timezone: string | null
	locale: string
	context: string
}) {
	const { t } = useTranslation()
	const [detail, setDetail] = useState<{ id: string; context: string } | null>(
		null
	)
	const activeLog =
		detail?.context === props.context
			? (props.page.data.find((row) => row.id === detail.id) ?? null)
			: null
	const headings = [
		'time',
		'event',
		'actor',
		'identity',
		'spend',
		'budgetPlan',
		'userChangeDetail',
	] as const
	return (
		<>
			<div className='bg-card max-h-[calc(100vh-16rem)] overflow-auto rounded-xl border'>
				<table className='w-full min-w-[1140px] text-left text-sm'>
					<thead className='bg-muted/80 sticky top-0 z-10'>
						<tr>
							{headings.map((key) => (
								<th
									key={key}
									scope='col'
									className='border-b px-3 py-2 text-xs font-semibold whitespace-nowrap'
								>
									{t(prefix + `table.${key}`)}
								</th>
							))}
						</tr>
					</thead>
					<tbody className='divide-y'>
						{props.page.data.length === 0 ? (
							<tr>
								<td
									colSpan={7}
									className='text-muted-foreground p-8 text-center'
								>
									{t(prefix + 'empty')}
								</td>
							</tr>
						) : (
							props.page.data.map((log) => {
								const value = auditDisplay(log)
								const actor = parseAuditActorId(value.actorId)
								const reason = [value.reasonCode, value.reasonText]
									.filter(Boolean)
									.filter((part, index, list) => list.indexOf(part) === index)
									.join(' · ')
								const diffs = auditDiffs(
									log,
									t(prefix + 'missingSnapshot'),
									t(prefix + 'nullValue')
								)
								const hasDetails = Boolean(
									diffs.length ||
									log.change_payload ||
									log.before_user_snapshot ||
									log.after_user_snapshot ||
									log.changed_fields
								)
								return (
									<tr key={log.id} className='hover:bg-muted/30 align-top'>
										<td className='min-w-40 px-3 py-3 text-xs'>
											<div className='whitespace-nowrap'>
												{auditTime(
													log.created_at,
													props.timezone,
													props.locale
												)}
											</div>
											<div
												className='text-muted-foreground mt-1 font-mono'
												title={log.request_log_id ?? undefined}
											>
												{t(prefix + 'labels.req')}:{' '}
												{shortAuditId(log.request_log_id)}
											</div>
											{value.correlationId && (
												<div
													className='text-muted-foreground font-mono'
													title={value.correlationId}
												>
													{t(prefix + 'labels.corr')}:{' '}
													{shortAuditId(value.correlationId)}
												</div>
											)}
										</td>
										<td className='max-w-60 min-w-44 px-3 py-3 text-xs'>
											<div>
												<span className='text-muted-foreground'>
													{t(prefix + 'labels.type')}
												</span>
												<span className='font-mono font-medium break-all'>
													{log.event_type}
												</span>
											</div>
											<div className='mt-1 break-all'>
												<span className='text-muted-foreground'>
													{t(prefix + 'labels.from')}
												</span>
												<span className='font-mono'>{value.source ?? '—'}</span>
											</div>
											<div className='mt-1 break-words' title={reason}>
												<span className='text-muted-foreground'>
													{t(prefix + 'labels.reason')}
												</span>
												{safeLogText(reason) || '—'}
											</div>
										</td>
										<td className='max-w-52 min-w-36 px-3 py-3 text-xs'>
											<div>
												<span className='text-muted-foreground'>
													{t(prefix + 'labels.kind')}
												</span>
												{log.actor_type}
											</div>
											<div
												className='mt-1 break-all'
												title={value.actorId ?? undefined}
											>
												<span className='text-muted-foreground'>
													{t(prefix + 'labels.principal')}
												</span>
												{actor.kind && (
													<span className='bg-muted mr-1 rounded px-1'>
														{t(prefix + `actorKinds.${actor.kind}`, {
															defaultValue: actor.kind,
														})}
													</span>
												)}
												<span className='font-mono'>
													{shortAuditId(actor.identifier)}
												</span>
											</div>
										</td>
										<td className='max-w-64 min-w-44 px-3 py-3 text-xs'>
											<div
												className='truncate'
												title={log.user_email ?? undefined}
											>
												{log.user_email ?? '—'}
											</div>
											<div className='mt-1 font-mono'>
												{t(prefix + 'labels.user')}{' '}
												{log.user_id ? (
													<a
														href={`/admin/users/${encodeURIComponent(log.user_id)}`}
														className='text-primary underline-offset-2 hover:underline'
														title={log.user_id}
													>
														{shortAuditId(log.user_id)}
													</a>
												) : (
													<span title={t(prefix + 'userRemovedTitle')}>—</span>
												)}
											</div>
											<div
												className='text-muted-foreground font-mono'
												title={log.api_key_id ?? undefined}
											>
												{t(prefix + 'labels.key')}
												{shortAuditId(log.api_key_id)}
											</div>
										</td>
										<td className='min-w-44 px-3 py-3 text-xs'>
											<div>
												{t(prefix + 'labels.before')}:{' '}
												<AuditMoney
													field={value.beforeSpent}
													currency={props.currency}
													locale={props.locale}
												/>
											</div>
											<div>
												{t(prefix + 'labels.after')}:{' '}
												<AuditMoney
													field={value.afterSpent}
													currency={props.currency}
													locale={props.locale}
												/>
											</div>
											<div>
												{t(prefix + 'labels.delta')}:{' '}
												<AuditMoney
													field={value.deltaSpent}
													currency={props.currency}
													locale={props.locale}
													signed
												/>
											</div>
										</td>
										<td className='min-w-72 px-3 py-3 text-xs'>
											<div>
												{t(prefix + 'labels.max')}{' '}
												<AuditMoney
													field={value.beforeMax}
													currency={props.currency}
													locale={props.locale}
													max
												/>{' '}
												→{' '}
												<AuditMoney
													field={value.afterMax}
													currency={props.currency}
													locale={props.locale}
													max
												/>
											</div>
											<div>
												{t(prefix + 'labels.base')}{' '}
												<AuditMoney
													field={value.beforeBase}
													currency={props.currency}
													locale={props.locale}
												/>{' '}
												→{' '}
												<AuditMoney
													field={value.afterBase}
													currency={props.currency}
													locale={props.locale}
												/>
											</div>
											<div>
												{t(prefix + 'labels.period')}{' '}
												<AuditText
													field={value.beforePeriod}
													timezone={props.timezone}
													locale={props.locale}
												/>{' '}
												→{' '}
												<AuditText
													field={value.afterPeriod}
													timezone={props.timezone}
													locale={props.locale}
												/>
											</div>
											<div>
												{t(prefix + 'labels.resetAt')}{' '}
												<AuditText
													field={value.beforeReset}
													date
													timezone={props.timezone}
													locale={props.locale}
												/>{' '}
												→{' '}
												<AuditText
													field={value.afterReset}
													date
													timezone={props.timezone}
													locale={props.locale}
												/>
											</div>
										</td>
										<td className='max-w-72 min-w-52 px-3 py-3 text-xs'>
											{diffs.slice(0, 3).map((row, index) => (
												<div
													key={`${row.field}-${index}`}
													className='truncate'
													title={`${row.before} → ${row.after}`}
												>
													<span className='font-mono'>{row.field}</span>:{' '}
													{row.before} → {row.after}
												</div>
											))}
											{!diffs.length && (
												<span className='text-muted-foreground'>—</span>
											)}
											{hasDetails && (
												<button
													type='button'
													className='text-primary mt-1 underline-offset-2 hover:underline'
													onClick={() =>
														setDetail({ id: log.id, context: props.context })
													}
												>
													{t(prefix + 'labels.viewChangeDetail')}
												</button>
											)}
										</td>
									</tr>
								)
							})
						)}
					</tbody>
				</table>
			</div>
			{activeLog && (
				<AuditDetail
					log={activeLog}
					timezone={props.timezone}
					locale={props.locale}
					onClose={() => setDetail(null)}
				/>
			)}
		</>
	)
}
