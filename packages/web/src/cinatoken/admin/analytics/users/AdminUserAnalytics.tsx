/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../../api'
import { ReliabilityRangeControls } from '../../reliability/ReliabilityRangeControls'
import { ModelAnalyticsSummary } from '../models/ModelAnalyticsSummary'
import {
	type SortDirection,
	type TokenMode,
} from '../models/model-analytics-domain'
import { UserAnalyticsFilters } from './UserAnalyticsFilters'
import { UserAnalyticsTable } from './UserAnalyticsTable'
import { useUserAnalytics, type UserAnalyticsProps } from './use-user-analytics'
import {
	sortUserRows,
	userAnalyticsCsv,
	userCostTotals,
	type UserSortKey,
} from './user-analytics-domain'

const prefix = 'cinatoken.adminUserAnalytics.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}

export function AdminUserAnalytics(props: UserAnalyticsProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const state = useUserAnalytics(props)
	const [sortKey, setSortKey] = useState<UserSortKey>('request_count')
	const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
	const [tokenMode, setTokenMode] = useState<TokenMode>('compact')
	const currency = state.display?.currency ?? null
	const timezone = state.display?.timezone ?? null
	const rows = useMemo(
		() => sortUserRows(state.main ?? [], sortKey, sortDirection),
		[state.main, sortKey, sortDirection]
	)
	const totals = useMemo(() => userCostTotals(rows), [rows])
	const configFailed = state.displayBlocked || Boolean(state.displayQuery.error)
	const analyticsFailed =
		state.analyticsBlocked || Boolean(state.mainQuery.error)
	const detailFailed =
		state.analyticsBlocked || Boolean(state.detailQuery.error)
	const logsAllowed =
		!state.logsBlocked &&
		!state.logsQuery.isFetching &&
		!state.logsQuery.error &&
		state.logsQuery.data === true
	function sort(key: UserSortKey): void {
		if (sortKey === key)
			setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
		else {
			setSortKey(key)
			setSortDirection('desc')
		}
	}
	function download(): void {
		if (
			!state.main ||
			!state.rangeParams ||
			!currency ||
			state.mainQuery.isFetching
		)
			return
		const csv = userAnalyticsCsv(rows, state.rangeParams, currency)
		const url = URL.createObjectURL(
			new Blob([csv], { type: 'text/csv;charset=utf-8' })
		)
		const link = document.createElement('a')
		link.href = url
		link.download = 'user-analytics.csv'
		link.click()
		URL.revokeObjectURL(url)
	}
	let content: ReactNode
	if (analyticsFailed) {
		content = (
			<section
				role='alert'
				className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
			>
				<p>
					{t(
						prefix +
							(state.analyticsBlocked
								? 'accessDenied'
								: errorKey(state.mainQuery.error))
					)}
				</p>
				<Button
					className='mt-4'
					type='button'
					variant='outline'
					onClick={state.retry}
				>
					{t(prefix + 'retry')}
				</Button>
			</section>
		)
	} else if (!state.main || !state.rangeParams) {
		content = (
			<p
				role='status'
				className='text-muted-foreground rounded-xl border p-8 text-center'
			>
				{t(prefix + 'loading')}
			</p>
		)
	} else {
		content = (
			<section className='space-y-3'>
				<ModelAnalyticsSummary
					currency={currency}
					locale={locale}
					totals={totals}
					tokenMode={tokenMode}
					exportDisabled={!currency || state.mainQuery.isFetching}
					onToggleTokens={() =>
						setTokenMode((mode) => (mode === 'compact' ? 'numeric' : 'compact'))
					}
					onExport={download}
				/>
				<UserAnalyticsTable
					rows={rows}
					range={state.rangeParams}
					active={state.active}
					detail={state.detail}
					detailLoading={state.detailQuery.isFetching}
					detailError={detailFailed}
					logsAllowed={logsAllowed}
					currency={currency}
					timezone={timezone}
					locale={locale}
					tokenMode={tokenMode}
					sortKey={sortKey}
					sortDirection={sortDirection}
					onSort={sort}
					onToggle={state.toggleRow}
					onRetry={state.retry}
				/>
			</section>
		)
	}
	return (
		<main className='min-w-0 space-y-6 pb-12'>
			<header className='flex flex-wrap items-start justify-between gap-4'>
				<div>
					<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<Button
					type='button'
					variant='outline'
					onClick={state.retry}
					disabled={state.mainQuery.isFetching || state.displayQuery.isFetching}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<ReliabilityRangeControls
				key={`${state.rangeParams?.startUtc ?? ''}:${state.rangeParams?.endUtc ?? ''}:${timezone ?? ''}`}
				range={state.range}
				rangeParams={state.rangeParams}
				timezone={timezone}
				onChange={state.selectRange}
			/>
			<UserAnalyticsFilters
				email={state.email}
				rangeParams={state.rangeParams}
				onApply={state.setEmail}
			/>
			<div className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs'>
				{state.display && (
					<span>
						{t(
							prefix +
								(state.display.timezoneSource === 'configured'
									? 'timezone'
									: 'timezoneFallback'),
							{ timezone: state.display.timezone }
						)}
					</span>
				)}
				{currency && (
					<span>
						{t(
							prefix +
								(state.display?.currencySource === 'missing'
									? 'currencyFallback'
									: 'currency'),
							{ currency }
						)}
					</span>
				)}
			</div>
			{configFailed && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'displayUnavailable')}
				</p>
			)}
			{state.display && !currency && (
				<p
					role='alert'
					className='rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm'
				>
					{t(prefix + 'currencyUnavailable')}
				</p>
			)}
			{!timezone && (
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'lastActiveUtcFallback')}
				</p>
			)}
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'budgetScope')}
			</p>
			{content}
		</main>
	)
}
