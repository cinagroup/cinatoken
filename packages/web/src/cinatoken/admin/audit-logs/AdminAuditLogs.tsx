/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { AuditLogExportButton } from './AuditLogExportButton'
import { AuditLogFilters } from './AuditLogFilters'
import { AuditLogTable } from './AuditLogTable'
import { useAuditLogs, type AuditLogsProps } from './use-audit-logs'

const prefix = 'cinatoken.adminAuditLogs.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}
export function AdminAuditLogs(props: AuditLogsProps) {
	const { t, i18n } = useTranslation()
	const state = useAuditLogs(props)
	const totalPages = state.page
		? Math.max(1, Math.ceil(state.page.total / 50))
		: 1
	const context = JSON.stringify([props.scopeKey, state.effectiveSearch])
	function turnPage(page: number): void {
		props.onSearch({ ...props.search, page })
	}
	return (
		<main className='min-w-0 space-y-5'>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h1 className='text-2xl font-semibold'>{t(prefix + 'title')}</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap items-center gap-2'>
					<AuditLogExportButton
						key={`${context}:${state.logsBlocked}`}
						api={props.api}
						search={state.effectiveSearch}
						blocked={state.logsBlocked}
						onDenied={state.denyLogs}
					/>
					<Button type='button' variant='outline' onClick={state.retry}>
						{t(prefix + 'refresh')}
					</Button>
				</div>
			</header>
			<AuditLogFilters
				search={props.search}
				effectiveSearch={state.effectiveSearch}
				timezone={state.timezone}
				reasonCodes={state.reasonCodes}
				onSearch={props.onSearch}
			/>
			<div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
				<p>
					{state.page
						? t(prefix + 'totalRecords', { count: state.page.total })
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
				<AuditLogTable
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
