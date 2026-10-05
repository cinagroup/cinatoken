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
import {
	managementKeyFormSchema,
	type ManagementKeyForm,
} from './management-key-form-schema'

type Props = {
	scopeName: string
	isPending: boolean
	error: boolean
	onClose: () => void
	onSubmit: (values: ManagementKeyForm) => void
}

export function ManagementKeyCreateDialog(props: Props) {
	const { t } = useTranslation()
	const form = useForm<ManagementKeyForm>({
		resolver: zodResolver(managementKeyFormSchema),
		defaultValues: { name: '', expiresAt: '' },
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
					<DialogTitle>
						{t('cinatoken.account.managementKeys.create')}
					</DialogTitle>
					<DialogDescription>
						{t('cinatoken.account.managementKeys.createIn', {
							name: props.scopeName,
						})}
					</DialogDescription>
				</DialogHeader>
				<form
					onSubmit={form.handleSubmit(props.onSubmit)}
					className='space-y-5'
				>
					<fieldset disabled={props.isPending} className='space-y-5'>
						<div className='space-y-2'>
							<Label htmlFor='management-key-name'>
								{t('cinatoken.account.managementKeys.name')}
							</Label>
							<Input
								id='management-key-name'
								autoFocus
								maxLength={128}
								placeholder={t(
									'cinatoken.account.managementKeys.namePlaceholder'
								)}
								aria-invalid={Boolean(errors.name)}
								aria-describedby={
									errors.name ? 'management-key-name-error' : undefined
								}
								{...form.register('name')}
							/>
							{errors.name && (
								<p
									id='management-key-name-error'
									className='text-destructive text-xs'
								>
									{t(
										errors.name.message ??
											'cinatoken.account.managementKeys.nameRequired'
									)}
								</p>
							)}
						</div>
						<div className='space-y-2'>
							<Label htmlFor='management-key-expiry'>
								{t('cinatoken.account.keys.expiresAt')}
							</Label>
							<Input
								id='management-key-expiry'
								type='datetime-local'
								aria-invalid={Boolean(errors.expiresAt)}
								aria-describedby={
									errors.expiresAt
										? 'management-key-expiry-error'
										: 'management-key-expiry-hint'
								}
								{...form.register('expiresAt')}
							/>
							{errors.expiresAt && (
								<p
									id='management-key-expiry-error'
									className='text-destructive text-xs'
								>
									{t(
										errors.expiresAt.message ??
											'cinatoken.account.keys.expiryInvalid'
									)}
								</p>
							)}
							<p
								id='management-key-expiry-hint'
								className='text-muted-foreground text-xs'
							>
								{t('cinatoken.account.keys.expiryHint')}
							</p>
						</div>
						<p className='bg-muted/30 text-muted-foreground rounded-lg border p-3 text-sm'>
							{t('cinatoken.account.managementKeys.accessHint')}
						</p>
					</fieldset>
					{props.error && (
						<p
							role='alert'
							className='border-destructive/20 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm'
						>
							{t('cinatoken.account.managementKeys.createFailed')}
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
									? 'cinatoken.account.managementKeys.creating'
									: 'cinatoken.account.managementKeys.create'
							)}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
