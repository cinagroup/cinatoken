/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAnalyticsMoney } from '../analytics/models/model-analytics-domain'
import { ToolInvocationDetail } from './ToolInvocationDetail'
import type { ToolInvocationPage } from './tool-invocation-contracts'
import {
	toolEngine,
	toolProfitPresentation,
	toolRequestSummary,
	toolResponseSummary,
	tools,
} from './tool-invocation-domain'

const prefix = 'cinatoken.adminToolInvocations.'
const columns = [
	'time',
	'tool',
	'provider',
	'query',
	'user',
	'status',
	'results',
	'standard',
	'charged',
	'metered',
	'profit',
	'latency',
] as const
function formatTime(
	value: string,
	timezone: string | null,
	locale: string
): string {
	return (
		new Intl.DateTimeFormat(locale, {
			timeZone: timezone ?? 'UTC',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(value)) + (timezone ? '' : ' UTC')
	)
}
function statusClass(status: string): string {
	if (status === 'success') return 'text-emerald-700 dark:text-emerald-400'
	if (status === 'error') return 'text-red-700 dark:text-red-400'
	return 'text-muted-foreground'
}
export function ToolInvocationTable(props: {
	page: ToolInvocationPage
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	context: string
}) {
	const { t } = useTranslation()
	const [expanded, setExpanded] = useState<{
		id: string
		context: string
	} | null>(null)
	const activeId = expanded?.context === props.context ? expanded.id : null
	return (
		<div
			role='region'
			aria-label={t(prefix + 'invocations.title')}
			tabIndex={0}
			className='bg-card overflow-x-auto rounded-xl border'
		>
			<table className='w-full min-w-[1440px] text-left text-xs'>
				<thead className='bg-muted/60 text-muted-foreground border-b'>
					<tr>
						{columns.map((key) => (
							<th
								key={key}
								scope='col'
								className={`px-3 py-3 font-semibold whitespace-nowrap ${['results', 'standard', 'charged', 'metered', 'profit', 'latency'].includes(key) ? 'text-right' : ''}`}
								title={
									['standard', 'charged', 'metered', 'profit'].includes(key)
										? t(prefix + `invocations.titles.${key}`)
										: undefined
								}
							>
								{t(prefix + `invocations.columns.${key}`, {
									currency: props.currency ?? '—',
								})}
							</th>
						))}
					</tr>
				</thead>
				<tbody className='divide-y'>
					{props.page.data.map((log) => {
						const open = activeId === log.id
						const query = toolRequestSummary(log.request_body).query
						const response = toolResponseSummary(log.raw_usage)
						const engine = toolEngine(log)
						const tool = tools.find((part) => part.modelId === log.model_id)
						const profit = log.charged_cost - log.metered_cost
						const profitStyle = toolProfitPresentation(profit, props.currency)
						const detailId = `tool-invocation-${log.id}`
						return (
							<Fragment key={log.id}>
								<tr
									className={`hover:bg-muted/30 align-top ${profitStyle.row}`}
								>
									<td className='px-3 py-3 whitespace-nowrap'>
										<div>
											{formatTime(log.created_at, props.timezone, props.locale)}
										</div>
										<button
											type='button'
											aria-expanded={open}
											aria-controls={detailId}
											className='text-primary mt-1 underline-offset-2 hover:underline'
											onClick={() =>
												setExpanded(
													open ? null : { id: log.id, context: props.context }
												)
											}
										>
											{t(prefix + 'details')}
										</button>
									</td>
									<td className='px-3 py-3 font-mono'>
										{tool
											? t(prefix + `catalog.${tool.label}`)
											: log.model_id || '—'}
									</td>
									<td
										className='max-w-44 truncate px-3 py-3 font-mono'
										title={engine ?? undefined}
									>
										{engine || '—'}
									</td>
									<td
										className='max-w-60 truncate px-3 py-3'
										title={query ?? undefined}
									>
										{query || '—'}
									</td>
									<td
										className='max-w-48 truncate px-3 py-3'
										title={log.user_email ?? undefined}
									>
										{log.user_email || '—'}
									</td>
									<td className={`px-3 py-3 ${statusClass(log.status)}`}>
										{log.status}
									</td>
									<td className='px-3 py-3 text-right font-mono'>
										{log.model_id === 'tool:ai-detection'
											? '—'
											: (response.resultCount ?? '—')}
									</td>
									<td className='px-3 py-3 text-right font-mono tabular-nums'>
										{formatAnalyticsMoney(
											log.standard_cost,
											props.currency,
											props.locale,
											6
										) ?? '—'}
									</td>
									<td className='px-3 py-3 text-right font-mono tabular-nums'>
										{formatAnalyticsMoney(
											log.charged_cost,
											props.currency,
											props.locale,
											6
										) ?? '—'}
									</td>
									<td className='px-3 py-3 text-right font-mono tabular-nums'>
										{formatAnalyticsMoney(
											log.metered_cost,
											props.currency,
											props.locale,
											6
										) ?? '—'}
									</td>
									<td
										className={`px-3 py-3 text-right font-mono tabular-nums ${profitStyle.tone}`}
									>
										{formatAnalyticsMoney(
											profit,
											props.currency,
											props.locale,
											6
										) ?? '—'}
									</td>
									<td className='px-3 py-3 text-right font-mono'>
										{log.latency_ms == null
											? '—'
											: `${log.latency_ms.toLocaleString(props.locale)} ms`}
									</td>
								</tr>
								{open && (
									<tr id={detailId} className='bg-muted/20'>
										<td colSpan={12}>
											<ToolInvocationDetail key={log.id} log={log} />
										</td>
									</tr>
								)}
							</Fragment>
						)
					})}
					{!props.page.data.length && (
						<tr>
							<td
								colSpan={12}
								className='text-muted-foreground p-8 text-center'
							>
								{t(prefix + 'invocations.empty')}
							</td>
						</tr>
					)}
				</tbody>
			</table>
		</div>
	)
}
