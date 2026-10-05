import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { PresetMetadataInput, RequestPreset } from '../../preset-contracts'
import { presetErrorKey } from './preset-errors'
import {
	presetMetadataFormSchema,
	type PresetMetadataForm,
} from './preset-form'

const prefix = 'cinatoken.presets.'
export function PresetMetadataDialog(props: {
	row: RequestPreset
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (input: PresetMetadataInput) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const form = useForm<PresetMetadataForm>({
		resolver: zodResolver(presetMetadataFormSchema),
		defaultValues: {
			name: props.row.name,
			description: props.row.description ?? '',
			visibility: props.row.visibility,
		},
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + 'metadataTitle', { name: props.row.name })}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'metadataHint')}</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-4'
					onSubmit={form.handleSubmit((values) =>
						props.onSave({ ...values, description: values.description || null })
					)}
				>
					<fieldset disabled={props.pending} className='space-y-4'>
						<div className='space-y-2'>
							<Label htmlFor='preset-meta-name'>
								{t(prefix + 'metadataName')}
							</Label>
							<Input
								id='preset-meta-name'
								{...form.register('name')}
								aria-invalid={Boolean(form.formState.errors.name)}
							/>
							{form.formState.errors.name?.message && (
								<p role='alert' className='text-destructive text-xs'>
									{t(form.formState.errors.name.message)}
								</p>
							)}
						</div>
						<div className='space-y-2'>
							<Label htmlFor='preset-meta-description'>
								{t(prefix + 'description')}
							</Label>
							<Textarea
								id='preset-meta-description'
								rows={4}
								{...form.register('description')}
							/>
							{form.formState.errors.description?.message && (
								<p role='alert' className='text-destructive text-xs'>
									{t(form.formState.errors.description.message)}
								</p>
							)}
						</div>
						<div className='space-y-2'>
							<Label htmlFor='preset-meta-visibility'>
								{t(prefix + 'visibility')}
							</Label>
							<select
								id='preset-meta-visibility'
								className='bg-background h-10 w-full rounded-lg border px-3 text-sm'
								{...form.register('visibility')}
							>
								<option value='private'>{t(prefix + 'private')}</option>
								<option value='public'>{t(prefix + 'public')}</option>
							</select>
						</div>
						<p className='text-muted-foreground text-xs leading-5'>
							{t(prefix + 'publicHint')}
						</p>
					</fieldset>
					{props.error != null && (
						<p role='alert' className='text-destructive text-sm'>
							{t(presetErrorKey(props.error))}
						</p>
					)}
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
							type='submit'
							disabled={props.disabled || props.error != null}
						>
							{t(prefix + (props.pending ? 'changing' : 'saveMetadata'))}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
