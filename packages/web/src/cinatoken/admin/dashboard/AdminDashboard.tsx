/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { ReliabilityRangeControls } from '../reliability/ReliabilityRangeControls'
import type { ReliabilityRange } from '../reliability/reliability-range'
import { DashboardOperations } from './DashboardOperations'
import { DashboardOverview } from './DashboardOverview'
import { RecentPanel } from './DashboardRecent'
import { TokenTrend } from './DashboardTrend'
import { UsagePanels } from './DashboardUsage'
import {
	dashboardAccessIdentityKey,
	dashboardAccessRecovery,
} from './dashboard-access-recovery'
import type { AdminDashboardApi } from './dashboard-api'
import { DashboardCurrencyUnavailableError } from './dashboard-contracts'
import {
	dashboardRefreshIntervals,
	readDashboardRefresh,
	writeDashboardRefresh,
	subscribeDashboardRefresh,
} from './dashboard-refresh'

const prefix = 'cinatoken.adminDashboard.'

export type AdminDashboardProps = {
	range: ReliabilityRange
	onRangeChange: (range: ReliabilityRange) => void
	api: AdminDashboardApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
}

function dashboardErrorKey(error: unknown): string {
	if (error instanceof DashboardCurrencyUnavailableError)
		return 'currencyUnavailable'
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}

export function AdminDashboard(props: AdminDashboardProps) {
	const { t, i18n } = useTranslation()
	const revalidate = props.revalidate
	const locale = i18n.resolvedLanguage ?? 'en'
	const range = props.range
	const interval = useSyncExternalStore(
		subscribeDashboardRefresh,
		readDashboardRefresh,
		() => 0
	)
	const [editingRange, setEditingRange] = useState(false)
	const [retryVersion, setRetryVersion] = useState(0)
	const access = dashboardAccessRecovery(props.api)
	const accessKey = dashboardAccessIdentityKey(props.reconciliationKey)
	const accessSnapshot = useCallback(
		() => access.getSnapshot(accessKey),
		[access, accessKey]
	)
	const accessRevoked = useSyncExternalStore(
		access.subscribe,
		accessSnapshot,
		accessSnapshot
	)
	const query = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'dashboard',
			JSON.stringify(range),
			retryVersion,
		],
		queryFn: ({ signal }) => props.api.dashboardWindow(range, { signal }),
		enabled: !accessRevoked,
		retry: false,
		refetchInterval: (current) =>
			!accessRevoked &&
			!editingRange &&
			!current.state.error &&
			range.kind !== 'custom' &&
			interval > 0
				? interval
				: false,
		refetchIntervalInBackground: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const denied =
		query.error instanceof CinaTokenApiError &&
		(query.error.status === 401 || query.error.status === 403)
	useEffect(() => {
		if (!denied) return
		if (access.block(accessKey)) void revalidate().catch(() => undefined)
	}, [access, accessKey, denied, revalidate])

	const snapshot =
		!accessRevoked && !query.isFetching && !query.error ? query.data : null
	const errorKey = dashboardErrorKey(query.error)

	function retry(): void {
		setRetryVersion((version) => version + 1)
		access.settle(accessKey)
	}

	let content = <></>
	if (accessRevoked || query.error) {
		content = (
			<section
				role='alert'
				className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
			>
				<p>{t(prefix + (accessRevoked ? 'accessDenied' : errorKey))}</p>
				<Button
					className='mt-4'
					type='button'
					variant='outline'
					onClick={retry}
				>
					{t(prefix + 'retry')}
				</Button>
			</section>
		)
	} else if (query.isFetching) {
		content = (
			<p
				role='status'
				className='text-muted-foreground rounded-xl border p-8 text-center'
			>
				{t(prefix + 'loading')}
			</p>
		)
	} else if (snapshot) {
		content = (
			<>
				<DashboardOverview snapshot={snapshot} locale={locale} />
				<DashboardOperations snapshot={snapshot} locale={locale} />
				<TokenTrend
					rows={snapshot.stats.timeseries}
					granularity={snapshot.stats.granularity}
					currency={snapshot.displayConfig.billingCurrency}
					timezone={snapshot.displayConfig.businessTimezone}
					locale={locale}
				/>
				<UsagePanels
					stats={snapshot.stats}
					currency={snapshot.displayConfig.billingCurrency}
					locale={locale}
				/>
				<div className='grid gap-5 xl:grid-cols-2'>
					<RecentPanel
						rows={snapshot.stats.recentLogs}
						kind='requests'
						timezone={snapshot.displayConfig.businessTimezone}
						locale={locale}
					/>
					<RecentPanel
						rows={snapshot.stats.recentErrors}
						kind='errors'
						timezone={snapshot.displayConfig.businessTimezone}
						locale={locale}
					/>
				</div>
			</>
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
				<div className='flex flex-wrap items-center gap-3'>
					<label className='text-muted-foreground flex items-center gap-2 text-sm'>
						{t(prefix + 'autoRefresh')}
						<select
							className='bg-background rounded-md border px-2 py-2'
							value={interval}
							onChange={(e) => writeDashboardRefresh(Number(e.target.value))}
						>
							{dashboardRefreshIntervals.map((value) => (
								<option key={value} value={value}>
									{value === 0
										? t(prefix + 'refreshOff')
										: t(prefix + 'refreshSeconds', { seconds: value / 1000 })}
								</option>
							))}
						</select>
					</label>
					<Button
						type='button'
						variant='outline'
						onClick={retry}
						disabled={query.isFetching}
					>
						{t(prefix + 'refresh')}
					</Button>
				</div>
			</header>
			<ReliabilityRangeControls
				key={`${JSON.stringify(range)}/${query.data?.displayConfig.businessTimezone ?? ''}`}
				range={range}
				rangeParams={
					!accessRevoked && !query.error
						? (query.data?.rangeParams ?? null)
						: null
				}
				timezone={
					!accessRevoked && !query.error
						? (query.data?.displayConfig.businessTimezone ?? null)
						: null
				}
				onEditingChange={setEditingRange}
				onChange={(next) => {
					setEditingRange(false)
					props.onRangeChange(next)
				}}
			/>
			<p className='text-muted-foreground text-xs' role='status'>
				{(range.kind === 'custom' || editingRange) && interval > 0
					? t(prefix + 'refreshPaused')
					: null}
				{snapshot
					? t(prefix + 'updatedAt', {
							time: new Intl.DateTimeFormat(locale, {
								timeStyle: 'medium',
								timeZone: snapshot.displayConfig.businessTimezone,
							}).format(query.dataUpdatedAt),
						})
					: null}
			</p>
			{content}
		</main>
	)
}
