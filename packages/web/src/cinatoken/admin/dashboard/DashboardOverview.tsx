/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { KpiCard } from './DashboardKpiCard'
import type { DashboardSnapshot } from './dashboard-contracts'
import { formatCompact, formatMoney, formatNumber } from './dashboard-format'

const prefix = 'cinatoken.adminDashboard.'

export function DashboardOverview(props: {
	snapshot: DashboardSnapshot
	locale: string
}) {
	const { t } = useTranslation()
	return (
		<>
			<div className='text-muted-foreground flex flex-wrap gap-x-5 gap-y-1 text-xs'>
				<span>
					{t(
						prefix +
							(props.snapshot.displayConfig.timezoneSource === 'configured' ||
							props.snapshot.displayConfig.timezoneSource === 'legacy'
								? 'timezone'
								: 'timezoneFallback'),
						{ timezone: props.snapshot.displayConfig.businessTimezone }
					)}
				</span>
				<span>
					{t(
						prefix +
							(props.snapshot.displayConfig.currencySource === 'configured'
								? 'currency'
								: 'currencyFallback'),
						{ currency: props.snapshot.displayConfig.billingCurrency }
					)}
				</span>
			</div>
			<div className='space-y-3'>
				<h2 className='text-muted-foreground text-sm font-semibold tracking-wide uppercase'>
					{t(prefix + 'today')}
				</h2>
				<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-5'>
					<KpiCard
						label={t(prefix + 'keys')}
						value={formatNumber(
							props.snapshot.stats.gateway.keysTotal,
							props.locale
						)}
						hint={t(prefix + 'activeOfTotal', {
							active: formatNumber(
								props.snapshot.stats.gateway.keysActive,
								props.locale
							),
							total: formatNumber(
								props.snapshot.stats.gateway.keysTotal,
								props.locale
							),
						})}
					/>
					<KpiCard
						label={t(prefix + 'accounts')}
						value={formatNumber(
							props.snapshot.stats.gateway.accountsTotal,
							props.locale
						)}
						hint={t(prefix + 'activeOfTotal', {
							active: formatNumber(
								props.snapshot.stats.gateway.accountsActive,
								props.locale
							),
							total: formatNumber(
								props.snapshot.stats.gateway.accountsTotal,
								props.locale
							),
						})}
					/>
					<KpiCard
						label={t(prefix + 'todayRequests')}
						value={formatNumber(
							props.snapshot.stats.gateway.todayRequestsCount,
							props.locale
						)}
					/>
					<KpiCard
						label={t(prefix + 'todayCost')}
						value={formatMoney(
							props.snapshot.stats.gateway.todayCost,
							props.snapshot.displayConfig.billingCurrency,
							props.locale
						)}
					/>
					<KpiCard
						label={t(prefix + 'todayTokens')}
						value={formatCompact(
							props.snapshot.stats.gateway.todayTokens,
							props.locale
						)}
					/>
				</div>
			</div>
			<div className='space-y-3'>
				<h2 className='text-muted-foreground text-sm font-semibold tracking-wide uppercase'>
					{t(prefix + 'selectedRange')}
				</h2>
				<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
					<KpiCard
						label={t(prefix + 'rangeRequests')}
						value={formatNumber(
							props.snapshot.stats.kpi.totalRequests,
							props.locale
						)}
					/>
					<KpiCard
						label={t(prefix + 'rangeCost')}
						value={formatMoney(
							props.snapshot.stats.kpi.totalCost,
							props.snapshot.displayConfig.billingCurrency,
							props.locale
						)}
						hint={`${t(prefix + 'standardCost', { value: formatMoney(props.snapshot.stats.kpi.standardCost, props.snapshot.displayConfig.billingCurrency, props.locale) })} · ${t(prefix + 'meteredCost', { value: formatMoney(props.snapshot.stats.kpi.meteredCost, props.snapshot.displayConfig.billingCurrency, props.locale) })}`}
					/>
					<KpiCard
						label={t(prefix + 'activeUsers')}
						value={formatNumber(
							props.snapshot.stats.kpi.activeUsers,
							props.locale
						)}
					/>
					<KpiCard
						label={t(prefix + 'successRate')}
						value={`${props.snapshot.stats.kpi.successRate.toFixed(1)}%`}
					/>
					<KpiCard
						label={t(prefix + 'errorRate')}
						value={`${props.snapshot.stats.kpi.errorRate.toFixed(2)}%`}
						emphasis={
							props.snapshot.stats.kpi.errorRate > 5 ? 'danger' : 'normal'
						}
					/>
					<KpiCard
						label={t(prefix + 'latency')}
						value={
							props.snapshot.stats.kpi.avgLatencyMs === null
								? '—'
								: `${Math.round(props.snapshot.stats.kpi.avgLatencyMs)} ms`
						}
					/>
					<KpiCard
						label={t(prefix + 'throughput')}
						value={t(prefix + 'rpmTpm', {
							rpm: formatNumber(props.snapshot.stats.kpi.rpm, props.locale),
							tpm: formatCompact(props.snapshot.stats.kpi.tpm, props.locale),
						})}
					/>
				</div>
			</div>
		</>
	)
}
