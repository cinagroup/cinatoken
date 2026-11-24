/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../../api'
import { ReliabilityRangeControls } from '../../reliability/ReliabilityRangeControls'
import { ProviderDirectoryControls } from '../providers/ProviderDirectoryControls'
import { useAnalyticsProviderDirectory } from '../providers/use-analytics-provider-directory'
import { AnalyticsDrilldownControls } from './AnalyticsDrilldownControls'
import { AnalyticsInsights } from './AnalyticsInsights'
import { AnalyticsViewControls } from './AnalyticsViewControls'
import { ModelAnalyticsFilterControls } from './ModelAnalyticsFilters'
import { ModelAnalyticsSummary } from './ModelAnalyticsSummary'
import { ModelAnalyticsTable } from './ModelAnalyticsTable'
import { summarizeAnalyticsRows } from './analytics-insights'
import {
	analyticsColumnVisible,
	filterModelAnalyticsRows,
	type AnalyticsView,
} from './analytics-view'
import {
	modelAnalyticsCsv,
	sortModelRows,
	type ModelSortKey,
	type SortDirection,
	type TokenMode,
} from './model-analytics-domain'
import {
	useModelAnalytics,
	type ModelAnalyticsProps,
} from './use-model-analytics'

const prefix = 'cinatoken.adminModelAnalytics.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}

export function AdminModelAnalytics(props: ModelAnalyticsProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const state = useModelAnalytics(props)
	const directoryState = useAnalyticsProviderDirectory({
		api: props.directoryApi,
		subject: props.directorySubject,
		scopeKey: props.scopeKey,
		reconciliationKey: props.reconciliationKey,
		revalidate: props.revalidate,
		enabled: !state.analyticsBlocked,
	})
	function retryAll(): void {
		state.retry()
		directoryState.retry()
	}

	const [sortKey, setSortKey] = useState<ModelSortKey>('model_id')
	const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
	const [tokenMode, setTokenMode] = useState<TokenMode>('compact')
	const [view, setView] = useState<AnalyticsView>('overview')
	const [search, setSearch] = useState('')
	const currency = state.display?.currency ?? null
	const timezone = state.display?.timezone ?? null
	const rows = useMemo(
		() =>
			sortModelRows(
				filterModelAnalyticsRows(state.main?.rows ?? [], search),
				sortKey,
				sortDirection
			),
		[state.main?.rows, search, sortKey, sortDirection]
	)
	const totals = useMemo(() => summarizeAnalyticsRows(rows), [rows])
	const configFailed = state.displayBlocked || Boolean(state.displayQuery.error)
	const analyticsFailed =
		state.analyticsBlocked || Boolean(state.mainQuery.error)
	const logsAllowed =
		!state.logsBlocked &&
		!state.logsQuery.isFetching &&
		!state.logsQuery.error &&
		state.logsQuery.data === true
	function sort(key: ModelSortKey): void {
		if (sortKey === key)
			setSortDirection((direction) => (direction === 'asc' ? 'desc' : 'asc'))
		else {
			setSortKey(key)
			setSortDirection('desc')
		}
	}
	function selectView(next: AnalyticsView): void {
		setView(next)
		if (!analyticsColumnVisible(sortKey, next)) {
			setSortKey('model_id')
			setSortDirection('asc')
		}
	}
	function searchRows(value: string): void {
		setSearch(value)
		state.collapseRows()
	}
	function download(): void {
		if (
			!state.main ||
			!state.rangeParams ||
			!currency ||
			state.mainQuery.isFetching
		)
			return
		const csv = modelAnalyticsCsv(rows, state.rangeParams, currency)
		const url = URL.createObjectURL(
			new Blob([csv], { type: 'text/csv;charset=utf-8' })
		)
		const link = document.createElement('a')
		link.href = url
		link.download = 'model-analytics.csv'
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
					onClick={retryAll}
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
				<ProviderDirectoryControls
					directory={directoryState.directory}
					isFetching={directoryState.isFetching}
					onRetry={directoryState.retry}
				/>
				<AnalyticsViewControls
					view={view}
					onView={selectView}
					search={search}
					onSearch={searchRows}
					count={rows.length}
					total={state.main.rows.length}
					scope='models'
				/>
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
				<AnalyticsInsights
					summary={totals}
					currency={currency}
					locale={locale}
					scope='models'
				/>
				<AnalyticsDrilldownControls
					count={state.details.size}
					onCollapse={state.collapseRows}
				/>
				<ModelAnalyticsTable
					directory={directoryState.directory}
					view={view}
					emptyMessage={search.trim() ? t(prefix + 'viewNoMatches') : undefined}
					rows={rows}
					range={state.rangeParams}
					details={state.details}
					logsAllowed={logsAllowed}
					currency={currency}
					locale={locale}
					tokenMode={tokenMode}
					sortKey={sortKey}
					sortDirection={sortDirection}
					onSort={sort}
					onToggle={state.toggleRow}
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
					onClick={retryAll}
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
			<ModelAnalyticsFilterControls
				filters={state.filters}
				tags={state.main?.tags ?? []}
				rangeParams={state.rangeParams}
				onApply={state.setFilters}
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
			{content}
		</main>
	)
}
