import { useForm, useWatch } from 'react-hook-form'
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
import type { AdminProvider } from '../provider-contracts'
import { ProviderEndpointFields } from './ProviderEndpointFields'
import { providerErrorKey } from './provider-errors'
import {
	endpointDrafts,
	providerFormDefaults,
	providerFormSchema,
	type ProviderEditorMode,
	type ProviderFormValues,
} from './provider-form'

const prefix = 'cinatoken.adminProviders.'
export function ProviderEditorDialog(props: {
	mode: ProviderEditorMode
	row?: AdminProvider
	pending: boolean
	disabled: boolean
	error: unknown
	onSave: (values: ProviderFormValues) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const defaults = providerFormDefaults(props.mode, props.row)
	if (props.mode === 'clone' && props.row)
		defaults.name = t(prefix + 'copyName', { name: props.row.name })
	const form = useForm<ProviderFormValues>({
		resolver: zodResolver(providerFormSchema),
		defaultValues: defaults,
	})
	const endpointMode = useWatch({ control: form.control, name: 'endpointMode' })
	const error = (name: keyof ProviderFormValues) => {
		const message = form.formState.errors[name]?.message
		return message ? (
			<p role='alert' className='text-destructive text-xs'>
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
					<DialogTitle>{t(prefix + props.mode)}</DialogTitle>
					<DialogDescription>
						{t(
							prefix + (props.mode === 'clone' ? 'cloneHint' : 'credentialHint')
						)}
					</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-5'
					onSubmit={form.handleSubmit((values) => {
						const checked = structuredClone(values)
						form.reset({
							...values,
							api_key: '',
							endpoints: endpointDrafts(props.row?.endpoints ?? null),
						})
						props.onSave(checked)
					})}
				>
					<fieldset
						disabled={props.pending || props.disabled || props.error != null}
						className='space-y-5'
					>
						<div className='grid gap-4 sm:grid-cols-2'>
							<div className='space-y-2'>
								<Label htmlFor='provider-name'>{t(prefix + 'name')}</Label>
								<Input
									id='provider-name'
									{...form.register('name')}
									autoComplete='off'
								/>
								{error('name')}
							</div>
							<div className='space-y-2'>
								<Label htmlFor='provider-id'>{t(prefix + 'id')}</Label>
								<Input
									id='provider-id'
									{...form.register('id')}
									readOnly={props.mode === 'edit'}
									autoComplete='off'
								/>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'idHint')}
								</p>
								{error('id')}
							</div>
						</div>
						<div className='space-y-2'>
							<Label htmlFor='provider-description'>
								{t(prefix + 'description')}
							</Label>
							<Textarea
								id='provider-description'
								{...form.register('description')}
							/>
						</div>
						<div className='grid gap-4 sm:grid-cols-2'>
							<div className='space-y-2'>
								<Label htmlFor='provider-status'>{t(prefix + 'status')}</Label>
								<select
									id='provider-status'
									className='bg-background h-10 w-full rounded-md border px-3'
									{...form.register('status')}
									disabled={props.mode === 'clone'}
								>
									<option value='disabled'>{t(prefix + 'disabled')}</option>
									<option value='active'>{t(prefix + 'active')}</option>
								</select>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='provider-shared-channel'>
									{t(prefix + 'sharedChannel')}
								</Label>
								<select
									id='provider-shared-channel'
									className='bg-background h-10 w-full rounded-md border px-3'
									{...form.register('shared_channel_type')}
								>
									<option value=''>{t(prefix + 'noSharedChannel')}</option>
									{['openai', 'anthropic', 'zhipu', 'deepseek'].map((value) => (
										<option value={value} key={value}>
											{value}
										</option>
									))}
								</select>
							</div>
						</div>
						<div className='space-y-2'>
							<Label htmlFor='provider-key'>{t(prefix + 'credential')}</Label>
							<Textarea
								id='provider-key'
								{...form.register('api_key')}
								autoComplete='off'
								spellCheck={false}
								className='font-mono text-sm'
							/>
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'credentialHint')}
							</p>
							{error('api_key')}
						</div>
						{props.row?.endpointsState === 'redacted' && (
							<p
								role='status'
								className='text-muted-foreground rounded-lg border p-3 text-sm'
							>
								{t(prefix + 'endpointRedacted')}
							</p>
						)}
						{props.row?.endpointsState === 'invalid' && (
							<p
								role='status'
								className='text-muted-foreground rounded-lg border p-3 text-sm'
							>
								{t(prefix + 'endpointInvalid')}
							</p>
						)}
						<div className='space-y-2'>
							<Label htmlFor='provider-endpoint-mode'>
								{t(prefix + 'endpointMode')}
							</Label>
							<select
								id='provider-endpoint-mode'
								className='bg-background h-10 w-full rounded-md border px-3'
								{...form.register('endpointMode')}
							>
								<option value='keep'>{t(prefix + 'keepEndpoints')}</option>
								<option value='replace'>
									{t(prefix + 'replaceEndpoints')}
								</option>
								<option value='clear'>{t(prefix + 'clearEndpoints')}</option>
							</select>
						</div>
						{endpointMode === 'replace' && (
							<ProviderEndpointFields
								register={form.register}
								disabled={props.pending || props.disabled}
							/>
						)}
						{endpointMode === 'clear' && (
							<p className='text-destructive text-sm'>
								{t(prefix + 'clearEndpointsHint')}
							</p>
						)}
						{error('endpoints')}
					</fieldset>
					{props.error != null && (
						<div role='alert' className='text-destructive space-y-2 text-sm'>
							<p>{t(providerErrorKey(props.error))}</p>
							<p>{t(prefix + 'writeUnknown')}</p>
						</div>
					)}
					<div className='flex flex-wrap justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							onClick={props.onClose}
							disabled={props.pending}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button
							type='submit'
							disabled={props.pending || props.disabled || props.error != null}
						>
							{t(prefix + (props.pending ? 'saving' : 'save'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
