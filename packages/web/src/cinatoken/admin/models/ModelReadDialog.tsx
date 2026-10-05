import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import type { AdminDomainRequestOptions } from '../domain-transport'
import type { ModelsApi } from '../model-api'
import type { AdminModel, ParsedPricingProfile } from '../model-contracts'
import type { CreateModelInput, UpdateModelInput } from '../model-input'
import { ModelEditorDialog } from './ModelEditorDialog'
import { modelErrorKey } from './model-errors'
import { TIER_PRICE_FIELDS } from './model-form'

const prefix = 'cinatoken.adminModels.'
function PricingSummary(props: {
	profile: ParsedPricingProfile | null
	billingCurrency: string | null
}) {
	const { t } = useTranslation()
	const profile = props.profile
	if (!profile) return null
	const perImage = profile.image_billing_mode === 'per_image'
	const perAudio =
		profile.audio_billing_mode === 'per_second' ||
		profile.audio_billing_mode === 'per_character'
	return (
		<section className='space-y-3'>
			<h3 className='font-semibold'>{t(prefix + 'pricing')}</h3>
			<p className='text-muted-foreground text-sm'>
				{props.billingCurrency
					? t(prefix + 'currencyCurrent', { currency: props.billingCurrency })
					: t(prefix + 'currencyUnknown')}
			</p>
			{!perImage &&
				!perAudio &&
				profile.tiers.map((tier, index) => (
					<div key={index} className='space-y-2 rounded-lg border p-3'>
						<h4 className='font-medium'>
							{t(prefix + 'tier', { number: index + 1 })} · {tier.label} ·{' '}
							{tier.upto === null ? '∞' : tier.upto}
						</h4>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'tokenUnit')}
						</p>
						<dl className='grid gap-2 sm:grid-cols-2'>
							{TIER_PRICE_FIELDS.map((field) => (
								<div key={field} className='flex justify-between gap-3'>
									<dt className='text-muted-foreground text-xs'>
										{t(prefix + field)}
									</dt>
									<dd className='text-sm tabular-nums'>{tier[field] ?? '—'}</dd>
								</div>
							))}
						</dl>
					</div>
				))}
			{perImage && profile.image && (
				<div className='space-y-3'>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'imageUnit')}
					</p>
					{[profile.image, profile.image.input].map(
						(side, index) =>
							side && (
								<div key={index} className='space-y-2 rounded-lg border p-3'>
									<h4>
										{t(
											prefix + (index === 0 ? 'imageOutput' : 'imageReference')
										)}
									</h4>
									<p>
										{t(prefix + 'defaultPrice')}: {side.default}
									</p>
									{(['by_quality', 'by_size', 'by_quality_size'] as const).map(
										(field) => (
											<div key={field}>
												{side[field] && (
													<>
														<p className='text-muted-foreground text-xs'>
															{t(prefix + field)}
														</p>
														{Object.entries(side[field]).map(([key, price]) => (
															<p key={key} className='text-sm break-words'>
																{key}: {price}
															</p>
														))}
													</>
												)}
											</div>
										)
									)}
								</div>
							)
					)}
					<p>
						{t(prefix + 'uncertainPolicy')}:{' '}
						{t(prefix + (profile.image.uncertain_result_policy ?? 'requested'))}
					</p>
				</div>
			)}
			{perAudio && profile.audio && (
				<dl className='space-y-2 rounded-lg border p-3'>
					<dt>
						{t(
							prefix +
								(profile.audio_billing_mode === 'per_second'
									? 'secondPrice'
									: 'characterPrice')
						)}
					</dt>
					<dd>
						{profile.audio.price_per_second ??
							profile.audio.price_per_character}
					</dd>
					<dt>
						{t(
							prefix +
								(profile.audio_billing_mode === 'per_second'
									? 'minimumSeconds'
									: 'minimumCharacters')
						)}
					</dt>
					<dd>
						{profile.audio.minimum_seconds ??
							profile.audio.minimum_characters ??
							(profile.audio_billing_mode === 'per_second' ? 1 : 0)}
					</dd>
				</dl>
			)}
		</section>
	)
}
export function ModelReadDialog(props: {
	api: ModelsApi
	readOptions?: (signal?: AbortSignal) => AdminDomainRequestOptions
	prefix: readonly unknown[]
	id: string
	mode: 'detail' | 'edit' | 'delete'
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (input: CreateModelInput | UpdateModelInput, id?: string) => void
	onDelete: (id: string) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const query = useQuery({
		queryKey: [...props.prefix, 'detail', props.id],
		queryFn: ({ signal }) =>
			props.api.modelContext(
				props.id,
				props.readOptions?.(signal) ?? { signal }
			),
		retry: false,
		staleTime: 0,
	})
	const row: AdminModel | undefined = query.error ? undefined : query.data?.row
	const billingCurrency = query.error
		? null
		: (query.data?.billingCurrency ?? null)
	if (props.mode === 'edit' && row && !query.isFetching)
		return (
			<ModelEditorDialog
				row={row}
				billingCurrency={billingCurrency}
				pending={props.pending}
				disabled={props.disabled}
				error={props.error}
				onSave={props.onSave}
				onClose={props.onClose}
			/>
		)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + props.mode)}</DialogTitle>
					<DialogDescription>{props.id}</DialogDescription>
				</DialogHeader>
				{query.isFetching && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.error && (
					<div role='alert' className='space-y-3'>
						<p className='text-destructive'>{t(modelErrorKey(query.error))}</p>
						<Button
							variant='outline'
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							{t(prefix + 'refresh')}
						</Button>
					</div>
				)}
				{row && !query.isFetching && (
					<>
						<dl className='grid gap-4 sm:grid-cols-2'>
							{[
								[t(prefix + 'display_name'), row.display_name ?? row.id],
								[t(prefix + 'vendor'), row.vendor],
								[t(prefix + 'kind'), t(prefix + row.kind)],
								[t(prefix + 'released_at'), row.released_at ?? '—'],
								[t(prefix + 'context_window'), row.context_window ?? '—'],
								[t(prefix + 'max_tokens'), row.max_tokens ?? '—'],
								[
									t(prefix + 'routes'),
									t(prefix + 'routeCounts', {
										active: row.active_routes_count,
										total: row.routes_count,
									}),
								],
								[t(prefix + 'tags'), row.tags.join(' · ') || '—'],
							].map(([name, value]) => (
								<div key={name} className='min-w-0 space-y-1'>
									<dt className='text-muted-foreground text-xs'>{name}</dt>
									<dd className='text-sm break-words'>{value}</dd>
								</div>
							))}
						</dl>
						<p className='text-sm break-words whitespace-pre-wrap'>
							{row.description}
						</p>
						<div className='grid gap-3 sm:grid-cols-2'>
							{[
								['input_modalities', row.inputModalities],
								['output_modalities', row.outputModalities],
							].map(([field, modalities]) => (
								<div key={String(field)}>
									<p className='text-muted-foreground text-xs'>
										{t(prefix + String(field))}
									</p>
									<p className='text-sm'>
										{Array.isArray(modalities)
											? modalities
													.map((value) => t(prefix + 'modality_' + value))
													.join(' · ')
											: '—'}
									</p>
								</div>
							))}
						</div>
						{props.mode === 'delete' ? (
							<p
								role='alert'
								className='text-destructive rounded-xl border p-4'
							>
								{t(prefix + 'deleteWarning', {
									id: row.id,
									count: row.routes_count,
								})}
							</p>
						) : (
							<>
								{row.pricing.state !== 'available' && (
									<p className='text-destructive text-sm'>
										{t(prefix + 'pricing_' + row.pricing.state)}
									</p>
								)}
								<PricingSummary
									profile={row.pricing.profile}
									billingCurrency={billingCurrency}
								/>
								<p className='text-muted-foreground text-sm'>
									{t(prefix + 'supplierHint')}
								</p>
								<a href='/admin/routes' className='underline'>
									{t(prefix + 'manageRoutes')}
								</a>
								{[
									['metadata', row.metadata],
									['routePolicy', row.route_policy],
									['storedProfile', row.pricing_profile],
								].map(
									([label, value]) =>
										value && (
											<details key={label!} className='rounded-lg border p-3'>
												<summary>{t(prefix + label)}</summary>
												<pre className='mt-3 max-h-64 overflow-auto text-xs break-words whitespace-pre-wrap'>
													{value}
												</pre>
											</details>
										)
								)}
							</>
						)}
					</>
				)}
				{props.error !== null && (
					<p role='alert' className='text-destructive'>
						{t(modelErrorKey(props.error))}
					</p>
				)}
				<div className='flex flex-wrap justify-end gap-2'>
					<Button
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
					{props.mode === 'delete' && (
						<Button
							variant='destructive'
							disabled={
								!row ||
								query.isFetching ||
								props.pending ||
								props.disabled ||
								props.error !== null
							}
							onClick={() => props.onDelete(props.id)}
						>
							{t(prefix + 'delete')}
						</Button>
					)}
				</div>
			</DialogContent>
		</Dialog>
	)
}
