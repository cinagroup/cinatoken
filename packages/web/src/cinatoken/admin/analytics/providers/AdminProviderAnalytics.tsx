/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../../api'
import { ReliabilityRangeControls } from '../../reliability/ReliabilityRangeControls'
import { AnalyticsDrilldownControls } from '../models/AnalyticsDrilldownControls'
import { AnalyticsInsights } from '../models/AnalyticsInsights'
import { AnalyticsViewControls } from '../models/AnalyticsViewControls'
import { ModelAnalyticsSummary } from '../models/ModelAnalyticsSummary'
import { summarizeAnalyticsRows } from '../models/analytics-insights'
import {
	analyticsColumnVisible,
	type AnalyticsView,
} from '../models/analytics-view'
import {
	type SortDirection,
	type TokenMode,
} from '../models/model-analytics-domain'
import { ProviderAnalyticsFilters } from './ProviderAnalyticsFilters'
import { ProviderAnalyticsTable } from './ProviderAnalyticsTable'
import { ProviderDirectoryControls } from './ProviderDirectoryControls'
import {
	providerAnalyticsCsv,
	sortProviderRows,
	type ProviderSortKey,
} from './provider-analytics-domain'
import {
	providerDimension,
	providerKindFilterBlocked,
	filterProviderDimensions,
} from './provider-dimensions'
import { useAnalyticsProviderDirectory } from './use-analytics-provider-directory'
import {
	useProviderAnalytics,
	type ProviderAnalyticsProps,
} from './use-provider-analytics'
import { useProviderDimensionLabels } from './use-provider-dimension-labels'

const prefix = 'cinatoken.adminProviderAnalytics.'
function errorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}

export function AdminProviderAnalytics(props: ProviderAnalyticsProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const state = useProviderAnalytics(props)
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

	const [sortKey, setSortKey] = useState<ProviderSortKey>('provider_name')
	const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
	const [tokenMode, setTokenMode] = useState<TokenMode>('compact')
	const [view, setView] = useState<AnalyticsView>('overview')
	const [search, setSearch] = useState('')
	const [kindFilter, setKindFilter] = useState('')
	const dimensionLabels = useProviderDimensionLabels()
	const dimensions = useMemo(
		() =>
			new Map(
				(state.main?.rows ?? []).map((row) => [
					row.provider_id,
					providerDimension(
						row.provider_id,
						directoryState.directory,
						locale,
						dimensionLabels
					),
				])
			),
		[state.main?.rows, directoryState.directory, locale, dimensionLabels]
	)
	const filterBlocked = providerKindFilterBlocked(
		kindFilter,
		directoryState.directory
	)
	const currency = state.display?.currency ?? null
	const timezone = state.display?.timezone ?? null
	const rows = useMemo(
		() =>
			sortProviderRows(
				filterProviderDimensions(
					state.main?.rows ?? [],
					search,
					kindFilter,
					dimensions
				),
				sortKey,
				sortDirection,
				dimensions,
				locale
			),
		[
			state.main?.rows,
			search,
			kindFilter,
			dimensions,
			sortKey,
			sortDirection,
			locale,
		]
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
	function sort(key: ProviderSortKey): void {
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
			setSortKey('provider_name')
			setSortDirection('asc')
		}
	}
	function searchRows(value: string): void {
		setSearch(value)
		state.collapseRows()
	}
	function changeKind(value: string): void {
		setKindFilter(value)
		state.collapseRows()
	}
	function retryDirectory(): void {
		changeKind(kindFilter)
		directoryState.retry()
	}
	function download(): void {
		if (
			filterBlocked ||
			!state.main ||
			!state.rangeParams ||
			!currency ||
			state.mainQuery.isFetching
		)
			return
		const csv = providerAnalyticsCsv(
			rows,
			state.rangeParams,
			currency,
			dimensions
		)
		const url = URL.createObjectURL(
			new Blob([csv], { type: 'text/csv;charset=utf-8' })
		)
		const link = document.createElement('a')
		link.href = url
		link.download = 'provider-analytics.csv'
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
					onRetry={retryDirectory}
					filter={{ value: kindFilter, onChange: changeKind, dimensions }}
				/>
				{filterBlocked ? (
					<p
						role='alert'
						className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
					>
						{t(prefix + 'directoryFilterBlocked')}
					</p>
				) : (
					<>
						<AnalyticsViewControls
							view={view}
							onView={selectView}
							search={search}
							onSearch={searchRows}
							count={rows.length}
							total={state.main.rows.length}
							scope='providers'
						/>
						<ModelAnalyticsSummary
							currency={currency}
							locale={locale}
							totals={totals}
							tokenMode={tokenMode}
							exportDisabled={!currency || state.mainQuery.isFetching}
							onToggleTokens={() =>
								setTokenMode((mode) =>
									mode === 'compact' ? 'numeric' : 'compact'
								)
							}
							onExport={download}
						/>
						<AnalyticsInsights
							summary={totals}
							currency={currency}
							locale={locale}
							scope='providers'
						/>
						<AnalyticsDrilldownControls
							count={state.details.size}
							onCollapse={state.collapseRows}
						/>
						<ProviderAnalyticsTable
							directory={directoryState.directory}
							view={view}
							emptyMessage={
								search.trim() || kindFilter
									? t(prefix + 'viewNoMatches')
									: undefined
							}
							rows={rows}
							range={state.rangeParams}
							tag={state.tag}
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
					</>
				)}
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
			<ProviderAnalyticsFilters
				tag={state.tag}
				tags={state.main?.tags ?? []}
				rangeParams={state.rangeParams}
				onApply={state.setTag}
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
