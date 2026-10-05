import { useForm, type UseFormReturn } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { byokFormSchema, type ByokForm } from './byok-form-schema'
import { byokErrorKey } from './use-byok-manager'

const selectClass =
	'bg-background mt-2 h-10 w-full rounded-lg border px-3 text-sm'
type Props = {
	defaultValues: ByokForm
	editing: boolean
	isPending: boolean
	error: unknown
	onSubmit: (values: ByokForm) => void
	onClose: () => void
}

function Restrictions(props: {
	form: UseFormReturn<ByokForm>
	field: 'allowedModels' | 'allowedUserIds' | 'allowedApiKeyHashes'
	mode: 'modelsMode' | 'usersMode' | 'keysMode'
	label: 'models' | 'users' | 'gatewayKeys'
}) {
	const { t } = useTranslation()
	const error = props.form.formState.errors[props.field]
	const mode = props.form.watch(props.mode)
	const id = 'byok-' + props.field
	return (
		<div className='space-y-2'>
			<Label htmlFor={id + '-mode'}>
				{t('cinatoken.account.byok.' + props.label)}
			</Label>
			<select
				id={id + '-mode'}
				className={selectClass}
				{...props.form.register(props.mode)}
			>
				<option value='any'>{t('cinatoken.account.byok.any')}</option>
				<option value='list'>{t('cinatoken.account.byok.list')}</option>
				{props.mode !== 'keysMode' && (
					<option value='none'>{t('cinatoken.account.byok.none')}</option>
				)}
			</select>
			{mode === 'list' && (
				<>
					<Label htmlFor={id} className='sr-only'>
						{t('cinatoken.account.byok.' + props.label)}
					</Label>
					<Textarea
						id={id}
						rows={3}
						className='max-h-48 resize-y font-mono text-xs'
						aria-invalid={Boolean(error)}
						aria-describedby={id + '-hint'}
						{...props.form.register(props.field)}
					/>
					{error && (
						<p role='alert' className='text-destructive text-xs'>
							{t(error.message ?? 'cinatoken.account.byok.listInvalid')}
						</p>
					)}
				</>
			)}
			<p id={id + '-hint'} className='text-muted-foreground text-xs leading-5'>
				{t(
					props.mode === 'keysMode'
						? 'cinatoken.account.byok.hashHint'
						: 'cinatoken.account.byok.listHint'
				)}
			</p>
		</div>
	)
}

