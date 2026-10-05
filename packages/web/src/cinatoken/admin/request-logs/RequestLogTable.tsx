/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment } from 'react'
import { useTranslation } from 'react-i18next'
import { formatAnalyticsMoney } from '../analytics/models/model-analytics-domain'
import { RequestLogDetail } from './RequestLogDetail'
import type {
	LogModelCatalog,
	LogProviderCatalog,
	RequestLog,
	RequestLogPage,
} from './request-log-contracts'
import {
	geminiWireAction,
	logUsage,
	normalizeRouteGroup,
	requestLogProtocolPath,
	requestLogTags,
	safeLogText,
} from './request-log-domain'

const prefix = 'cinatoken.adminRequestLogs.'
function statusClass(status: string): string {
	if (status === 'success') return 'bg-emerald-500'
	if (status === 'error') return 'bg-red-500'
	if (status === 'incomplete') return 'bg-amber-500'
	if (status === 'cancelled') return 'bg-violet-500'
	return 'bg-slate-400'
}
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
function ms(value: number | null | undefined): string {
	return value == null ? '—' : `${value.toLocaleString('en-US')} ms`
}
function multiplier(
	value: number,
	standard: number | undefined,
	locale: string
): string | null {
	if (standard === undefined || standard <= 0) return null
	const ratio = value / standard
	return Number.isFinite(ratio) && ratio >= 0
		? `×${new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(ratio)}`
		: null
}
function RouteCell(props: {
	log: RequestLog
	providers: LogProviderCatalog | null
}) {
	const { t } = useTranslation()
	const log = props.log
	const tool =
		log.provider_id === 'octafuse-tools' || log.model_id?.startsWith('tool:')
	const inboundProtocol = log.request_protocol || log.upstream_protocol
	const inboundOperation = log.request_operation || log.upstream_operation
	const upstreamName =
		log.provider_name?.trim() ||
		props.providers?.find((row) => row.id === log.provider_id)?.name ||
		log.provider_id ||
		''
	const geminiAction = geminiWireAction(log.route_trace)
	const inbound = tool
		? `/v1/tools/${(log.model_id ?? '').replace(/^tool:/u, '')}`
		: requestLogProtocolPath(inboundProtocol, inboundOperation)
	const upstream = tool
		? ''
		: requestLogProtocolPath(log.upstream_protocol, log.upstream_operation)
	function geminiTitle(
		protocol: string | null | undefined,
		operation: string | null | undefined,
		modelId: string | null | undefined,
		compact: string
	): string {
		if (protocol !== 'gemini' || !operation) return compact
		const action = geminiAction || operation
		const suffix =
			action === 'models.generate'
				? '{generateContent|streamGenerateContent}'
				: action
		return `/v1beta/models/${modelId || '{model}'}:${suffix}`
	}
	const inboundTitle = geminiTitle(
		inboundProtocol,
		inboundOperation,
		log.model_id,
		inbound
	)
	const upstreamTitle = geminiTitle(
		log.upstream_protocol,
		log.upstream_operation,
		log.provider_model_name || log.model_id,
		upstream
	)
	return (
		<div className='grid min-w-64 gap-1 text-xs'>
			<div className='flex min-w-0 items-center gap-2'>
				<span className='w-16 shrink-0 font-semibold text-blue-600 dark:text-blue-400'>
					{t(prefix + 'route.inbound')}
				</span>
				<code
					className='bg-muted max-w-40 truncate rounded px-1'
					title={inboundTitle}
				>
					{inbound || '—'}
				</code>
				<span
					className='min-w-0 truncate font-mono'
					title={log.model_name || log.model_id || undefined}
				>
					{log.model_id || '—'}
				</span>
				<span className='shrink-0 rounded bg-sky-100 px-1 dark:bg-sky-950'>
					@{normalizeRouteGroup(log.route_group)}
				</span>
			</div>
			<div className='flex min-w-0 items-center gap-2'>
				<span className='w-16 shrink-0 font-semibold text-amber-600 dark:text-amber-400'>
					{t(prefix + 'route.upstream')}
				</span>
				<code
					className='bg-muted max-w-40 truncate rounded px-1'
					title={upstreamTitle}
				>
					{upstream || '—'}
				</code>
				<span
					className='min-w-0 truncate font-mono'
					title={log.provider_model_name ?? undefined}
				>
					{log.provider_model_name || '—'}
				</span>
				<span
					className='min-w-0 truncate rounded bg-amber-100 px-1 dark:bg-amber-950'
					title={log.provider_id ?? undefined}
				>
					{upstreamName}
				</span>
			</div>
		</div>
	)
}
export function RequestLogTable(props: {
	page: RequestLogPage
	models: LogModelCatalog | null
	providers: LogProviderCatalog | null
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	expanded: string | null
	onExpand: (id: string) => void
}) {
	const { t } = useTranslation()
	return (
		<div
			className='bg-card overflow-x-auto rounded-xl border'
			role='region'
			aria-label={t(prefix + 'title')}
			tabIndex={0}
		>
			<table className='w-full min-w-[1350px] text-left text-xs'>
				<thead className='bg-muted/60 text-muted-foreground border-b'>
					<tr>
						{(
							[
								'statusTime',
								'userSystem',
								'route',
								'tags',
								'usage',
								'cost',
								'profit',
							] as const
						).map((key) => (
							<th
								key={key}
								scope='col'
								className='px-3 py-3 font-semibold whitespace-nowrap'
							>
								{t(prefix + `headers.${key}`, {
									currency: props.currency ?? '—',
								})}
							</th>
						))}
					</tr>
				</thead>
				<tbody className='divide-y'>
					{props.page.data.map((log) => {
						const open = props.expanded === log.id
						const charged = formatAnalyticsMoney(
							log.charged_cost,
							props.currency,
							props.locale,
							6
						)
						const metered = formatAnalyticsMoney(
							log.metered_cost,
							props.currency,
							props.locale,
							6
						)
						const standard = formatAnalyticsMoney(
							log.standard_cost,
							props.currency,
							props.locale,
							6
						)
						const profit =
							props.currency &&
							Number.isFinite(log.charged_cost - log.metered_cost)
								? formatAnalyticsMoney(
										log.charged_cost - log.metered_cost,
										props.currency,
										props.locale,
										6
									)
								: null
						const model = props.models?.find((row) => row.id === log.model_id)
						const tags = requestLogTags(log, model?.kind ?? null)
						return (
							<Fragment key={log.id}>
								<tr className={open ? 'bg-primary/5' : 'hover:bg-muted/30'}>
									<td className='min-w-52 px-3 py-3 align-top'>
										<button
											type='button'
											className='flex w-full items-start gap-2 text-left'
											aria-expanded={open}
											aria-controls={`request-log-detail-${log.id}`}
											aria-label={
												t(prefix + (open ? 'hideDetails' : 'showDetails')) +
												` ${log.id}`
											}
											onClick={() => props.onExpand(log.id)}
										>
											<span
												aria-hidden='true'
												className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-sm ${statusClass(log.status)}`}
											/>
											<span className='min-w-0'>
												<span className='block whitespace-nowrap'>
													{formatTime(
														log.created_at,
														props.timezone,
														props.locale
													)}
												</span>
												<span className='text-muted-foreground block'>
													{ms(log.latency_ms)} ·{' '}
													{log.first_reasoning_token_ms != null
														? `R ${ms(log.first_reasoning_token_ms)}`
														: log.first_token_ms != null
															? `TTFT ${ms(log.first_token_ms)}`
															: `Up ${ms(log.upstream_response_ms)}`}
												</span>
												{log.status === 'error' && log.error_message && (
													<span
														className='text-destructive block max-w-48 truncate'
														title={safeLogText(log.error_message)}
													>
														{safeLogText(log.error_message)}
													</span>
												)}
											</span>
											<span
												className='text-muted-foreground'
												aria-hidden='true'
											>
												{open ? '▾' : '▸'}
											</span>
										</button>
									</td>
									<td className='max-w-48 px-3 py-3 align-top'>
										<div
											className='truncate'
											title={log.user_email ?? undefined}
										>
											{log.user_email || '—'}
										</div>
										<div
											className='text-muted-foreground truncate font-mono'
											title={log.external_system ?? undefined}
										>
											{log.external_system || '—'}
										</div>
									</td>
									<td className='max-w-[36rem] px-3 py-3 align-top'>
										<RouteCell log={log} providers={props.providers} />
									</td>
									<td className='px-3 py-3 align-top'>
										<div className='flex flex-wrap gap-1'>
											{tags.map((tag) => (
												<span
													key={tag}
													className='bg-muted rounded px-1.5 py-0.5'
													title={
														tag === 'llm' && model
															? `${model.display_name || model.id}`
															: undefined
													}
												>
													{t(
														prefix +
															(['llm', 'image', 'tts', 'asr', 'tool'].includes(
																tag
															)
																? `tags.kind.${tag}`
																: `tags.${tag}`)
													)}
												</span>
											))}
										</div>
									</td>
									<td className='px-3 py-3 align-top font-mono whitespace-nowrap'>
										{logUsage(log, {
											images: t(prefix + 'usage.images'),
											seconds: t(prefix + 'usage.seconds'),
											characters: t(prefix + 'usage.characters'),
											tokens: t(prefix + 'usage.tokens'),
										})}
									</td>
									<td
										className='px-3 py-3 align-top whitespace-nowrap'
										title={`${t(prefix + 'standardCost')}: ${standard ?? '—'}`}
									>
										<div>
											C {charged ?? '—'}{' '}
											<small className='text-muted-foreground'>
												{multiplier(
													log.charged_cost,
													log.standard_cost,
													props.locale
												)}
											</small>
										</div>
										<div>
											M {metered ?? '—'}{' '}
											<small className='text-muted-foreground'>
												{multiplier(
													log.metered_cost,
													log.standard_cost,
													props.locale
												)}
											</small>
										</div>
									</td>
									<td
										className={`px-3 py-3 align-top font-medium whitespace-nowrap ${profit && log.charged_cost - log.metered_cost < 0 ? 'text-destructive' : ''}`}
									>
										{profit ?? '—'}
									</td>
								</tr>
								{open && (
									<tr>
										<td colSpan={7} id={`request-log-detail-${log.id}`}>
											<RequestLogDetail log={log} />
										</td>
									</tr>
								)}
							</Fragment>
						)
					})}
				</tbody>
			</table>
			{props.page.data.length === 0 && (
				<p className='text-muted-foreground p-8 text-center text-sm'>
					{t(prefix + 'noData')}
				</p>
			)}
		</div>
	)
}
