/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { safeLogText } from '../request-logs/request-log-domain'
import { AuditLogDetailDialog } from './AuditLogDetailDialog'
import { AuditWalletSummary } from './AuditWalletSummary'
import type { AuditLogPage } from './audit-log-contracts'
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
export function AuditLogTable(props: {
	page: AuditLogPage
	currency: string | null
	timezone: string | null
	locale: string
	context: string
}) {
	const { t } = useTranslation()
	const returnFocus = useRef<HTMLButtonElement>(null)
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
		'wallet',
		'userChangeDetail',
	] as const
	return (
		<>
			<div className='bg-card relative max-h-[calc(100vh-16rem)] overflow-auto rounded-xl border'>
				<table className='w-full min-w-[1360px] text-left text-sm'>
					<caption className='sr-only'>{t(prefix + 'title')}</caption>
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
									colSpan={headings.length}
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
										<td className='min-w-64 px-3 py-3 text-xs'>
											<AuditWalletSummary
												log={log}
												currency={props.currency}
												locale={props.locale}
											/>
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
													onClick={(event) => {
														returnFocus.current = event.currentTarget
														setDetail({ id: log.id, context: props.context })
													}}
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
				<AuditLogDetailDialog
					log={activeLog}
					currency={props.currency}
					returnFocus={returnFocus}
					timezone={props.timezone}
					locale={props.locale}
					onClose={() => setDetail(null)}
				/>
			)}
		</>
	)
}
