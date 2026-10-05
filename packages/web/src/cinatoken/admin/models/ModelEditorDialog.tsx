import { useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import { Label } from '../../../components/ui/label'
import { Textarea } from '../../../components/ui/textarea'
import type { AdminModel, ModelKind } from '../model-contracts'
import {
	MODEL_VENDOR_OPTIONS,
	type CreateModelInput,
	type UpdateModelInput,
} from '../model-input'
import { ModelPricingFields } from './ModelPricingFields'
import { modelErrorKey } from './model-errors'
import {
	modelFormDefaults,
	modelFormInput,
	modelFormSchema,
	MODEL_INPUT_MODALITIES,
	MODEL_OUTPUT_MODALITIES,
	type ModelFormValues,
} from './model-form'

const prefix = 'cinatoken.adminModels.'
export function ModelEditorDialog(props: {
	row?: AdminModel
	billingCurrency?: string | null
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (input: CreateModelInput | UpdateModelInput, id?: string) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const title = useRef<HTMLHeadingElement>(null)
	const storedVendor = props.row?.vendor
	const hasStoredVendorOption =
		storedVendor !== undefined &&
		!MODEL_VENDOR_OPTIONS.some((vendor) => vendor.key === storedVendor)
	const [invalid, setInvalid] = useState(false)
	const form = useForm<ModelFormValues>({
		resolver: zodResolver(modelFormSchema),
		defaultValues: modelFormDefaults(props.row),
	})
	const values = form.watch()
	function kind(value: ModelKind): void {
		form.setValue('kind', value)
		if (value === 'image' || value === 'audio')
			form.setValue('context_window', '')
		if (value !== 'llm') form.setValue('max_tokens', '')
		if (value === 'image') {
			form.setValue('output_modalities', ['image'])
			form.setValue('pricing.mode', 'image_token')
		} else if (value === 'audio') {
			form.setValue('input_modalities', ['audio'])
			form.setValue('output_modalities', ['transcription'])
			form.setValue('pricing.mode', 'per_second')
		} else {
			form.setValue('input_modalities', ['text'])
			form.setValue(
				'output_modalities',
				value === 'rerank' ? ['rerank'] : ['text']
			)
			form.setValue('pricing.mode', 'token')
		}
		form.setValue('pricingAction', 'replace')
	}
	function toggle(
		field: 'input_modalities' | 'output_modalities',
		value: string
	): void {
		const old = form.getValues(field)
		form.setValue(
			field,
			old.includes(value)
				? old.filter((item) => item !== value)
				: [...old, value]
		)
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
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle ref={title} tabIndex={-1}>
						{t(prefix + (props.row ? 'edit' : 'create'))}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'editorHint')}</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-5'
					onSubmit={form.handleSubmit((next) => {
						try {
							setInvalid(false)
							const input = modelFormInput(next, Boolean(props.row))
							if (props.row) {
								// Leave the stored raw value untouched unless the user changes it.
								if (next.vendor === props.row.vendor) delete input.vendor
								props.onSave(
									{ ...input, expected_route_policy: props.row.route_policy },
									props.row.id
								)
							} else props.onSave(input)
						} catch {
							setInvalid(true)
						}
					})}
				>
					<fieldset
						disabled={props.pending || props.disabled || props.error !== null}
						className='space-y-5'
					>
						<div className='grid gap-4 sm:grid-cols-2'>
							{(
								[
									'id',
									'display_name',
									'context_window',
									'max_tokens',
									'released_at',
									'tags',
								] as const
							).map((field) => (
								<div key={field} className='space-y-2'>
									<Label htmlFor={'model-' + field}>{t(prefix + field)}</Label>
									<Input
										id={'model-' + field}
										{...form.register(field)}
										readOnly={field === 'id' && Boolean(props.row)}
										type={field === 'released_at' ? 'date' : 'text'}
										inputMode={
											field === 'context_window' || field === 'max_tokens'
												? 'numeric'
												: undefined
										}
									/>
								</div>
							))}
							<div className='space-y-2'>
								<Label htmlFor='model-vendor'>{t(prefix + 'vendor')}</Label>
								<select
									id='model-vendor'
									{...form.register('vendor')}
									className='bg-background h-10 w-full rounded-md border px-3'
								>
									{hasStoredVendorOption && (
										<option value={storedVendor}>
											{t(prefix + 'keep')}: {JSON.stringify(storedVendor)}
										</option>
									)}
									{MODEL_VENDOR_OPTIONS.map((vendor) => (
										<option key={vendor.key} value={vendor.key}>
											{vendor.label}
										</option>
									))}
								</select>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='model-kind'>{t(prefix + 'kind')}</Label>
								<select
									id='model-kind'
									value={values.kind}
									onChange={(event) => kind(event.target.value as ModelKind)}
									className='bg-background h-10 w-full rounded-md border px-3'
								>
									{['llm', 'image', 'audio', 'rerank'].map((value) => (
										<option key={value} value={value}>
											{t(prefix + value)}
										</option>
									))}
								</select>
							</div>
						</div>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'limitsHint')}
						</p>
						<div className='space-y-2'>
							<Label htmlFor='model-description'>
								{t(prefix + 'description')}
							</Label>
							<Textarea
								id='model-description'
								{...form.register('description')}
							/>
						</div>
						<div className='grid gap-4 sm:grid-cols-2'>
							{(['input_modalities', 'output_modalities'] as const).map(
								(field) => (
									<fieldset
										key={field}
										className='space-y-2 rounded-lg border p-3'
									>
										<legend>{t(prefix + field)}</legend>
										<div className='flex flex-wrap gap-3'>
											{(field === 'input_modalities'
												? MODEL_INPUT_MODALITIES
												: MODEL_OUTPUT_MODALITIES
											).map((value) => (
												<label
													key={value}
													className='flex items-center gap-2 text-sm'
												>
													<input
														type='checkbox'
														checked={values[field].includes(value)}
														onChange={() => toggle(field, value)}
													/>
													{t(prefix + 'modality_' + value)}
												</label>
											))}
										</div>
									</fieldset>
								)
							)}
						</div>
						<ModelPricingFields
							form={form}
							editing={Boolean(props.row)}
							billingCurrency={props.billingCurrency ?? null}
						/>
						<section className='space-y-3 rounded-xl border p-4'>
							<h2 className='font-semibold'>{t(prefix + 'metadata')}</h2>
							{props.row && (
								<select
									aria-label={t(prefix + 'metadataAction')}
									{...form.register('metadataAction')}
									className='bg-background h-10 w-full rounded-md border px-3'
								>
									{['keep', 'replace', 'clear'].map((value) => (
										<option key={value} value={value}>
											{t(prefix + value)}
										</option>
									))}
								</select>
							)}
							{values.metadataAction === 'replace' && (
								<>
									<Label htmlFor='model-metadata'>
										{t(prefix + 'metadataJson')}
									</Label>
									<Textarea
										id='model-metadata'
										{...form.register('metadata')}
										rows={5}
										className='font-mono'
										spellCheck={false}
									/>
									<label className='flex items-center gap-2'>
										<input
											type='checkbox'
											{...form.register('topProviderEnabled')}
										/>
										{t(prefix + 'topProvider')}
									</label>
									{values.topProviderEnabled && (
										<>
											<Label htmlFor='model-endpoint-tag'>
												{t(prefix + 'endpointTag')}
											</Label>
											<Input
												id='model-endpoint-tag'
												{...form.register('endpointTag')}
											/>
											<label className='flex items-center gap-2'>
												<input
													type='checkbox'
													{...form.register('isModerated')}
												/>
												{t(prefix + 'moderated')}
											</label>
										</>
									)}
									<p className='text-muted-foreground text-xs'>
										{t(prefix + 'topProviderHint')}
									</p>
								</>
							)}
						</section>
						{props.row && (
							<section className='space-y-3 rounded-xl border p-4'>
								<h2 className='font-semibold'>{t(prefix + 'routePolicy')}</h2>
								<select
									aria-label={t(prefix + 'routePolicy')}
									{...form.register('routePolicyAction')}
									className='bg-background h-10 w-full rounded-md border px-3'
								>
									{['keep', 'replace', 'clear'].map((value) => (
										<option key={value} value={value}>
											{t(prefix + value)}
										</option>
									))}
								</select>
								{values.routePolicyAction === 'replace' && (
									<>
										<Label htmlFor='model-route-policy'>
											{t(prefix + 'routePolicyJson')}
										</Label>
										<Textarea
											id='model-route-policy'
											{...form.register('routePolicy')}
											rows={4}
											spellCheck={false}
											className='font-mono'
										/>
									</>
								)}
							</section>
						)}
					</fieldset>
					{(invalid || Object.keys(form.formState.errors).length > 0) && (
						<p role='alert' className='text-destructive'>
							{t(prefix + 'validation')}
						</p>
					)}
					{props.error !== null && (
						<p role='alert' className='text-destructive'>
							{t(modelErrorKey(props.error))}
						</p>
					)}
					<div className='flex flex-wrap justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={props.pending}
							onClick={props.onClose}
						>
							{t(prefix + 'close')}
						</Button>
						<Button
							type='submit'
							disabled={props.pending || props.disabled || props.error !== null}
						>
							{t(prefix + 'save')}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
