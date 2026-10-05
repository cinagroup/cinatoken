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
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { createKeySchema, type CreateKeyForm } from './key-form-schema'

type KeyCreateDialogProps = {
	workspaceName: string
	billingCurrency: string
	isPending: boolean
	error: boolean
	onClose: () => void
	onSubmit: (values: CreateKeyForm) => void
}

export function KeyCreateDialog(props: KeyCreateDialogProps) {
	const { t } = useTranslation()
	const form = useForm<CreateKeyForm>({
		resolver: zodResolver(createKeySchema),
		defaultValues: { name: '', limit: '', reset: 'lifetime', expiresAt: '' },
	})
	const errors = form.formState.errors

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.isPending) props.onClose()
			}}
		>
			<DialogContent className='sm:max-w-lg' showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>{t('cinatoken.account.keys.create')}</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.keys.createIn', {
							name: props.workspaceName,
						})}
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={form.handleSubmit(props.onSubmit)}
					className='space-y-5'
				>
					<fieldset disabled={props.isPending} className='space-y-5'>
						<div className='space-y-2'>
							<Label htmlFor='key-name'>
								{t('cinatoken.account.keys.name')}
							</Label>
							<Input
								id='key-name'
								autoFocus
								maxLength={128}
								placeholder={t('cinatoken.account.keys.namePlaceholder')}
								aria-invalid={Boolean(errors.name)}
								aria-describedby={errors.name ? 'key-name-error' : undefined}
								{...form.register('name')}
							/>
							{errors.name && (
								<p id='key-name-error' className='text-destructive text-xs'>
									{t(
										errors.name.message ?? 'cinatoken.account.keys.nameInvalid'
									)}
								</p>
							)}
						</div>
						<div className='grid gap-4 sm:grid-cols-2'>
							<div className='space-y-2'>
								<Label htmlFor='key-limit'>
									{t('cinatoken.account.keys.limit', {
										currency: props.billingCurrency,
									})}
								</Label>
								<Input
									id='key-limit'
									type='number'
									min='0'
									step='0.000001'
									placeholder={t('cinatoken.account.keys.unlimited')}
									aria-invalid={Boolean(errors.limit)}
									aria-describedby={
										errors.limit ? 'key-limit-error' : 'key-limit-hint'
									}
									{...form.register('limit')}
								/>
								{errors.limit && (
									<p id='key-limit-error' className='text-destructive text-xs'>
										{t(
											errors.limit.message ??
												'cinatoken.account.keys.limitInvalid'
										)}
									</p>
								)}
							</div>
							<div className='space-y-2'>
								<Label htmlFor='key-reset'>
									{t('cinatoken.account.keys.reset')}
								</Label>
								<NativeSelect
									id='key-reset'
									className='w-full'
									{...form.register('reset')}
								>
									<NativeSelectOption value='lifetime'>
										{t('cinatoken.account.keys.lifetime')}
									</NativeSelectOption>
									<NativeSelectOption value='daily'>
										{t('cinatoken.account.keys.daily')}
									</NativeSelectOption>
									<NativeSelectOption value='weekly'>
										{t('cinatoken.account.keys.weekly')}
									</NativeSelectOption>
									<NativeSelectOption value='monthly'>
										{t('cinatoken.account.keys.monthly')}
									</NativeSelectOption>
								</NativeSelect>
							</div>
						</div>
						<p id='key-limit-hint' className='text-muted-foreground text-xs'>
							{t('cinatoken.account.keys.limitHint')}
						</p>
						<div className='space-y-2'>
							<Label htmlFor='key-expiry'>
								{t('cinatoken.account.keys.expiresAt')}
							</Label>
							<Input
								id='key-expiry'
								type='datetime-local'
								aria-invalid={Boolean(errors.expiresAt)}
								aria-describedby={
									errors.expiresAt ? 'key-expiry-error' : 'key-expiry-hint'
								}
								{...form.register('expiresAt')}
							/>
							{errors.expiresAt && (
								<p id='key-expiry-error' className='text-destructive text-xs'>
									{t(
										errors.expiresAt.message ??
											'cinatoken.account.keys.expiryInvalid'
									)}
								</p>
							)}
							<p id='key-expiry-hint' className='text-muted-foreground text-xs'>
								{t('cinatoken.account.keys.expiryHint')}
							</p>
						</div>
					</fieldset>
					{props.error && (
						<p
							role='alert'
							className='text-destructive border-destructive/20 bg-destructive/5 rounded-lg border p-3 text-sm'
						>
							{t('cinatoken.account.keys.createFailed')}
						</p>
					)}
					<DialogFooter>
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
									? 'cinatoken.account.keys.creating'
									: 'cinatoken.account.keys.create'
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
