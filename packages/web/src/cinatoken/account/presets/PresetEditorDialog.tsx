import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type {
	PresetVersion,
	RequestPreset,
	SavePresetVersionInput,
} from '../../preset-contracts'
import { PresetConfigurationEditor } from './PresetConfigurationEditor'
import { presetConfigurationBytes } from './preset-config-editor'
import { presetErrorKey } from './preset-errors'
import {
	presetDefaults,
	presetFormInput,
	presetFormSchema,
	type PresetForm,
} from './preset-form'

const prefix = 'cinatoken.presets.'
export function PresetEditorDialog(props: {
	row?: RequestPreset
	version?: PresetVersion
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (input: SavePresetVersionInput) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const form = useForm<PresetForm>({
		resolver: zodResolver(presetFormSchema),
		defaultValues: presetDefaults(props.row, props.version),
	})
	const [review, setReview] = useState<SavePresetVersionInput | null>(null)
	const prompt = useWatch({ control: form.control, name: 'systemPrompt' })
	const text = useWatch({ control: form.control, name: 'configText' })
	const visibility = useWatch({ control: form.control, name: 'visibility' })
	const fieldError = (name: keyof PresetForm) => {
		const message = form.formState.errors[name]?.message
		return message ? (
			<p
				id={'preset-' + name + '-error'}
				role='alert'
				className='text-destructive text-xs'
			>
				{t(message)}
			</p>
		) : null
	}
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
					<DialogTitle>
						{review
							? t(prefix + 'reviewTitle')
							: t(prefix + (props.row ? 'versionTitle' : 'createTitle'), {
									name: props.row?.name,
								})}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'activationHint')}</DialogDescription>
				</DialogHeader>
				{review ? (
					<div className='space-y-4'>
						<p className='font-medium break-all'>@preset/{review.slug}</p>
						{review.visibility === 'public' && (
							<p className='rounded-lg border p-3 text-sm'>
								{t(prefix + 'publicHint')}
							</p>
						)}
						<pre className='bg-muted max-h-72 overflow-auto rounded-lg p-3 text-xs break-all whitespace-pre-wrap'>
							{JSON.stringify(
								{ systemPrompt: review.systemPrompt, config: review.config },
								null,
								2
							)}
						</pre>
						{props.error != null && (
							<p role='alert' className='text-destructive text-sm'>
								{t(presetErrorKey(props.error))}
							</p>
						)}
						<div className='flex flex-col gap-2 sm:flex-row sm:justify-end'>
							<Button
								variant='outline'
								disabled={props.pending}
								onClick={() => setReview(null)}
							>
								{t(prefix + 'back')}
							</Button>
							<Button
								variant='outline'
								disabled={props.pending}
								onClick={props.onClose}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button
								disabled={props.disabled || props.error != null}
								onClick={() => props.onSave(review)}
							>
								{t(prefix + (props.pending ? 'saving' : 'save'))}
							</Button>
						</div>
					</div>
				) : (
					<form
						className='space-y-5'
						onSubmit={form.handleSubmit((values) =>
							setReview(presetFormInput(values))
						)}
					>
						<fieldset disabled={props.pending} className='space-y-5'>
							<div className='grid gap-4 sm:grid-cols-2'>
								<div className='space-y-2'>
									<Label htmlFor='preset-slug'>{t(prefix + 'slug')}</Label>
									<Input
										id='preset-slug'
										readOnly={Boolean(props.row)}
										aria-describedby='preset-slug-hint preset-slug-error'
										aria-invalid={Boolean(form.formState.errors.slug)}
										{...form.register('slug')}
									/>
									<p
										id='preset-slug-hint'
										className='text-muted-foreground text-xs leading-5'
									>
										{t(prefix + 'slugHint')}
									</p>
									{fieldError('slug')}
								</div>
								<div className='space-y-2'>
									<Label htmlFor='preset-name'>{t(prefix + 'name')}</Label>
									<Input
										id='preset-name'
										aria-invalid={Boolean(form.formState.errors.name)}
										{...form.register('name')}
									/>
									{fieldError('name')}
								</div>
								<div className='space-y-2'>
									<Label htmlFor='preset-description'>
										{t(prefix + 'description')}
									</Label>
									<Textarea
										id='preset-description'
										rows={3}
										{...form.register('description')}
									/>
									{fieldError('description')}
								</div>
								<div className='space-y-2'>
									<Label htmlFor='preset-visibility'>
										{t(prefix + 'visibility')}
									</Label>
									<select
										id='preset-visibility'
										className='bg-background h-10 w-full rounded-lg border px-3 text-sm'
										{...form.register('visibility')}
									>
										<option value='private'>{t(prefix + 'private')}</option>
										<option value='public'>{t(prefix + 'public')}</option>
									</select>
									{visibility === 'public' && (
										<p className='text-muted-foreground text-xs leading-5'>
											{t(prefix + 'publicHint')}
										</p>
									)}
								</div>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='preset-systemPrompt'>
									{t(prefix + 'systemPrompt')}
								</Label>
								<Textarea
									id='preset-systemPrompt'
									rows={5}
									aria-describedby='preset-prompt-hint preset-systemPrompt-error'
									aria-invalid={Boolean(form.formState.errors.systemPrompt)}
									{...form.register('systemPrompt')}
								/>
								<p
									id='preset-prompt-hint'
									className='text-muted-foreground text-xs'
								>
									{t(prefix + 'promptHint')}
								</p>
								{fieldError('systemPrompt')}
							</div>
							{(props.version ?? props.row)?.config === null && (
								<p className='text-destructive text-sm'>
									{t(prefix + 'configUnavailable')}
								</p>
							)}
							<PresetConfigurationEditor form={form} />
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'bytes', {
									config: presetConfigurationBytes(text),
									prompt: new TextEncoder().encode(prompt).byteLength,
								})}
							</p>
						</fieldset>
						<div className='flex flex-col gap-2 sm:flex-row sm:justify-end'>
							<Button type='button' variant='outline' onClick={props.onClose}>
								{t(prefix + 'cancel')}
							</Button>
							<Button type='submit'>{t(prefix + 'review')}</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	)
}
