/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type { AdminModel } from '../model-contracts'
import { RouteTargetCard, type RouteTargetAction } from './RouteTargetCard'
import type { RoutePoolView, RouteRow } from './route-domain'
import {
	effectiveRouteStrategy,
	groupPriorityTargets,
	type StrategySource,
} from './route-workspace-domain'
import type { StickyBindingsSummary } from './routes-contracts'

const prefix = 'cinatoken.adminRoutes.'
const sources: Record<StrategySource, string> = {
	tier: 'sourceTier',
	pool: 'sourcePool',
	modelOperation: 'sourceModelOperation',
	modelProtocol: 'sourceModelProtocol',
	model: 'sourceModel',
	global: 'sourceGlobal',
	default: 'sourceDefault',
}
export function RoutePoolCard(props: {
	pool: RoutePoolView
	model: AdminModel | undefined
	globalStrategy: string | null
	contextVerified: boolean
	timezone: string | null
	view: 'topology' | 'summary'
	disabled: boolean
	summary: StickyBindingsSummary | null | undefined
	onPool: (
		action: 'policy' | 'modelPolicy' | 'sticky',
		pool: RoutePoolView
	) => void
	onTarget: (action: RouteTargetAction, row: RouteRow) => void
	onCreate: (pool: RoutePoolView) => void
}) {
	const { t } = useTranslation()
	const pool = props.pool
	const status = pool.status ?? pool.surface.status
	const tiers = groupPriorityTargets(pool)
	function strategy(priority?: number) {
		if (!props.contextVerified || !props.model)
			return <span>{t(prefix + 'unknown')}</span>
		const effective = effectiveRouteStrategy(
			pool,
			props.model,
			props.globalStrategy,
			priority
		)
		return (
			<span>
				{effective.strategy} ·{' '}
				{t(prefix + 'strategySource', {
					source: t(prefix + sources[effective.source]),
				})}
			</span>
		)
	}
	return (
		<section className='min-w-0 space-y-3 rounded-xl border p-4'>
			<div className='flex flex-wrap items-start justify-between gap-2'>
				<div className='min-w-0'>
					<h3 className='text-sm font-semibold break-words'>
						{pool.surface.request_protocol}.{pool.surface.request_operation} →{' '}
						{pool.name || pool.id || t(prefix + 'pool')}
					</h3>
					<p className='text-muted-foreground text-xs break-all'>
						{pool.modelName} · {pool.group} · {pool.targets.length}{' '}
						{t(prefix + 'targets')}
					</p>
				</div>
				<span className='rounded-full border px-2 py-1 text-xs'>
					{pool.surface.status === 'unknown'
						? t(prefix + 'legacySurface')
						: t(
								prefix +
									(['active', 'inactive'].includes(status) ? status : 'unknown')
							)}
				</span>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'effectiveStrategy')}: {strategy()}
			</p>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'sticky')}:{' '}
				{t(prefix + (pool.stickyEnabled ? 'active' : 'inactive'))} ·{' '}
				{pool.stickyIdleTtlSeconds}s · {t(prefix + 'stickyEpoch')}{' '}
				{pool.stickyEpoch}
			</p>
			{props.summary && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'stickySummary', {
						active: props.summary.total_active,
						stale: props.summary.stale_count,
					})}
				</p>
			)}
			{pool.id && !props.summary && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'sticky')}: {t(prefix + 'unknown')}
				</p>
			)}
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={!pool.id || props.disabled}
					onClick={() => props.onPool('policy', pool)}
				>
					{t(prefix + 'poolPolicy')}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={props.disabled || !props.model}
					onClick={() => props.onPool('modelPolicy', pool)}
				>
					{t(prefix + 'modelPolicy')}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={!pool.id}
					onClick={() => props.onPool('sticky', pool)}
				>
					{t(prefix + 'sticky')}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={props.disabled || pool.surface.status === 'unknown'}
					onClick={() => props.onCreate(pool)}
				>
					{t(prefix + 'addTarget')}
				</Button>
			</div>
			{props.view === 'topology' && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'trafficPath')}
				</p>
			)}
			<div className='space-y-3'>
				{tiers.map((tier) => (
					<details
						key={tier.priority}
						open={props.view === 'topology'}
						className='rounded-lg border p-3'
					>
						<summary className='cursor-pointer text-sm font-medium'>
							{t(prefix + 'tier', {
								priority: tier.priority,
								count: tier.targets.length,
							})}
							<span className='text-muted-foreground mt-1 block text-xs font-normal'>
								{strategy(tier.priority)}
							</span>
						</summary>
						<div className='mt-3 space-y-2'>
							{tier.targets.map((row) => (
								<RouteTargetCard
									key={row.id}
									row={row}
									disabled={props.disabled}
									timezone={props.timezone}
									summary={props.summary}
									onAction={props.onTarget}
								/>
							))}
						</div>
					</details>
				))}
			</div>
		</section>
	)
}
