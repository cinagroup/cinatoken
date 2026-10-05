/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { ToolInvocationFilters } from './ToolInvocationFilters'
import { ToolInvocationTable } from './ToolInvocationTable'
import { toolRequestLogsHref } from './tool-invocation-domain'
import {
	useToolInvocations,
	type ToolInvocationsProps,
} from './use-tool-invocations'

const prefix = 'cinatoken.adminToolInvocations.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}
export function AdminToolInvocations(props: ToolInvocationsProps) {
	const { t, i18n } = useTranslation()
	const state = useToolInvocations(props)
	const totalPages = state.page
		? Math.max(1, Math.ceil(state.page.total / 50))
		: 1
	const context = JSON.stringify([props.scopeKey, state.effectiveSearch])
	const requestLogsHref = state.effectiveSearch
		? toolRequestLogsHref(state.effectiveSearch)
		: null
	return (
		<main className='min-w-0 space-y-5'>
			<header className='flex flex-wrap items-start justify-between gap-4'>
				<div>
					<h1 className='text-2xl font-semibold'>
						{t(prefix + 'invocations.title')}
					</h1>
					<p className='text-muted-foreground mt-1 max-w-3xl text-sm'>
						{t(prefix + 'invocations.subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap items-center gap-3 text-sm'>
					<a
						href='/admin/tools'
						className='text-primary underline-offset-2 hover:underline'
					>
						{t(prefix + 'invocations.configureTools')}
					</a>
					{requestLogsHref ? (
						<a
							href={requestLogsHref}
							className='bg-background hover:bg-muted rounded-md border px-3 py-2 font-medium'
						>
							{t(prefix + 'invocations.openInRequestLogs')}
						</a>
					) : (
						<span className='text-muted-foreground rounded-md border px-3 py-2'>
							{t(prefix + 'invocations.openInRequestLogs')}
						</span>
					)}
					<Button type='button' variant='outline' onClick={state.retry}>
						{t(prefix + 'refresh')}
					</Button>
				</div>
			</header>
			<ToolInvocationFilters
				search={props.search}
				effectiveSearch={state.effectiveSearch}
				timezone={state.timezone}
				onSearch={props.onSearch}
			/>
			<div className='text-muted-foreground flex flex-wrap items-center justify-between gap-2 text-xs'>
				<span>
					{t(prefix + 'timezone', { timezone: state.timezone ?? 'UTC' })}
				</span>
				<span>
					{state.displaySettled && !state.currency
						? t(prefix + 'unknownCurrency')
						: ''}
				</span>
				{state.displaySettled && !state.timezone && (
					<span>{t(prefix + 'timezoneFallback')}</span>
				)}
			</div>
			{state.logsBlocked || state.error ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
				>
					<p>
						{t(
							prefix +
								(state.logsBlocked ? 'accessDenied' : errorKey(state.error))
						)}
					</p>
					<Button
						type='button'
						variant='outline'
						className='mt-3'
						onClick={state.retry}
					>
						{t(prefix + 'retry')}
					</Button>
				</section>
			) : state.page ? (
				<ToolInvocationTable
					page={state.page}
					currency={state.currency}
					timezone={state.timezone}
					locale={i18n.resolvedLanguage || 'en'}
					context={context}
				/>
			) : (
				<p
					role='status'
					className='text-muted-foreground rounded-xl border p-8 text-center'
				>
					{t(prefix + 'loading')}
				</p>
			)}
			{state.page && (
				<nav
					aria-label={t(prefix + 'invocations.title')}
					className='flex flex-wrap items-center justify-center gap-3 text-sm'
				>
					<Button
						type='button'
						variant='outline'
						disabled={props.search.page <= 1}
						onClick={() =>
							props.onSearch({ ...props.search, page: props.search.page - 1 })
						}
					>
						{t(prefix + 'previous')}
					</Button>
					<span>
						{t(prefix + 'pageOf', {
							page: props.search.page,
							total: totalPages,
							count: state.page.total,
						})}
					</span>
					<Button
						type='button'
						variant='outline'
						disabled={props.search.page >= totalPages}
						onClick={() =>
							props.onSearch({ ...props.search, page: props.search.page + 1 })
						}
					>
						{t(prefix + 'next')}
					</Button>
				</nav>
			)}
		</main>
	)
}
