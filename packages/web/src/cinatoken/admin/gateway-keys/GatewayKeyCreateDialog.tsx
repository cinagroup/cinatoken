/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from '@/components/ui/dialog'
import {
	gatewayKeyCreateFormSchema,
	type GatewayKeyCreateForm,
} from './gateway-key-input'

const prefix = 'cinatoken.adminGatewayKeys.'
const inputClass = 'bg-background w-full rounded-md border px-3 py-2 text-sm'
export function GatewayKeyCreateDialog(props: {
	busy: boolean
	canWrite: boolean
	error: string | null
	onClose: () => void
	onCreate: (draft: GatewayKeyCreateForm) => Promise<void>
}) {
	const { t } = useTranslation()
	const formId = useId()
	const form = useForm<GatewayKeyCreateForm>({
		resolver: zodResolver(gatewayKeyCreateFormSchema),
		defaultValues: {
			mode: 'existing',
			userId: '',
			email: '',
			externalSystem: '',
			externalUserId: '',
			name: '',
			metadata: '',
			reason: '',
		},
	})
	const mode = form.watch('mode')
	const fields: Array<
		[
			(
				| 'userId'
				| 'email'
				| 'externalSystem'
				| 'externalUserId'
				| 'name'
				| 'reason'
			),
			string,
			number,
		]
	> =
		mode === 'existing'
			? [
					['userId', 'userId', 600],
					['name', 'name', 255],
					['reason', 'reason', 600],
				]
			: [
					['externalSystem', 'externalSystem', 600],
					['externalUserId', 'externalUserId', 600],
					['email', 'email', 320],
					['name', 'name', 255],
					['reason', 'reason', 600],
				]
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg'
			>
				<DialogTitle>{t(prefix + 'createTitle')}</DialogTitle>
				<DialogDescription>{t(prefix + 'createHint')}</DialogDescription>
				<form
					className='space-y-4'
					onSubmit={form.handleSubmit(props.onCreate)}
				>
					{props.error && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + props.error)}
						</p>
					)}
					<fieldset disabled={props.busy} className='space-y-2'>
						<legend className='text-sm font-medium'>
							{t(prefix + 'ownership')}
						</legend>
						{(['existing', 'external'] as const).map((value) => (
							<label
								key={value}
								className='mr-4 inline-flex items-center gap-2 text-sm'
							>
								<input type='radio' value={value} {...form.register('mode')} />
								{t(prefix + value)}
							</label>
						))}
					</fieldset>
					{mode === 'external' && (
						<p className='bg-muted rounded-md p-3 text-sm'>
							{t(prefix + 'externalHint')}
						</p>
					)}
					{fields.map(([field, label, max]) => (
						<div key={field} className='space-y-1 text-sm'>
							<label className='block' htmlFor={formId + '-' + field}>
								{t(prefix + label)}
							</label>
							<input
								id={formId + '-' + field}
								className={inputClass}
								maxLength={max}
								disabled={props.busy}
								aria-invalid={Boolean(form.formState.errors[field])}
								aria-describedby={
									form.formState.errors[field]
										? formId + '-' + field + '-error'
										: undefined
								}
								{...form.register(field)}
							/>
							{form.formState.errors[field] && (
								<span
									id={formId + '-' + field + '-error'}
									role='alert'
									className='text-destructive block text-xs'
								>
									{t(prefix + 'invalidInput')}
								</span>
							)}
						</div>
					))}
					<div className='space-y-1 text-sm'>
						<label className='block' htmlFor={formId + '-metadata'}>
							{t(prefix + 'metadataJson')}
						</label>
						<textarea
							id={formId + '-metadata'}
							rows={4}
							className={inputClass + ' font-mono text-xs'}
							maxLength={65_536}
							disabled={props.busy}
							aria-invalid={Boolean(form.formState.errors.metadata)}
							aria-describedby={
								form.formState.errors.metadata
									? formId + '-metadata-error'
									: undefined
							}
							{...form.register('metadata')}
						/>
						{form.formState.errors.metadata && (
							<span
								id={formId + '-metadata-error'}
								role='alert'
								className='text-destructive block text-xs'
							>
								{t(prefix + 'metadataInvalid')}
							</span>
						)}
					</div>
					<div className='flex justify-end gap-2 border-t pt-3'>
						<Button
							type='button'
							variant='outline'
							disabled={props.busy}
							onClick={props.onClose}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button type='submit' disabled={!props.canWrite || props.busy}>
							{t(prefix + (props.busy ? 'saving' : 'createSubmit'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
