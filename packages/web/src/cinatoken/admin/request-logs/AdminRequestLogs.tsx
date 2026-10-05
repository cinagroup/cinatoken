/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { RequestLogFilters } from './RequestLogFilters'
import { RequestLogTargetDialog } from './RequestLogTargetDialog'
import { RequestLogsContent } from './RequestLogsContent'
import { useRequestLogs, type RequestLogsProps } from './use-request-logs'

const prefix = 'cinatoken.adminRequestLogs.'
export function AdminRequestLogs(props: RequestLogsProps) {
	const { t } = useTranslation()
	const state = useRequestLogs(props)
	const [expanded, setExpanded] = useState<{
		id: string
		context: string
	} | null>(null)
	const context = JSON.stringify([props.scopeKey, state.effectiveSearch])
	const activeId = expanded?.context === context ? expanded.id : null
	const totalPages = state.page
		? Math.max(1, Math.ceil(state.page.total / 50))
		: 1
	function turnPage(page: number): void {
		props.onSearch({ ...props.search, page })
	}
	return (
		<main className='min-w-0 space-y-5'>
			{props.search.request_id && !state.logsBlocked && !state.error && (
				<RequestLogTargetDialog
					key={JSON.stringify([
						props.scopeKey,
						props.reconciliationKey,
						props.search.request_id,
					])}
					api={props.api}
					scopeKey={props.scopeKey}
					reconciliationKey={props.reconciliationKey}
					requestId={props.search.request_id}
					onAccessLost={state.invalidateLogs}
					onClose={() =>
						props.onSearch({ ...props.search, request_id: undefined })
					}
				/>
			)}
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h1 className='text-2xl font-semibold'>{t(prefix + 'title')}</h1>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<Button type='button' variant='outline' onClick={state.retry}>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<RequestLogFilters
				search={props.search}
				effectiveSearch={state.effectiveSearch}
				timezone={state.timezone}
				models={state.models}
				providers={state.providers}
				routes={state.routes}
				catalogSettled={state.catalogSettled}
				onSearch={props.onSearch}
			/>
			<div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
				<p>
					{state.page
						? t(prefix + 'totalRequests', { count: state.page.total })
						: '—'}
				</p>
				<div className='text-muted-foreground flex flex-wrap gap-2 text-xs'>
					{state.page && (
						<span>
							{t(prefix + 'pageOf', {
								page: props.search.page,
								total: totalPages,
							})}
						</span>
					)}
					{state.displaySettled && !state.currency && (
						<span>{t(prefix + 'unknownCurrency')}</span>
					)}
					{state.displaySettled && !state.timezone && (
						<span>{t(prefix + 'timezoneFallback')}</span>
					)}
				</div>
			</div>
			<div className='text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs'>
				{(
					[
						['success', 'bg-emerald-500'],
						['error', 'bg-red-500'],
						['incomplete', 'bg-amber-500'],
						['cancelled', 'bg-violet-500'],
					] as const
				).map(([status, color]) => (
					<span key={status} className='inline-flex items-center gap-1.5'>
						<span
							aria-hidden='true'
							className={`h-2.5 w-2.5 rounded-sm ${color}`}
						/>
						{t(prefix + `status.${status}`)}
					</span>
				))}
				<span className='inline-flex items-center gap-1.5'>
					<span
						aria-hidden='true'
						className='h-2.5 w-2.5 rounded-sm bg-slate-400'
					/>
					{t(prefix + 'statusOther')}
				</span>
			</div>
			<RequestLogsContent
				state={state}
				expanded={activeId}
				onExpand={(id) => setExpanded(activeId === id ? null : { id, context })}
			/>
			{state.page && (totalPages > 1 || props.search.page > 1) && (
				<nav
					aria-label={t(prefix + 'title')}
					className='flex items-center justify-center gap-3'
				>
					<Button
						type='button'
						variant='outline'
						disabled={props.search.page <= 1}
						onClick={() => turnPage(props.search.page - 1)}
					>
						{t(prefix + 'previous')}
					</Button>
					<span className='text-sm'>
						{t(prefix + 'pageOf', {
							page: props.search.page,
							total: totalPages,
						})}
					</span>
					<Button
						type='button'
						variant='outline'
						disabled={props.search.page >= totalPages}
						onClick={() => turnPage(props.search.page + 1)}
					>
						{t(prefix + 'next')}
					</Button>
				</nav>
			)}
		</main>
	)
}
