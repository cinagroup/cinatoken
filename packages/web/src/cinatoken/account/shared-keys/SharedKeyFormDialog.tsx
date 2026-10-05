import { useForm } from 'react-hook-form'
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
import type { SharedKey, SharedKeyCatalog } from '../../shared-key-contracts'
import {
	sharedKeyDefaults,
	sharedKeyFormSchema,
	type SharedKeyForm,
} from './shared-key-form'
import { sharedKeyErrorKey } from './use-shared-keys'

const prefix = 'cinatoken.account.sharedKeys.'
const selectClass = 'bg-background h-10 w-full rounded-lg border px-3 text-sm'
export function SharedKeyFormDialog(props: {
	row: SharedKey | null
	catalog: SharedKeyCatalog
	pending: boolean
	error: unknown
	onSave: (values: SharedKeyForm) => void
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	const editing = props.row !== null
	const form = useForm<SharedKeyForm>({
		resolver: zodResolver(sharedKeyFormSchema(props.catalog, editing)),
		defaultValues: sharedKeyDefaults(props.catalog, props.row ?? undefined),
	})
	const money = (value: number) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			style: 'currency',
			currency: props.catalog.billingCurrency,
			currencyDisplay: 'code',
			maximumFractionDigits: 6,
		}).format(value)
	const limits = t(prefix + 'limitsHint', {
		input: money(props.catalog.limits.maxInputPrice),
		output: money(props.catalog.limits.maxOutputPrice),
		commission: new Intl.NumberFormat(i18n.resolvedLanguage, {
			style: 'percent',
			maximumFractionDigits: 2,
		}).format(props.catalog.limits.commissionRate),
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>
						{t(prefix + (editing ? 'editTitle' : 'createTitle'))}
					</DialogTitle>
					<DialogDescription>{t(prefix + 'subtitle')}</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-5'
					onSubmit={form.handleSubmit((values) => {
						props.onSave(values)
						form.resetField('apiKey', { defaultValue: '' })
					})}
				>
					<fieldset className='space-y-4' disabled={props.pending}>
						<div className='grid gap-4 sm:grid-cols-2'>
							<div className='space-y-2'>
								<Label htmlFor='shared-key-channel'>
									{t(prefix + 'channelType')}
								</Label>
								{editing ? (
									<Input
										id='shared-key-channel'
										readOnly
										{...form.register('channelType')}
									/>
								) : (
									<select
										id='shared-key-channel'
										className={selectClass}
										{...form.register('channelType')}
									>
										{props.catalog.channels.map((channel) => (
											<option
												key={channel.channelType}
												value={channel.channelType}
											>
												{channel.label}
											</option>
										))}
									</select>
								)}
								{form.formState.errors.channelType && (
									<p role='alert' className='text-destructive text-xs'>
										{t(
											form.formState.errors.channelType.message ??
												prefix + 'channelUnavailable'
										)}
									</p>
								)}
							</div>
							<div className='space-y-2'>
								<Label htmlFor='shared-key-label'>{t(prefix + 'label')}</Label>
								<Input
									id='shared-key-label'
									maxLength={128}
									aria-invalid={Boolean(form.formState.errors.label)}
									{...form.register('label')}
								/>
								{form.formState.errors.label && (
									<p role='alert' className='text-destructive text-xs'>
										{t(prefix + 'labelInvalid')}
									</p>
								)}
							</div>
						</div>
						{editing ? (
							<p className='text-muted-foreground text-xs'>
								{t(prefix + 'editSecretHint')}
							</p>
						) : (
							<div className='space-y-2'>
								<Label htmlFor='shared-key-secret'>
									{t(prefix + 'apiKey')}
								</Label>
								<Input
									id='shared-key-secret'
									type='password'
									autoComplete='new-password'
									aria-invalid={Boolean(form.formState.errors.apiKey)}
									aria-describedby='shared-key-secret-hint'
									{...form.register('apiKey')}
								/>
								{form.formState.errors.apiKey && (
									<p role='alert' className='text-destructive text-xs'>
										{t(
											form.formState.errors.apiKey.message ??
												prefix + 'secretInvalid'
										)}
									</p>
								)}
								<p
									id='shared-key-secret-hint'
									className='text-muted-foreground text-xs leading-5'
								>
									{t(prefix + 'secretHint')}
								</p>
							</div>
						)}
						<div className='bg-muted/40 space-y-1 rounded-lg border p-3 text-xs'>
							<p>
								{t(prefix + 'priceUnit', {
									currency: props.catalog.billingCurrency,
								})}
							</p>
							<p className='text-muted-foreground'>{limits}</p>
						</div>
						<div className='grid gap-4 sm:grid-cols-2'>
							{(
								[
									'inputPrice',
									'outputPrice',
									'cacheReadPrice',
									'cacheWritePrice',
								] as const
							).map((field) => (
								<div className='space-y-2' key={field}>
									<Label htmlFor={'shared-key-' + field}>
										{t(prefix + field)}
									</Label>
									<Input
										id={'shared-key-' + field}
										inputMode='decimal'
										aria-invalid={Boolean(form.formState.errors[field])}
										{...form.register(field)}
									/>
									{form.formState.errors[field] && (
										<p role='alert' className='text-destructive text-xs'>
											{t(
												form.formState.errors[field]?.message ??
													prefix + 'priceInvalid'
											)}
										</p>
									)}
								</div>
							))}
						</div>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'cacheHint')}
						</p>
						<div className='space-y-2'>
							<Label htmlFor='shared-key-weight'>{t(prefix + 'weight')}</Label>
							<Input
								id='shared-key-weight'
								inputMode='numeric'
								aria-invalid={Boolean(form.formState.errors.weight)}
								aria-describedby='shared-key-weight-hint'
								{...form.register('weight')}
							/>
							{form.formState.errors.weight && (
								<p role='alert' className='text-destructive text-xs'>
									{t(prefix + 'weightInvalid')}
								</p>
							)}
							<p
								id='shared-key-weight-hint'
								className='text-muted-foreground text-xs'
							>
								{t(prefix + 'weightHint')}
							</p>
						</div>
					</fieldset>
					{props.error != null && (
						<p
							role='alert'
							className='text-destructive rounded-lg border p-3 text-sm'
						>
							{t(sharedKeyErrorKey(props.error))}
						</p>
					)}
					<div className='flex flex-wrap justify-end gap-2 border-t pt-4'>
						<Button
							variant='outline'
							type='button'
							disabled={props.pending}
							onClick={props.onClose}
						>
							{t('cinatoken.account.cancel')}
						</Button>
						<Button type='submit' disabled={props.pending}>
							{t(prefix + (props.pending ? 'saving' : 'save'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
