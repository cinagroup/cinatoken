/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { ManagedModelEditor } from '../models/ManagedModelEditor'
import { RouteDetailDialog } from './RouteDetailDialog'
import { RouteEditorDialog } from './RouteEditorDialog'
import { RouteFailoverHelp } from './RouteFailoverHelp'
import { RouteFiltersPanel } from './RouteFiltersPanel'
import { RouteModelPolicyDialog } from './RouteModelPolicyDialog'
import { RoutePoolPolicyDialog } from './RoutePoolPolicyDialog'
import { RouteStickyDialog } from './RouteStickyDialog'
import type { RouteTargetAction } from './RouteTargetCard'
import { RouteWorkspace } from './RouteWorkspace'
import {
	buildRoutePools,
	emptyRouteFilters,
	modelPolicyPatch,
	modelPolicyStrategy,
	validateRouteFilters,
	type RouteFilters,
	type RoutePoolView,
	type RouteDraft,
	emptyRouteDraft,
} from './route-domain'
import { RouteInputError, routeErrorKey } from './route-errors'
import { buildRouteWorkspace } from './route-workspace-domain'
import type {
	AdminRoute,
	CreateRouteInput,
	RoutePoolPolicyPatch,
	UpdateRouteInput,
} from './routes-contracts'
import {
	routeErrorObserver,
	useRoutesManager,
	type RoutesManagerProps,
} from './use-routes-manager'
import {
	useStickySummaries,
	type StickyRefreshInterval,
} from './use-sticky-summaries'

const prefix = 'cinatoken.adminRoutes.'
const selectClass = 'bg-background h-10 min-w-0 rounded-md border px-3 text-sm'

export type AdminRoutesProps = RoutesManagerProps & {
	initialFilters?: Partial<RouteFilters>
	onFiltersChange?: (filters: RouteFilters) => void
}

export function AdminRoutes(props: AdminRoutesProps) {
	return (
		<AdminRoutesContent
			key={[
				props.scopeKey,
				props.reconciliationKey,
				props.subject,
				props.userId,
				props.canWrite,
			].join('\0')}
			{...props}
		/>
	)
}