export function ByokCredentialForm(props: Props) {
	const { t } = useTranslation()
	const form = useForm<ByokForm>({
		resolver: zodResolver(byokFormSchema),
		defaultValues: props.defaultValues,
	})
	const errors = form.formState.errors
	const fallback = form.watch('isFallback')
	return (
		<form
			className='flex min-h-0 flex-col gap-4'
			onSubmit={form.handleSubmit((values) => {
				if (!props.editing && values.key.trim().length === 0) {
					form.setError('key', {
						message: 'cinatoken.account.byok.secretRequired',
					})
					return
				}
				props.onSubmit(values)
				form.resetField('key', { defaultValue: '' })
			})}
		>
			<fieldset disabled={props.isPending} className='space-y-5'>
				<div className='grid gap-4 sm:grid-cols-2'>
					<div className='space-y-2'>
						<Label htmlFor='byok-provider'>
							{t('cinatoken.account.byok.provider')}
						</Label>
						<Input
							id='byok-provider'
							readOnly={props.editing}
							maxLength={128}
							autoFocus={!props.editing}
							placeholder={t('cinatoken.account.byok.providerPlaceholder')}
							aria-invalid={Boolean(errors.provider)}
							{...form.register('provider')}
						/>
						{errors.provider && (
							<p role='alert' className='text-destructive text-xs'>
								{t(
									errors.provider.message ??
										'cinatoken.account.byok.providerInvalid'
								)}
							</p>
						)}
					</div>
					<div className='space-y-2'>
						<Label htmlFor='byok-name'>
							{t('cinatoken.account.byok.name')}
						</Label>
						<Input
							id='byok-name'
							aria-invalid={Boolean(errors.name)}
							{...form.register('name')}
						/>
						{errors.name && (
							<p role='alert' className='text-destructive text-xs'>
								{t(errors.name.message ?? 'cinatoken.account.byok.nameInvalid')}
							</p>
						)}
					</div>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='byok-secret'>
						{t(
							props.editing
								? 'cinatoken.account.byok.replacement'
								: 'cinatoken.account.byok.secret'
						)}
					</Label>
					<Input
						id='byok-secret'
						type='password'
						autoComplete='new-password'
						spellCheck={false}
						aria-invalid={Boolean(errors.key)}
						aria-describedby='byok-secret-hint'
						{...form.register('key')}
					/>
					{errors.key && (
						<p role='alert' className='text-destructive text-xs'>
							{t(errors.key.message ?? 'cinatoken.account.byok.secretInvalid')}
						</p>
					)}
					<p
						id='byok-secret-hint'
						className='text-muted-foreground text-xs leading-5'
					>
						{t('cinatoken.account.byok.secretHint')}
					</p>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='byok-routing'>
						{t('cinatoken.account.byok.routing')}
					</Label>
					<select
						id='byok-routing'
						className={selectClass}
						value={fallback ? 'fallback' : 'primary'}
						onChange={(event) => {
							const isFallback = event.target.value === 'fallback'
							form.setValue('isFallback', isFallback, { shouldDirty: true })
							if (isFallback)
								form.setValue('sharedCapacityPolicy', 'allow', {
									shouldDirty: true,
								})
						}}
					>
						<option value='primary'>
							{t('cinatoken.account.byok.primary')}
						</option>
						<option value='fallback'>
							{t('cinatoken.account.byok.fallback')}
						</option>
					</select>
					<p className='text-muted-foreground text-xs'>
						{t(
							fallback
								? 'cinatoken.account.byok.fallbackHint'
								: 'cinatoken.account.byok.primaryHint'
						)}
					</p>
				</div>
				<div className='space-y-2'>
					<Label htmlFor='byok-policy'>
						{t('cinatoken.account.byok.sharedCapacity')}
					</Label>
					<select
						id='byok-policy'
						disabled={fallback}
						className={selectClass}
						{...form.register('sharedCapacityPolicy')}
					>
						<option value='allow'>{t('cinatoken.account.byok.allow')}</option>
						<option value='matching_models'>
							{t('cinatoken.account.byok.matching_models')}
						</option>
						<option value='provider'>
							{t('cinatoken.account.byok.providerPolicy')}
						</option>
					</select>
					<p className='text-muted-foreground text-xs leading-5'>
						{t('cinatoken.account.byok.sharedCapacityHint')}
					</p>
					{errors.sharedCapacityPolicy && (
						<p role='alert' className='text-destructive text-xs'>
							{t(
								errors.sharedCapacityPolicy.message ??
									'cinatoken.account.byok.fallbackPolicyInvalid'
							)}
						</p>
					)}
				</div>
				<div className='space-y-5 border-t pt-5'>
					<Restrictions
						form={form}
						field='allowedModels'
						mode='modelsMode'
						label='models'
					/>
					<Restrictions
						form={form}
						field='allowedUserIds'
						mode='usersMode'
						label='users'
					/>
					<Restrictions
						form={form}
						field='allowedApiKeyHashes'
						mode='keysMode'
						label='gatewayKeys'
					/>
				</div>
				<label className='flex items-start justify-between gap-4 rounded-lg border p-3'>
					<span>
						<span className='block font-medium'>
							{t('cinatoken.account.byok.disabled')}
						</span>
						<span className='text-muted-foreground mt-1 block text-xs'>
							{t('cinatoken.account.byok.disabledHint')}
						</span>
					</span>
					<input
						type='checkbox'
						className='mt-1 size-4 shrink-0'
						{...form.register('disabled')}
					/>
				</label>
			</fieldset>
			{Boolean(props.error) && (
				<p
					role='alert'
					className='text-destructive rounded-lg border p-3 text-sm'
				>
					{t(byokErrorKey(props.error))}
				</p>
			)}
			<div className='flex flex-wrap justify-end gap-2 border-t pt-4'>
				<Button
					type='button'
					variant='outline'
					disabled={props.isPending}
					onClick={props.onClose}
				>
					{t('cinatoken.account.cancel')}
				</Button>
				<Button type='submit' disabled={props.isPending}>
					{t(
						props.isPending
							? 'cinatoken.account.byok.saving'
							: 'cinatoken.account.byok.save'
					)}
				</Button>
			</div>
		</form>
	)
}
