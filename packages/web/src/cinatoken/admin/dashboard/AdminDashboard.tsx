/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { DashboardOverview } from './DashboardOverview'
import { DashboardRangeControls } from './DashboardRangeControls'
import { RecentPanel } from './DashboardRecent'
import { TokenTrend } from './DashboardTrend'
import { UsagePanels } from './DashboardUsage'
import {
	dashboardAccessIdentityKey,
	dashboardAccessRecovery,
} from './dashboard-access-recovery'
import type { AdminDashboardApi } from './dashboard-api'
import { DashboardCurrencyUnavailableError } from './dashboard-contracts'
import { dashboardRangePath, type DashboardRange } from './dashboard-range'

const prefix = 'cinatoken.adminDashboard.'

export type AdminDashboardProps = {
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
	const [range, setRange] = useState<DashboardRange>({
		kind: 'preset',
		value: '1d',
	})
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
			dashboardRangePath(range),
			retryVersion,
		],
		queryFn: ({ signal }) => props.api.dashboard(range, { signal }),
		enabled: !accessRevoked,
		retry: false,
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
					onClick={retry}
					disabled={query.isFetching}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<DashboardRangeControls range={range} onChange={setRange} />
			{accessRevoked ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
				>
					<p>{t(prefix + 'accessDenied')}</p>
					<Button
						className='mt-4'
						type='button'
						variant='outline'
						onClick={retry}
					>
						{t(prefix + 'retry')}
					</Button>
				</section>
			) : query.isFetching ? (
				<p
					role='status'
					className='text-muted-foreground rounded-xl border p-8 text-center'
				>
					{t(prefix + 'loading')}
				</p>
			) : query.error ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
				>
					<p>{t(prefix + errorKey)}</p>
					<Button
						className='mt-4'
						type='button'
						variant='outline'
						onClick={retry}
					>
						{t(prefix + 'retry')}
					</Button>
				</section>
			) : snapshot ? (
				<>
					<DashboardOverview snapshot={snapshot} locale={locale} />
					<TokenTrend
						rows={snapshot.stats.timeseries}
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
			) : null}
		</main>
	)
}
