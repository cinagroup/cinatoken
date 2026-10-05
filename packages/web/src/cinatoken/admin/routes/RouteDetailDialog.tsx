/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { parseRouteSurfaces } from './route-domain'
import { routeErrorKey } from './route-errors'
import { routePriceSummary } from './route-workspace-domain'
import type { RoutesRequestOptions } from './routes-api'
import type { AdminRoute } from './routes-contracts'
import type { RoutesUiApi } from './use-routes-manager'

const prefix = 'cinatoken.adminRoutes.'

export function RouteDetailDialog(props: {
	api: RoutesUiApi
	readOptions: (signal: AbortSignal) => RoutesRequestOptions
	queryPrefix: readonly unknown[]
	row: AdminRoute
	timezone: string | null
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	function storedValue(value: string | null | undefined): string {
		if (value === undefined) return t(prefix + 'unknown')
		if (value === null) return t(prefix + 'notConfigured')
		return value
	}
	const detail = useQuery({
		queryKey: [...props.queryPrefix, 'detail', props.row.id],
		queryFn: ({ signal }) =>
			props.api.route(props.row.id, props.readOptions(signal)),
		staleTime: 0,
		refetchOnMount: 'always',
		retry: false,
	})
	const row = !detail.error && !detail.isFetching ? detail.data : null
	const changed =
		row &&
		(row.model_id !== props.row.model_id ||
			row.provider_id !== props.row.provider_id ||
			row.provider_model_name !== props.row.provider_model_name ||
			row.priority !== props.row.priority ||
			(row.weight !== undefined && row.weight !== props.row.weight) ||
			row.price_override !== props.row.price_override ||
			row.custom_params !== props.row.custom_params ||
			(row.routing_metadata !== undefined &&
				row.routing_metadata !== props.row.routing_metadata) ||
			(row.route_pool_id !== undefined &&
				row.route_pool_id !== props.row.route_pool_id) ||
			row.status !== props.row.status ||
			(row.route_group != null && row.route_group !== props.row.route_group) ||
			row.upstream_protocol !== props.row.upstream_protocol ||
			(row.upstream_operation != null &&
				row.upstream_operation !== props.row.upstream_operation) ||
			(row.adapter != null && row.adapter !== props.row.adapter))
	const price = row
		? routePriceSummary(
				{ ...props.row, price_override: row.price_override },
				props.timezone
			)
		: null
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'detail')}
					</DialogTitle>
					<DialogDescription className='break-all'>
						{props.row.id}
					</DialogDescription>
				</DialogHeader>
				{detail.isPending && (
					<p role='status' className='text-muted-foreground text-sm'>
						{t(prefix + 'loading')}
					</p>
				)}
				{detail.error != null && (
					<p role='alert' className='text-destructive text-sm'>
						{t(routeErrorKey(detail.error))}
					</p>
				)}
				{changed && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'staleDetail')}
					</p>
				)}
				{row && !changed && (
					<dl className='grid gap-x-4 gap-y-2 text-sm sm:grid-cols-2'>
						<dt className='text-muted-foreground'>{t(prefix + 'model')}</dt>
						<dd className='min-w-0 break-all'>
							{props.row.model_name || row.model_id}
						</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'provider')}</dt>
						<dd className='min-w-0 break-all'>
							{props.row.provider_name || row.provider_id}
						</dd>
						<dt className='text-muted-foreground'>
							{t(prefix + 'providerModelName')}
						</dt>
						<dd className='min-w-0 break-all'>{row.provider_model_name}</dd>
						<dt className='text-muted-foreground'>
							{t(prefix + 'routeGroup')}
						</dt>
						<dd>{row.route_group || props.row.route_group}</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'priority')}</dt>
						<dd>{row.priority}</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'weight')}</dt>
						<dd>{row.weight ?? props.row.weight}</dd>
						<dt className='text-muted-foreground'>
							{t(prefix + 'requestSurface')}
						</dt>
						<dd>
							{parseRouteSurfaces(props.row).map((surface) => (
								<p
									key={
										surface.id ??
										surface.request_protocol + '.' + surface.request_operation
									}
									className='break-all'
								>
									{surface.request_protocol}.{surface.request_operation} ·{' '}
									{surface.status === 'unknown'
										? t(prefix + 'legacySurface')
										: surface.status}
								</p>
							))}
						</dd>
						<dt className='text-muted-foreground'>
							{t(prefix + 'upstreamProtocol')}
						</dt>
						<dd>
							{row.upstream_protocol}.
							{row.upstream_operation || props.row.upstream_operation}
						</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'adapter')}</dt>
						<dd>{row.adapter || props.row.adapter}</dd>
						<dt className='text-muted-foreground'>
							{t(prefix + 'statusFilter')}
						</dt>
						<dd>
							{t(
								prefix +
									(['active', 'inactive'].includes(row.status)
										? row.status
										: 'unknown')
							)}
						</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'pricing')}</dt>
						<dd>
							{price
								? t(prefix + 'effectiveFactors', {
										charged: price.charged,
										metered: price.metered,
									})
								: t(prefix + 'pricingUnknown')}
						</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'pool')}</dt>
						<dd className='break-all'>
							{row.route_pool_id ?? t(prefix + 'unknown')}
						</dd>
						<dt className='text-muted-foreground'>{t(prefix + 'createdAt')}</dt>
						<dd>{row.created_at ?? t(prefix + 'unknown')}</dd>
					</dl>
				)}
				{row && !changed && (
					<div className='space-y-2'>
						{[
							{ key: 'storedPricing', value: row.price_override },
							{ key: 'customParams', value: row.custom_params },
							{ key: 'routingMetadata', value: row.routing_metadata },
						].map((field) => (
							<details
								key={field.key}
								className='min-w-0 rounded-lg border p-3'
							>
								<summary className='cursor-pointer text-sm'>
									{t(prefix + field.key)}
								</summary>
								<pre className='mt-2 max-h-48 overflow-auto text-xs break-all whitespace-pre-wrap'>
									{storedValue(field.value)}
								</pre>
							</details>
						))}
					</div>
				)}
				<DialogFooter>
					<Button type='button' variant='outline' onClick={props.onClose}>
						{t(prefix + 'close')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={detail.isFetching}
						onClick={() => void detail.refetch()}
					>
						{t(prefix + 'refresh')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
