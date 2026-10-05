/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
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
import { Textarea } from '@/components/ui/textarea'
import { userWriteErrorKey } from './users-errors'
import {
	emptyUserCreateDraft,
	userCreateDraftSchema,
	type UserCreateDraft,
} from './users-input'

const prefix = 'cinatoken.adminUsers.'

export function UserCreateDialog(props: {
	currency: 'USD' | 'CNY' | null
	pending: boolean
	disabled: boolean
	error: unknown
	onSubmit: (draft: UserCreateDraft) => Promise<boolean>
	onClose: () => void
}) {
	const { t } = useTranslation()
	const form = useForm<UserCreateDraft>({
		resolver: zodResolver(userCreateDraftSchema),
		defaultValues: emptyUserCreateDraft,
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
					<DialogTitle>{t(prefix + 'createTitle')}</DialogTitle>
					<DialogDescription>{t(prefix + 'createHint')}</DialogDescription>
				</DialogHeader>
				<form
					className='space-y-5'
					onSubmit={form.handleSubmit(async (draft) => {
						if (await props.onSubmit(draft)) props.onClose()
					})}
				>
					<fieldset
						disabled={props.pending || props.disabled}
						className='space-y-5'
					>
						<div className='space-y-2'>
							<Label htmlFor='admin-user-email'>{t(prefix + 'email')}</Label>
							<Input
								id='admin-user-email'
								type='email'
								autoComplete='email'
								required
								{...form.register('email')}
							/>
						</div>
						<div className='grid gap-4 sm:grid-cols-2'>
							<div className='space-y-2'>
								<Label htmlFor='admin-user-external-system'>
									{t(prefix + 'externalSystem')}
								</Label>
								<Input
									id='admin-user-external-system'
									autoComplete='off'
									{...form.register('externalSystem')}
								/>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='admin-user-external-id'>
									{t(prefix + 'externalUserId')}
								</Label>
								<Input
									id='admin-user-external-id'
									autoComplete='off'
									{...form.register('externalUserId')}
								/>
							</div>
						</div>
						{props.currency ? (
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'currency', { currency: props.currency })}
							</p>
						) : (
							<p role='status' className='text-muted-foreground text-sm'>
								{t(prefix + 'currencyUnavailable')}
							</p>
						)}
						<div className='grid gap-4 sm:grid-cols-3'>
							<div className='space-y-2'>
								<Label htmlFor='admin-user-budget-max'>
									{t(prefix + 'budgetMax')}
								</Label>
								<Input
									id='admin-user-budget-max'
									inputMode='decimal'
									disabled={!props.currency}
									{...form.register('budgetMax')}
								/>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='admin-user-budget-base'>
									{t(prefix + 'budgetBase')}
								</Label>
								<Input
									id='admin-user-budget-base'
									inputMode='decimal'
									disabled={!props.currency}
									{...form.register('budgetBase')}
								/>
							</div>
							<div className='space-y-2'>
								<Label htmlFor='admin-user-budget-period'>
									{t(prefix + 'period')}
								</Label>
								<select
									id='admin-user-budget-period'
									className='bg-background w-full rounded-md border px-3 py-2 text-sm'
									disabled={!props.currency}
									{...form.register('budgetPeriod')}
								>
									{(['none', 'daily', 'weekly', 'monthly'] as const).map(
										(period) => (
											<option key={period} value={period}>
												{t(
													prefix +
														'period' +
														period[0].toUpperCase() +
														period.slice(1)
												)}
											</option>
										)
									)}
								</select>
							</div>
						</div>
						<div className='space-y-2'>
							<Label htmlFor='admin-user-metadata'>
								{t(prefix + 'metadataJson')}
							</Label>
							<Textarea
								id='admin-user-metadata'
								rows={4}
								className='font-mono text-xs'
								{...form.register('metadata')}
							/>
						</div>
					</fieldset>
					{Object.keys(form.formState.errors).length > 0 && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + 'invalidInput')}
						</p>
					)}
					{Boolean(props.error) && (
						<p role='alert' className='text-destructive text-sm'>
							{t(
								prefix +
									(props.error instanceof Error &&
									props.error.message === 'currency-unavailable'
										? 'currencyUnavailable'
										: userWriteErrorKey(props.error))
							)}
						</p>
					)}
					<div className='flex flex-wrap justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={props.pending}
							onClick={props.onClose}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button type='submit' disabled={props.pending || props.disabled}>
							{t(prefix + (props.pending ? 'saving' : 'create'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
