/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { RoutePoolCard } from './RoutePoolCard'
import type { RouteTargetAction } from './RouteTargetCard'
import {
	routeModelVendorLabel,
	type RouteFilters,
	type RoutePoolView,
	type RouteRow,
} from './route-domain'
import type { RouteModelGroup } from './route-workspace-domain'
import type { StickyBindingsSummary } from './routes-contracts'

const prefix = 'cinatoken.adminRoutes.'
export function RouteWorkspace(props: {
	groups: RouteModelGroup[]
	filters: RouteFilters
	disabled: boolean
	globalStrategy: string | null
	contextVerified: boolean
	timezone: string | null
	summaries: Map<string, StickyBindingsSummary | null | undefined>
	onPool: (
		action: 'policy' | 'modelPolicy' | 'sticky',
		pool: RoutePoolView
	) => void
	onTarget: (action: RouteTargetAction, row: RouteRow) => void
	onCreate: (modelId: string, pool?: RoutePoolView) => void
	onEditModel: (id: string, mode: 'edit' | 'delete') => void
}) {
	const { t } = useTranslation()
	const [copyNotice, setCopyNotice] = useState<'copied' | 'copyFailed' | null>(
		null
	)
	async function copy(id: string) {
		try {
			await navigator.clipboard.writeText(id)
			setCopyNotice('copied')
		} catch {
			setCopyNotice('copyFailed')
		}
	}
	function modelHeader(group: RouteModelGroup) {
		return (
			<div className='flex flex-wrap items-start justify-between gap-3'>
				<div className='min-w-0'>
					<h2 className='font-semibold break-words'>{group.name}</h2>
					<p className='text-muted-foreground text-xs break-all select-all'>
						{group.id} ·{' '}
						{group.model
							? t(prefix + 'kind' + group.model.kind)
							: t(prefix + 'unknown')}
					</p>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						size='sm'
						type='button'
						variant='outline'
						onClick={() => void copy(group.id)}
					>
						{t(prefix + 'copyModelId')}
					</Button>
					<Button
						size='sm'
						type='button'
						variant='outline'
						disabled={props.disabled || !group.model}
						onClick={() => props.onEditModel(group.id, 'edit')}
					>
						{t(prefix + 'editModel')}
					</Button>
					<Button
						type='button'
						size='sm'
						variant='destructive'
						disabled={props.disabled || !group.model}
						onClick={() => props.onEditModel(group.id, 'delete')}
					>
						{t(prefix + 'deleteModel')}
					</Button>
					<Button
						size='sm'
						type='button'
						disabled={props.disabled || !group.model}
						onClick={() => props.onCreate(group.id)}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</div>
		)
	}
	function poolCard(pool: RoutePoolView, group: RouteModelGroup) {
		return (
			<RoutePoolCard
				key={pool.key}
				pool={pool}
				model={group.model}
				globalStrategy={props.globalStrategy}
				contextVerified={props.contextVerified}
				timezone={props.timezone}
				view={props.filters.view}
				disabled={props.disabled}
				summary={pool.id ? props.summaries.get(pool.id) : null}
				onPool={props.onPool}
				onTarget={props.onTarget}
				onCreate={(item) => props.onCreate(group.id, item)}
			/>
		)
	}
	const unrouted = props.groups.filter((group) => !group.pools.length)
	const routed = props.groups.filter((group) => group.pools.length)
	const vendors = [...new Set(routed.map((group) => group.vendor))]
	const surfaces = [
		...new Set(
			routed.flatMap((group) =>
				group.pools.map(
					(pool) =>
						`${pool.surface.request_protocol}.${pool.surface.request_operation}`
				)
			)
		),
	].sort()
	return (
		<div className='min-w-0 space-y-6'>
			{copyNotice && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + copyNotice)}
				</p>
			)}
			{unrouted.length > 0 && (
				<section className='space-y-3 rounded-xl border p-4'>
					<h2 className='font-semibold'>
						{t(prefix + 'unrouted')} · {unrouted.length}
					</h2>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'unroutedHint')}
					</p>
					{unrouted.map((group) => (
						<article key={group.id} className='rounded-lg border p-3'>
							{modelHeader(group)}
						</article>
					))}
				</section>
			)}
			{props.filters.workspace === 'byModel' &&
				vendors.map((vendor) => (
					<section key={vendor} className='space-y-4'>
						<h2 className='text-muted-foreground text-sm font-semibold'>
							{routeModelVendorLabel(vendor)}
						</h2>
						{routed
							.filter((group) => group.vendor === vendor)
							.map((group) => (
								<section
									key={group.id}
									className='min-w-0 space-y-3 rounded-xl border p-4'
								>
									{modelHeader(group)}
									<div
										className={
											props.filters.view === 'summary'
												? 'grid min-w-0 gap-3 lg:grid-cols-2'
												: 'space-y-3'
										}
									>
										{group.pools.map((pool) => poolCard(pool, group))}
									</div>
								</section>
							))}
					</section>
				))}
			{props.filters.workspace === 'overview' &&
				surfaces.map((surface) => (
					<section key={surface} className='space-y-3'>
						<h2 className='font-semibold break-all'>
							{t(prefix + 'requestSurface')}: {surface}
						</h2>
						{routed.flatMap((group) =>
							group.pools
								.filter(
									(pool) =>
										`${pool.surface.request_protocol}.${pool.surface.request_operation}` ===
										surface
								)
								.map((pool) => (
									<div key={pool.key} className='space-y-2'>
										{modelHeader(group)}
										{poolCard(pool, group)}
									</div>
								))
						)}
					</section>
				))}
		</div>
	)
}