function AdminRoutesContent(props: AdminRoutesProps) {
	const { t } = useTranslation()
	const client = useQueryClient()
	const [localFilters, setLocalFilters] = useState<RouteFilters>(() =>
		validateRouteFilters(props.initialFilters ?? emptyRouteFilters)
	)
	const filters = props.onFiltersChange
		? validateRouteFilters(props.initialFilters)
		: localFilters
	const [pool, setPool] = useState<RoutePoolView | null>(null)
	const [initialDraft, setInitialDraft] = useState<Partial<RouteDraft>>({})
	const [editingModel, setEditingModel] = useState<string | null>(null)
	const [modelMode, setModelMode] = useState<'edit' | 'delete'>('edit')
	const clearDrafts = useCallback(() => {
		setPool(null)
		setInitialDraft({})
		setEditingModel(null)
	}, [])
	const manager = useRoutesManager(props, clearDrafts)
	const targetCount = new Set(manager.rows.map((row) => row.id)).size
	const poolCount = new Set(
		manager.rows.map((row) => row.route_pool_id ?? row.id)
	).size
	const modelOptions = useMemo(
		() =>
			!manager.hidden && !manager.models.error && !manager.models.isFetching
				? (manager.models.data ?? [])
				: [],
		[
			manager.hidden,
			manager.models.error,
			manager.models.isFetching,
			manager.models.data,
		]
	)
	const providerOptions = useMemo(
		() =>
			!manager.hidden &&
			!manager.providers.error &&
			!manager.providers.isFetching
				? (manager.providers.data ?? [])
				: [],
		[
			manager.hidden,
			manager.providers.error,
			manager.providers.isFetching,
			manager.providers.data,
		]
	)
	const verifiedContext =
		!manager.hidden && !manager.context.error && !manager.context.isFetching
			? manager.context.data
			: null
	const pools = useMemo(
		() =>
			buildRoutePools(
				manager.rows.map((row) => ({
					...row,
					provider_status:
						row.provider_status ??
						providerOptions.find((provider) => provider.id === row.provider_id)
							?.status,
				}))
			),
		[manager.rows, providerOptions]
	)
	const groups = [...new Set(pools.map((item) => item.group))].sort()
	useEffect(
		() =>
			routeErrorObserver(client.getQueryCache(), manager.prefix, () => {
				setEditingModel(null)
				setPool(null)
				setInitialDraft({})
			}),
		[client, manager.prefix]
	)
	const modelCount = new Set([
		...manager.rows.map((row) => row.model_id),
		...modelOptions.map((model) => model.id),
	]).size
	const workspace = useMemo(
		() => buildRouteWorkspace(modelOptions, pools, filters),
		[modelOptions, pools, filters]
	)
	const shown = workspace.flatMap((group) => group.pools)
	const sticky = useStickySummaries({
		api: props.api,
		prefix: manager.prefix,
		pools: shown,
		enabled: !manager.hidden && !manager.list.error,
		readOptions: manager.readOptions,
	})
	function clearFilters(): void {
		if (props.onFiltersChange) props.onFiltersChange({ ...emptyRouteFilters })
		else setLocalFilters({ ...emptyRouteFilters })
	}
	function createTarget(modelId: string, pool?: RoutePoolView): void {
		setInitialDraft({
			...emptyRouteDraft,
			modelId,
			...(pool
				? {
						group: pool.group,
						requestProtocol: pool.surface.request_protocol,
						requestOperation: pool.surface.request_operation,
					}
				: {}),
			...(filters.provider_id ? { providerId: filters.provider_id } : {}),
		})
		manager.open('editor')
	}
	function targetAction(action: RouteTargetAction, row: AdminRoute): void {
		if (action === 'detail') manager.open('detail', row)
		else if (action === 'edit' || action === 'duplicate')
			manager.open('editor', row, undefined, action === 'duplicate')
		else manager.open('confirm', row, action)
	}
	function change(patch: Partial<RouteFilters>): void {
		const next = validateRouteFilters({ ...filters, ...patch })
		if (props.onFiltersChange) props.onFiltersChange(next)
		else setLocalFilters(next)
	}
	function openPool(
		next: 'policy' | 'sticky' | 'modelPolicy',
		item: RoutePoolView
	): void {
		const targets = item.id
			? manager.rows.filter((row) => row.route_pool_id === item.id)
			: item.targets
		setPool({ ...item, targets })
		manager.open(next)
	}
	function saveRoute(
		input: CreateRouteInput | UpdateRouteInput,
		row: AdminRoute | null
	): void {
		manager.queue({
			close: true,
			authority: { kind: 'routes' },
			run: async (signal) => {
				if (row)
					await props.api.updateRoute(
						row.id,
						input as UpdateRouteInput,
						manager.writeOptions(signal)
					)
				else
					await props.api.createRoute(
						input as CreateRouteInput,
						manager.writeOptions(signal)
					)
			},
		})
	}
	function savePoolPolicy(patch: RoutePoolPolicyPatch): void {
		if (!pool?.id) return
		manager.queue({
			close: true,
			authority: { kind: 'routes' },
			run: (signal) =>
				props.api.patchRoutePoolPolicy(
					pool.id!,
					patch,
					manager.writeOptions(signal)
				),
		})
	}
	function saveModelPolicy(
		protocol: string | null,
		operation: string | null,
		expectedPolicy: string | null
	): void {
		if (!pool) return
		const currentPool = pool
		const selection = {
			protocol: currentPool.surface.request_protocol,
			group: currentPool.group,
			operation: null,
		}
		const sameProtocol =
			modelPolicyStrategy(expectedPolicy, selection) === protocol
		const sameOperation =
			currentPool.surface.request_operation === '*' ||
			modelPolicyStrategy(expectedPolicy, {
				...selection,
				operation: currentPool.surface.request_operation,
			}) === operation
		if (sameProtocol && sameOperation) {
			manager.close()
			return
		}
		manager.queue({
			close: true,
			authority: { kind: 'model', id: currentPool.modelId },
			run: async (signal) => {
				let policy = expectedPolicy
				try {
					policy = modelPolicyPatch(
						policy,
						{
							protocol: currentPool.surface.request_protocol,
							operation: null,
							group: currentPool.group,
						},
						protocol
					)
					if (currentPool.surface.request_operation !== '*')
						policy = modelPolicyPatch(
							policy,
							{
								protocol: currentPool.surface.request_protocol,
								operation: currentPool.surface.request_operation,
								group: currentPool.group,
							},
							operation
						)
				} catch {
					throw new RouteInputError('Model policy cannot be edited')
				}
				if (policy !== expectedPolicy)
					await props.api.updateModel(
						currentPool.modelId,
						{ route_policy: policy, expected_route_policy: expectedPolicy },
						manager.writeOptions(signal, 'models')
					)
			},
		})
	}
	function confirm(): void {
		const row = manager.selected
		if (!row || !manager.action) return
		const action = manager.action
		manager.queue({
			close: true,
			authority: { kind: 'routes' },
			run: async (signal) => {
				if (action === 'delete')
					await props.api.deleteRoute(row.id, manager.writeOptions(signal))
				else if (action === 'activate' || action === 'deactivate')
					await props.api.updateRoute(
						row.id,
						{ status: action === 'activate' ? 'active' : 'inactive' },
						manager.writeOptions(signal)
					)
			},
		})
	}
	const noResults =
		!filters.invalid &&
		workspace.length === 0 &&
		(manager.rows.length > 0 || modelOptions.length > 0)
	return (
		<div className='mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6'>
			<header className='flex flex-wrap items-start justify-between gap-4'>
				<div className='space-y-1'>
					<h1 className='text-2xl font-semibold tracking-tight'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground max-w-2xl text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						type='button'
						variant='outline'
						disabled={manager.list.isFetching}
						onClick={() => void manager.retry()}
					>
						{t(prefix + 'refresh')}
					</Button>
					<Button
						type='button'
						disabled={
							manager.disabled ||
							!verifiedContext ||
							Boolean(manager.models.error || manager.providers.error)
						}
						onClick={() => createTarget(filters.model)}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</header>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'consoleHint')}
			</p>
			{!props.canWrite && (
				<p role='status' className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'readonly')}
				</p>
			)}
			{manager.writeUnconfirmed && (
				<p
					role='alert'
					className='border-destructive text-destructive rounded-lg border p-3 text-sm'
				>
					{t(prefix + 'writeUnknown')}
				</p>
			)}
			{manager.notice && (
				<p role='status' className='rounded-lg border p-3 text-sm'>
					{t(prefix + 'saved')}
				</p>
			)}
			{manager.hidden && (
				<p
					role='alert'
					className='border-destructive text-destructive rounded-lg border p-4 text-sm'
				>
					{t(routeErrorKey(manager.list.error))}
				</p>
			)}
			{!manager.hidden && manager.list.error != null && (
				<p
					role='alert'
					className='border-destructive text-destructive rounded-lg border p-4 text-sm'
				>
					{t(routeErrorKey(manager.list.error))}
				</p>
			)}
			{!manager.hidden &&
				(manager.models.error ||
					manager.providers.error ||
					manager.context.error) && (
					<p role='status' className='rounded-lg border p-3 text-sm'>
						{t(prefix + 'contextUnknown')}
					</p>
				)}
			<div className='grid gap-3 rounded-xl border p-4 sm:grid-cols-3'>
				<div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'globalStrategy')}
					</p>
					<p className='font-medium'>
						{verifiedContext?.global_route_strategy ?? t(prefix + 'unknown')}
					</p>
				</div>
				<div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'billingCurrency')}
					</p>
					<p className='font-medium'>
						{verifiedContext?.billing_currency ?? t(prefix + 'unknown')}
					</p>
				</div>
				<div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'businessTimezone')}
					</p>
					<p className='font-medium'>
						{verifiedContext?.business_timezone ?? t(prefix + 'unknown')}
					</p>
				</div>
			</div>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'count', {
					models: modelCount,
					pools: poolCount,
					targets: targetCount,
				})}
			</p>
			<RouteFiltersPanel
				filters={filters}
				models={modelOptions}
				providers={providerOptions}
				groups={groups}
				onChange={change}
				onClear={clearFilters}
			/>
			<div className='flex flex-wrap items-center gap-3 rounded-xl border p-3'>
				<label className='text-sm'>
					{t(prefix + 'stickyRefresh')}{' '}
					<select
						className={selectClass}
						value={sticky.interval}
						onChange={(event) =>
							sticky.setInterval(
								Number(event.target.value) as StickyRefreshInterval
							)
						}
					>
						{([0, 60000, 300000, 600000] as const).map((value) => (
							<option key={value} value={value}>
								{t(
									prefix +
										{
											0: 'refreshOff',
											60000: 'refresh1',
											300000: 'refresh5',
											600000: 'refresh10',
										}[value]
								)}
							</option>
						))}
					</select>
				</label>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={manager.hidden || sticky.fetching || !sticky.visible}
					onClick={() => void sticky.refresh()}
				>
					{t(prefix + 'refreshAllSticky')}
				</Button>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'refreshPaused')}
				</p>
			</div>
			{!manager.hidden && manager.list.isPending && (
				<p
					role='status'
					className='text-muted-foreground rounded-xl border p-6 text-sm'
				>
					{t(prefix + 'loading')}
				</p>
			)}
			{!manager.hidden &&
				!manager.list.isPending &&
				!manager.list.error &&
				manager.rows.length === 0 &&
				modelOptions.length === 0 &&
				!filters.invalid && (
					<p className='text-muted-foreground rounded-xl border p-6 text-sm'>
						{t(prefix + 'empty')}
					</p>
				)}
			{!manager.hidden && !manager.list.isPending && noResults && (
				<p className='text-muted-foreground rounded-xl border p-6 text-sm'>
					{t(prefix + 'noMatches')}
				</p>
			)}
			{!manager.hidden && !manager.list.error && workspace.length > 0 && (
				<RouteWorkspace
					groups={workspace}
					filters={filters}
					disabled={manager.disabled || !verifiedContext}
					globalStrategy={verifiedContext?.global_route_strategy ?? null}
					contextVerified={Boolean(verifiedContext)}
					timezone={verifiedContext?.business_timezone ?? null}
					summaries={sticky.summaries}
					onPool={openPool}
					onTarget={targetAction}
					onCreate={createTarget}
					onEditModel={(id, mode) => {
						setModelMode(mode)
						setEditingModel(id)
					}}
				/>
			)}
			<RouteFailoverHelp />
			<AdminDomainRecoveryDialog recovery={manager.manualRecovery} />
			<AdminDomainRecoveryDialog
				recovery={manager.modelManualRecovery}
				busy={Boolean(editingModel)}
			/>
			{editingModel && !manager.hidden && !manager.readError && (
				<ManagedModelEditor
					{...props}
					subject={manager.subject ?? undefined}
					userId={manager.userId ?? undefined}
					id={editingModel}
					mode={modelMode}
					// Temporary locks must not revoke this editor's own dispatched write.
					canWrite={props.canWrite}
					writeBlocked={manager.disabled}
					onClose={() => setEditingModel(null)}
					onSaved={() => {
						void manager.retry()
						setEditingModel(null)
					}}
				/>
			)}
			{manager.panel === 'editor' && (
				<RouteEditorDialog
					key={manager.selected?.id ?? 'new'}
					row={manager.selected}
					initialDraft={initialDraft}
					duplicate={manager.duplicating}
					models={modelOptions}
					providers={providerOptions}
					currency={verifiedContext?.billing_currency ?? null}
					timezone={verifiedContext?.business_timezone ?? null}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onSave={saveRoute}
					onClose={manager.close}
				/>
			)}
			{manager.panel === 'detail' && manager.selected && (
				<RouteDetailDialog
					api={props.api}
					timezone={verifiedContext?.business_timezone ?? null}
					readOptions={manager.readOptions}
					queryPrefix={manager.prefix}
					row={manager.selected}
					onClose={manager.close}
				/>
			)}
			{manager.panel === 'policy' && pool && (
				<RoutePoolPolicyDialog
					pool={pool}
					disabled={manager.disabled}
					pending={manager.mutation.isPending}
					error={manager.mutation.error}
					onSave={savePoolPolicy}
					onClose={manager.close}
				/>
			)}
			{manager.panel === 'modelPolicy' && pool && (
				<RouteModelPolicyDialog
					pool={pool}
					model={modelOptions.find((row) => row.id === pool.modelId) ?? null}
					disabled={manager.disabled}
					pending={manager.mutation.isPending}
					error={manager.mutation.error}
					onSave={saveModelPolicy}
					onClose={manager.close}
				/>
			)}
			{manager.panel === 'sticky' && pool && (
				<RouteStickyDialog
					api={props.api}
					readOptions={manager.readOptions}
					queryPrefix={manager.prefix}
					pool={pool}
					disabled={manager.disabled}
					pending={manager.mutation.isPending}
					error={manager.mutation.error}
					onSave={savePoolPolicy}
					onClear={(hash) => {
						if (pool.id)
							manager.queue({
								authority: { kind: 'sticky', poolId: pool.id },
								run: async (signal) => {
									await props.api.clearStickyBinding(
										pool.id!,
										hash,
										manager.writeOptions(signal)
									)
								},
							})
					}}
					onReset={() => {
						if (pool.id)
							manager.queue({
								authority: { kind: 'sticky', poolId: pool.id },
								run: async (signal) => {
									await props.api.resetStickyBindings(
										pool.id!,
										manager.writeOptions(signal)
									)
								},
							})
					}}
					onClose={manager.close}
				/>
			)}
			{manager.panel === 'confirm' && manager.selected && (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) manager.close()
					}}
				>
					<DialogContent showCloseButton={false}>
						<DialogHeader>
							<DialogTitle>
								{t(
									prefix +
										(manager.action === 'delete'
											? 'delete'
											: manager.action === 'activate'
												? 'enable'
												: 'disable')
								)}
							</DialogTitle>
							<DialogDescription>
								{t(
									prefix +
										(manager.action === 'delete'
											? 'deleteConfirm'
											: 'statusConfirm'),
									{ id: manager.selected.id }
								)}
							</DialogDescription>
						</DialogHeader>
						{manager.mutation.error != null && (
							<p role='alert' className='text-destructive text-sm'>
								{t(routeErrorKey(manager.mutation.error))}
							</p>
						)}
						<DialogFooter>
							<Button
								type='button'
								variant='outline'
								disabled={manager.mutation.isPending}
								onClick={manager.close}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button
								type='button'
								variant={
									manager.action === 'delete' ? 'destructive' : 'default'
								}
								disabled={manager.disabled || manager.mutation.error != null}
								onClick={confirm}
							>
								{t(prefix + 'confirm')}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			)}
		</div>
	)
}
