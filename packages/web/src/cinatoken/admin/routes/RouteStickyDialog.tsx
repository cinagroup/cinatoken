/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
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
import { Input } from '../../../components/ui/input'
import type { RoutePoolView } from './route-domain'
import { routeErrorKey } from './route-errors'
import { isRouteProtocol } from './route-options'
import type { RoutesRequestOptions } from './routes-api'
import type { RoutePoolPolicyPatch } from './routes-contracts'
import type { RoutesUiApi } from './use-routes-manager'

const prefix = 'cinatoken.adminRoutes.'

export function RouteStickyDialog(props: {
	api: RoutesUiApi
	readOptions: (signal: AbortSignal) => RoutesRequestOptions
	queryPrefix: readonly unknown[]
	pool: RoutePoolView
	disabled: boolean
	pending: boolean
	error: unknown
	onSave: (patch: RoutePoolPolicyPatch) => void
	onClear: (hash: string) => void
	onReset: () => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const confirmTitle = useRef<HTMLHeadingElement>(null)
	const [enabled, setEnabled] = useState(props.pool.stickyEnabled)
	const [ttl, setTtl] = useState(String(props.pool.stickyIdleTtlSeconds))
	const [lookupText, setLookupText] = useState('')
	const [lookupValue, setLookupValue] = useState('')
	const [lookupAttempt, setLookupAttempt] = useState(0)
	const [confirm, setConfirm] = useState<
		| {
				kind: 'clear'
				hash: string
				userId: string
				lookupValue: string
				updatedAt: number
		  }
		| { kind: 'reset'; updatedAt: number }
		| null
	>(null)
	const poolId = props.pool.id
	const summary = useQuery({
		queryKey: [...props.queryPrefix, 'sticky', 'summary', poolId],
		queryFn: ({ signal }) =>
			props.api.stickyBindingsSummary(poolId!, props.readOptions(signal)),
		enabled: Boolean(poolId),
		retry: false,
	})
	const lookup = useQuery({
		queryKey: [
			...props.queryPrefix,
			'sticky',
			'lookup',
			poolId,
			props.pool.key,
			props.pool.modelId,
			props.pool.group,
			props.pool.surface.request_protocol,
			props.pool.surface.request_operation,
			lookupValue,
			lookupAttempt,
		],
		queryFn: ({ signal }) =>
			props.api.lookupStickyBinding(
				poolId!,
				{
					model_id: props.pool.modelId,
					route_group: props.pool.group,
					protocol: isRouteProtocol(props.pool.surface.request_protocol)
						? props.pool.surface.request_protocol
						: 'openai',
					request_operation: props.pool.surface.request_operation,
					...(lookupValue.includes('@')
						? { email: lookupValue }
						: { user_id: lookupValue }),
				},
				props.readOptions(signal)
			),
		enabled: Boolean(
			poolId &&
			lookupValue &&
			isRouteProtocol(props.pool.surface.request_protocol) &&
			props.pool.surface.status !== 'unknown'
		),
		retry: false,
	})
	const summaryData =
		!summary.error && !summary.isFetching ? summary.data : null
	const lookupData =
		!lookup.error &&
		!lookup.isFetching &&
		lookupValue &&
		lookupText.trim() === lookupValue
			? lookup.data
			: null
	const visibleConfirm =
		confirm &&
		(confirm.kind === 'reset'
			? summaryData && summary.dataUpdatedAt === confirm.updatedAt
			: lookupData?.binding &&
				lookup.dataUpdatedAt === confirm.updatedAt &&
				lookupData.affinity_hash === confirm.hash &&
				lookupData.user_id === confirm.userId &&
				lookupValue === confirm.lookupValue)
			? confirm
			: null
	function beginLookup(): void {
		const value = lookupText.trim()
		if (!value) return
		setConfirm(null)
		setLookupValue(value)
		setLookupAttempt((current) => current + 1)
	}
	function save(): void {
		const seconds = Number(ttl)
		if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 86_400)
			return
		if (
			enabled === props.pool.stickyEnabled &&
			seconds === props.pool.stickyIdleTtlSeconds
		) {
			props.onClose()
			return
		}
		props.onSave({ sticky_routing: { enabled, idle_ttl_seconds: seconds } })
	}
	const targetNames = new Map(
		props.pool.targets.map((row) => [
			row.id,
			row.provider_name || row.provider_id,
		])
	)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				initialFocus={title}
				showCloseButton={false}
				className='max-h-[90vh] overflow-y-auto sm:max-w-2xl'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + 'sticky')}
					</DialogTitle>
					<DialogDescription>
						{props.pool.modelName} · {props.pool.surface.request_protocol}.
						{props.pool.surface.request_operation} · {props.pool.group}
					</DialogDescription>
				</DialogHeader>
				{!poolId && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'noPool')}
					</p>
				)}
				{props.error != null && (
					<p role='alert' className='text-destructive text-sm'>
						{t(routeErrorKey(props.error))}
					</p>
				)}
				<label className='flex items-center gap-2 rounded-xl border p-3 text-sm'>
					<input
						type='checkbox'
						checked={enabled}
						disabled={props.disabled || !poolId}
						onChange={(event) => setEnabled(event.target.checked)}
					/>
					{t(prefix + 'stickyEnabled')}
				</label>
				<label className='space-y-1 text-sm'>
					{t(prefix + 'stickyTtl')}
					<Input
						type='number'
						min='60'
						max='86400'
						step='1'
						value={ttl}
						disabled={props.disabled || !poolId}
						onChange={(event) => setTtl(event.target.value)}
					/>
				</label>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'stickyImpact')}
				</p>
				<section className='space-y-3 rounded-xl border p-4'>
					<div className='flex flex-wrap items-center justify-between gap-2'>
						<h3 className='font-medium'>{t(prefix + 'summary')}</h3>
						<Button
							type='button'
							size='sm'
							variant='outline'
							disabled={summary.isFetching}
							onClick={() => void summary.refetch()}
						>
							{t(prefix + 'refresh')}
						</Button>
					</div>
					{summary.isPending && (
						<p role='status' className='text-muted-foreground text-sm'>
							{t(prefix + 'loading')}
						</p>
					)}
					{summary.error != null && (
						<p role='alert' className='text-destructive text-sm'>
							{t(routeErrorKey(summary.error))}
						</p>
					)}
					{summaryData && (
						<>
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'activeBindings', {
									count: summaryData.total_active,
								})}{' '}
								·{' '}
								{t(prefix + 'staleBindings', {
									count: summaryData.stale_count,
								})}
							</p>
							<div className='space-y-2'>
								{summaryData.targets.map((row) => (
									<div
										key={row.route_target_id}
										className='bg-muted/50 flex flex-wrap items-center justify-between gap-2 rounded-lg p-2 text-sm'
									>
										<span className='min-w-0 break-all'>
											{targetNames.get(row.route_target_id) ??
												row.route_target_id}
										</span>
										<span>
											{row.active_count} · {Math.round(row.share * 100)}%
										</span>
									</div>
								))}
							</div>
						</>
					)}
				</section>
				<section className='space-y-3 rounded-xl border p-4'>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'lookupUser')}
						<Input
							value={lookupText}
							disabled={!poolId || props.pending}
							onChange={(event) => {
								setLookupText(event.target.value)
								setConfirm(null)
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault()
									beginLookup()
								}
							}}
						/>
					</label>
					<Button
						type='button'
						variant='outline'
						disabled={!poolId || !lookupText.trim() || lookup.isFetching}
						onClick={beginLookup}
					>
						{t(prefix + 'lookup')}
					</Button>
					{lookup.error != null && (
						<p role='alert' className='text-destructive text-sm'>
							{t(routeErrorKey(lookup.error))}
						</p>
					)}
					{lookupData && (
						<div className='bg-muted/50 space-y-2 rounded-lg p-3 text-sm'>
							<p className='break-all'>{lookupData.user_id}</p>
							{lookupData.binding ? (
								<>
									<p>
										{targetNames.get(lookupData.binding.route_target_id) ??
											lookupData.binding.route_target_id}
									</p>
									<p>
										{t(prefix + 'remaining', {
											seconds: lookupData.binding.remaining_seconds,
										})}
									</p>
									<Button
										type='button'
										variant='destructive'
										size='sm'
										disabled={props.disabled}
										onClick={() =>
											setConfirm({
												kind: 'clear',
												hash: lookupData.affinity_hash,
												userId: lookupData.user_id,
												lookupValue,
												updatedAt: lookup.dataUpdatedAt,
											})
										}
									>
										{t(prefix + 'clearBinding')}
									</Button>
								</>
							) : (
								<p>{t(prefix + 'noBinding')}</p>
							)}
						</div>
					)}
				</section>
				<div className='rounded-xl border p-4'>
					<Button
						type='button'
						variant='destructive'
						disabled={props.disabled || !poolId || !summaryData}
						onClick={() =>
							setConfirm({ kind: 'reset', updatedAt: summary.dataUpdatedAt })
						}
					>
						{t(prefix + 'resetBindings')}
					</Button>
				</div>
				{visibleConfirm && (
					<Dialog
						open
						onOpenChange={(open) => {
							if (!open) setConfirm(null)
						}}
					>
						<DialogContent initialFocus={confirmTitle} showCloseButton={false}>
							<DialogHeader>
								<DialogTitle ref={confirmTitle} tabIndex={-1}>
									{t(
										prefix +
											(visibleConfirm.kind === 'reset'
												? 'resetBindings'
												: 'clearBinding')
									)}
								</DialogTitle>
								<DialogDescription>
									{t(
										prefix +
											(visibleConfirm.kind === 'reset'
												? 'resetConfirm'
												: 'clearConfirm')
									)}
								</DialogDescription>
							</DialogHeader>
							<div className='flex gap-2'>
								<Button
									type='button'
									variant='outline'
									onClick={() => setConfirm(null)}
								>
									{t(prefix + 'cancel')}
								</Button>
								<Button
									type='button'
									variant='destructive'
									disabled={
										props.disabled ||
										(visibleConfirm.kind === 'reset'
											? !summaryData
											: !lookupData?.binding ||
												lookupData.affinity_hash !== visibleConfirm.hash ||
												lookupData.user_id !== visibleConfirm.userId ||
												lookupValue !== visibleConfirm.lookupValue)
									}
									onClick={() => {
										if (visibleConfirm.kind === 'reset' && summaryData)
											props.onReset()
										else if (
											visibleConfirm.kind === 'clear' &&
											lookupData?.binding &&
											lookupData.affinity_hash === visibleConfirm.hash &&
											lookupData.user_id === visibleConfirm.userId &&
											lookupValue === visibleConfirm.lookupValue
										)
											props.onClear(visibleConfirm.hash)
										setConfirm(null)
									}}
								>
									{t(prefix + 'confirm')}
								</Button>
							</div>
						</DialogContent>
					</Dialog>
				)}
				<DialogFooter>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
					<Button
						type='button'
						disabled={
							props.disabled ||
							!poolId ||
							props.pending ||
							!Number.isSafeInteger(Number(ttl)) ||
							Number(ttl) < 60 ||
							Number(ttl) > 86_400 ||
							props.error != null
						}
						onClick={save}
					>
						{t(prefix + 'save')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
