/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import type { RouteRow } from './route-domain'
import { routePriceSummary } from './route-workspace-domain'
import type { StickyBindingsSummary } from './routes-contracts'

const prefix = 'cinatoken.adminRoutes.'
export type RouteTargetAction =
	'detail' | 'edit' | 'duplicate' | 'delete' | 'activate' | 'deactivate'
export function RouteTargetCard(props: {
	row: RouteRow
	disabled: boolean
	timezone: string | null
	summary: StickyBindingsSummary | null | undefined
	onAction: (action: RouteTargetAction, row: RouteRow) => void
}) {
	const { t } = useTranslation()
	const price = routePriceSummary(props.row, props.timezone)
	const sticky = props.summary?.targets.find(
		(target) => target.route_target_id === props.row.id
	)
	return (
		<article className='bg-muted/20 min-w-0 space-y-3 rounded-lg border p-3'>
			<div className='flex flex-wrap items-start justify-between gap-2'>
				<div className='min-w-0'>
					<p className='text-sm font-medium break-words'>
						{props.row.provider_name || props.row.provider_id} →{' '}
						{props.row.provider_model_name}
					</p>
					<p className='text-muted-foreground text-xs break-all'>
						{props.row.upstream_protocol}.{props.row.upstream_operation} ·{' '}
						{props.row.adapter} · {t(prefix + 'weight')} {props.row.weight}
					</p>
				</div>
				<span className='rounded-full border px-2 py-1 text-xs'>
					{t(
						prefix +
							(['active', 'inactive'].includes(props.row.status)
								? props.row.status
								: 'unknown')
					)}
				</span>
			</div>
			{props.row.provider_status && props.row.provider_status !== 'active' && (
				<p className='text-destructive text-xs'>
					{t(prefix + 'providerDisabled')}
				</p>
			)}
			{props.row.custom_params && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'customConfigured')}
				</p>
			)}
			{price ? (
				<div className='text-muted-foreground space-y-1 text-xs'>
					<p>
						{t(prefix + 'effectiveFactors', {
							charged: price.charged,
							metered: price.metered,
						})}
					</p>
					{price.inverted && (
						<p className='text-destructive'>{t(prefix + 'priceInversion')}</p>
					)}
					{price.scheduled && (
						<details>
							<summary className='cursor-pointer'>
								{t(prefix + 'scheduleWindows')} · {props.timezone}
							</summary>
							<ul className='mt-1 space-y-1'>
								{price.windows.map((window, index) => (
									<li key={index}>
										{t(prefix + window.side)}: {window.text}
									</li>
								))}
							</ul>
						</details>
					)}
				</div>
			) : (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'pricingUnknown')}
				</p>
			)}
			{sticky && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'stickyShare', {
						count: sticky.active_count,
						share: (sticky.share * 100).toFixed(1),
					})}
				</p>
			)}
			<div className='flex flex-wrap gap-2'>
				{(
					[
						'detail',
						'edit',
						'duplicate',
						props.row.status === 'active' ? 'deactivate' : 'activate',
						'delete',
					] as const
				).map((action) => (
					<Button
						key={action}
						type='button'
						size='sm'
						variant={action === 'delete' ? 'destructive' : 'outline'}
						disabled={action !== 'detail' && props.disabled}
						onClick={() => props.onAction(action, props.row)}
					>
						{t(
							prefix +
								({ activate: 'enable', deactivate: 'disable' }[
									action as 'activate' | 'deactivate'
								] ?? action)
						)}
					</Button>
				))}
			</div>
		</article>
	)
}
