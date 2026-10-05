/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
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
import { Textarea } from '../../../components/ui/textarea'
import type { AdminModel } from '../model-contracts'
import type { AdminProvider } from '../provider-contracts'
import { RoutePricingFields } from './RoutePricingFields'
import {
	buildRouteMutation,
	draftFromRoute,
	emptyRouteDraft,
	parseRouteSurfaces,
	routeAdapters,
	routeProtocols,
	type RouteDraft,
} from './route-domain'
import { routeErrorKey } from './route-errors'
import {
	applyDashScopePreset,
	compatibleAdaptersForDraft,
	dashScopePresets,
	reconcileRouteDraft,
	routeTopologyRequiresVerification,
	requestOperationsForModel,
	topologyAvailable,
	upstreamOperationsForProviderModel,
	type DashScopePreset,
} from './route-options'
import {
	createRouteInputSchema,
	updateRouteInputSchema,
	type AdminRoute,
	type CreateRouteInput,
	type UpdateRouteInput,
} from './routes-contracts'

const prefix = 'cinatoken.adminRoutes.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'

export function RouteEditorDialog(props: {
	row: AdminRoute | null
	initialDraft?: Partial<RouteDraft>
	duplicate: boolean
	models: AdminModel[]
	providers: AdminProvider[]
	currency: string | null
	timezone: string | null
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (
		input: CreateRouteInput | UpdateRouteInput,
		row: AdminRoute | null
	) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const [draft, setDraft] = useState<RouteDraft>(() =>
		props.row
			? draftFromRoute(props.row)
			: { ...emptyRouteDraft, ...props.initialDraft }
	)
	const [localError, setLocalError] = useState(false)
	const editing = props.row !== null && !props.duplicate
	const surfaceAmbiguous =
		editing &&
		props.row !== null &&
		(parseRouteSurfaces(props.row).length !== 1 ||
			parseRouteSurfaces(props.row)[0]?.status === 'unknown')
	const selectedProvider = props.providers.find(
		(row) => row.id === draft.providerId
	)
	const selectedModel = props.models.find((row) => row.id === draft.modelId)
	const modelOptions =
		props.models.some((row) => row.id === draft.modelId) || !draft.modelId
			? props.models
			: [
					{ id: draft.modelId, display_name: draft.modelId } as AdminModel,
					...props.models,
				]
	const providerOptions =
		props.providers.some((row) => row.id === draft.providerId) ||
		!draft.providerId
			? props.providers
			: [
					{ id: draft.providerId, name: draft.providerId } as AdminProvider,
					...props.providers,
				]
	const requestOperations = requestOperationsForModel(
		selectedModel,
		draft.requestProtocol,
		draft.providerModelName
	)
	const upstreamOperations = upstreamOperationsForProviderModel(
		selectedProvider,
		selectedModel,
		draft.upstreamProtocol,
		draft.providerModelName
	)
	const compatibleAdapters = compatibleAdaptersForDraft(draft)
	function change(patch: Partial<RouteDraft>): void {
		setLocalError(false)
		setDraft((current) => {
			const next = { ...current, ...patch }
			if (
				[
					'modelId',
					'providerId',
					'providerModelName',
					'requestProtocol',
					'requestOperation',
					'upstreamProtocol',
					'upstreamOperation',
				].some((key) => key in patch)
			)
				return reconcileRouteDraft(next, props.models, props.providers)
			return next
		})
	}
	function submit(): void {
		if (props.disabled || props.pending) return
		try {
			const topologyChanged = routeTopologyRequiresVerification(
				draft,
				props.row,
				props.duplicate
			)
			if (
				topologyChanged &&
				!topologyAvailable(draft, selectedModel, selectedProvider)
			)
				throw new Error('topology unavailable')
			if (!props.currency || !props.timezone) {
				if (
					!editing ||
					draft.chargedFactor !== draftFromRoute(props.row!).chargedFactor ||
					draft.meteredFactor !== draftFromRoute(props.row!).meteredFactor ||
					JSON.stringify(draft.schedule) !==
						JSON.stringify(draftFromRoute(props.row!).schedule)
				)
					throw new Error('context unavailable')
			}
			const payload = buildRouteMutation(
				draft,
				editing ? props.row! : undefined,
				{
					modelIds: props.models.map((row) => row.id),
					providerIds: props.providers.map((row) => row.id),
				}
			)
			if (editing) {
				if (!Object.keys(payload).length) {
					props.onClose()
					return
				}
				props.onSave(updateRouteInputSchema.parse(payload), props.row)
			} else props.onSave(createRouteInputSchema.parse(payload), null)
		} catch {
			setLocalError(true)
		}
	}
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
				className='max-h-[92vh] overflow-y-auto sm:max-w-[58rem]'
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(
							prefix +
								(editing ? 'edit' : props.duplicate ? 'duplicate' : 'create')
						)}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'createHint')}</DialogDescription>
				</DialogHeader>
				{surfaceAmbiguous && (
					<p
						role='status'
						className='text-muted-foreground rounded-lg border p-3 text-sm'
					>
						{t(prefix + 'legacySurface')}
					</p>
				)}
				{(localError || props.error != null) && (
					<p role='alert' className='text-destructive text-sm'>
						{localError
							? t(prefix + 'invalidInput')
							: t(routeErrorKey(props.error))}
					</p>
				)}
				<div className='grid gap-4 sm:grid-cols-2'>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'model')}
						<select
							className={selectClass}
							value={draft.modelId}
							disabled={props.disabled || surfaceAmbiguous}
							onChange={(event) => change({ modelId: event.target.value })}
						>
							<option value=''>{t(prefix + 'allModels')}</option>
							{modelOptions.map((row) => (
								<option key={row.id} value={row.id}>
									{row.display_name || row.id}
								</option>
							))}
						</select>
					</label>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'provider')}
						<select
							className={selectClass}
							value={draft.providerId}
							disabled={props.disabled}
							onChange={(event) => change({ providerId: event.target.value })}
						>
							<option value=''>{t(prefix + 'allProviders')}</option>
							{providerOptions.map((row) => (
								<option key={row.id} value={row.id}>
									{row.name}
								</option>
							))}
						</select>
					</label>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'providerModelName')}
						<Input
							value={draft.providerModelName}
							disabled={props.disabled}
							onChange={(event) =>
								change({ providerModelName: event.target.value })
							}
						/>
					</label>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'routeGroup')}
						<Input
							value={draft.group}
							disabled={props.disabled || surfaceAmbiguous}
							onChange={(event) => change({ group: event.target.value })}
						/>
					</label>
				</div>
				{selectedProvider?.endpointsState !== 'available' &&
					selectedProvider && (
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'providerConfigUnknown')}
						</p>
					)}
				<section className='space-y-3 rounded-xl border p-4'>
					<h3 className='font-medium'>{t(prefix + 'requestSurface')}</h3>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'operationsHint')}
					</p>
					<fieldset className='space-y-2'>
						<legend className='text-sm font-medium'>
							{t(prefix + 'presets')}
						</legend>
						<div className='flex flex-wrap gap-2'>
							{(Object.keys(dashScopePresets) as DashScopePreset[]).map(
								(preset) => (
									<Button
										key={preset}
										type='button'
										variant='outline'
										size='sm'
										disabled={
											props.disabled ||
											surfaceAmbiguous ||
											!topologyAvailable(
												applyDashScopePreset(draft, preset),
												selectedModel,
												selectedProvider
											)
										}
										onClick={() => {
											setLocalError(false)
											setDraft(applyDashScopePreset(draft, preset))
										}}
									>
										{t(prefix + 'preset-' + preset)}
									</Button>
								)
							)}
						</div>
					</fieldset>
					<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-3'>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'requestProtocol')}
							<select
								className={selectClass}
								value={draft.requestProtocol}
								disabled={props.disabled || surfaceAmbiguous}
								onChange={(event) =>
									change({
										requestProtocol: event.target.value,
									})
								}
							>
								{routeProtocols.map((item) => (
									<option
										key={item}
										disabled={
											!requestOperationsForModel(
												selectedModel,
												item,
												draft.providerModelName
											).length
										}
									>
										{item}
									</option>
								))}
							</select>
						</label>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'requestOperation')}
							<select
								className={selectClass}
								value={draft.requestOperation}
								disabled={props.disabled || surfaceAmbiguous}
								onChange={(event) =>
									change({ requestOperation: event.target.value })
								}
							>
								{draft.requestOperation &&
									!requestOperations.includes(draft.requestOperation) && (
										<option value={draft.requestOperation} disabled>
											{draft.requestOperation} · {t(prefix + 'legacyOperation')}
										</option>
									)}
								{requestOperations.map((item) => (
									<option key={item}>{item}</option>
								))}
							</select>
						</label>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'upstreamProtocol')}
							<select
								className={selectClass}
								value={draft.upstreamProtocol}
								disabled={props.disabled || surfaceAmbiguous}
								onChange={(event) =>
									change({
										upstreamProtocol: event.target.value,
									})
								}
							>
								{routeProtocols.map((item) => (
									<option
										key={item}
										disabled={
											!upstreamOperationsForProviderModel(
												selectedProvider,
												selectedModel,
												item,
												draft.providerModelName
											).length
										}
									>
										{item}
									</option>
								))}
							</select>
						</label>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'upstreamOperation')}
							<select
								className={selectClass}
								value={draft.upstreamOperation}
								disabled={props.disabled || surfaceAmbiguous}
								onChange={(event) =>
									change({ upstreamOperation: event.target.value })
								}
							>
								{draft.upstreamOperation &&
									!upstreamOperations.includes(draft.upstreamOperation) && (
										<option value={draft.upstreamOperation} disabled>
											{draft.upstreamOperation} ·{' '}
											{t(prefix + 'legacyOperation')}
										</option>
									)}
								{upstreamOperations.map((item) => (
									<option key={item}>{item}</option>
								))}
							</select>
						</label>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'adapter')}
							<select
								className={selectClass}
								value={draft.adapter}
								disabled={props.disabled || surfaceAmbiguous}
								onChange={(event) => change({ adapter: event.target.value })}
							>
								{routeAdapters.map((item) => (
									<option
										key={item}
										value={item}
										disabled={!compatibleAdapters.includes(item)}
									>
										{item}
									</option>
								))}
							</select>
						</label>
					</div>
				</section>
				<div className='grid gap-3 sm:grid-cols-2'>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'priority')}
						<Input
							type='number'
							step='1'
							value={draft.priority}
							disabled={props.disabled}
							onChange={(event) => change({ priority: event.target.value })}
						/>
					</label>
					<label className='space-y-1 text-sm'>
						{t(prefix + 'weight')}
						<Input
							type='number'
							min='1'
							step='1'
							value={draft.weight}
							disabled={props.disabled}
							onChange={(event) => change({ weight: event.target.value })}
						/>
					</label>
				</div>
				<RoutePricingFields
					draft={draft}
					onChange={setDraft}
					currency={props.currency}
					timezone={props.timezone}
					disabled={props.disabled}
				/>
				<details className='rounded-xl border p-4'>
					<summary className='cursor-pointer font-medium'>
						{t(prefix + 'advanced')}
					</summary>
					<div className='mt-3 grid gap-3 sm:grid-cols-2'>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'customParams')}
							<Textarea
								value={draft.customParams}
								disabled={props.disabled}
								onChange={(event) =>
									change({ customParams: event.target.value })
								}
							/>
						</label>
						<label className='space-y-1 text-sm'>
							{t(prefix + 'routingMetadata')}
							<Textarea
								value={draft.routingMetadata}
								disabled={props.disabled}
								onChange={(event) =>
									change({ routingMetadata: event.target.value })
								}
							/>
						</label>
					</div>
				</details>
				<DialogFooter>
					<Button
						type='button'
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'cancel')}
					</Button>
					<Button
						type='button'
						disabled={props.disabled || props.pending || props.error != null}
						onClick={submit}
					>
						{t(prefix + 'save')}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
