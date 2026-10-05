/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { z } from 'zod'
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
import type { GatewayKeyRow } from './gateway-key-contracts'

const prefix = 'cinatoken.adminGatewayKeys.'
const schema = z.object({
	reason: z
		.string()
		.trim()
		.min(1)
		.max(600)
		.refine((value) => !/\p{Cc}/u.test(value)),
})
export type GatewayKeyConfirmation = {
	row: GatewayKeyRow
	kind: 'tombstone' | 'activate' | 'revoke'
}
export function GatewayKeyConfirmDialog(props: {
	confirmation: GatewayKeyConfirmation
	busy: boolean
	canWrite: boolean
	error: string | null
	onClose: () => void
	onConfirm: (reason: string) => Promise<void>
}) {
	const { t } = useTranslation()
	const formId = useId()
	const form = useForm<z.infer<typeof schema>>({
		resolver: zodResolver(schema),
		defaultValues: { reason: '' },
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.busy) props.onClose()
			}}
		>
			<DialogContent showCloseButton={false} className='sm:max-w-lg'>
				<DialogTitle>{t(prefix + props.confirmation.kind)}</DialogTitle>
				<DialogDescription>
					{t(
						prefix +
							(props.confirmation.kind === 'tombstone'
								? 'tombstoneHint'
								: 'statusHint')
					)}
				</DialogDescription>
				<p className='text-sm break-all'>
					{props.confirmation.row.name ?? props.confirmation.row.id}
				</p>
				<form
					className='space-y-4'
					onSubmit={form.handleSubmit((value) => props.onConfirm(value.reason))}
				>
					{props.error && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + props.error)}
						</p>
					)}
					<div className='space-y-1 text-sm'>
						<label className='block' htmlFor={formId + '-reason'}>
							{t(prefix + 'reason')}
						</label>
						<input
							id={formId + '-reason'}
							className='bg-background w-full rounded-md border px-3 py-2'
							maxLength={600}
							disabled={props.busy}
							aria-invalid={Boolean(form.formState.errors.reason)}
							aria-describedby={
								form.formState.errors.reason
									? formId + '-reason-error'
									: undefined
							}
							{...form.register('reason')}
						/>
						{form.formState.errors.reason && (
							<span
								id={formId + '-reason-error'}
								role='alert'
								className='text-destructive text-xs'
							>
								{t(prefix + 'invalidInput')}
							</span>
						)}
					</div>
					<div className='flex justify-end gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={props.busy}
							onClick={props.onClose}
						>
							{t(prefix + 'cancel')}
						</Button>
						<Button type='submit' disabled={props.busy || !props.canWrite}>
							{t(prefix + (props.busy ? 'saving' : 'confirm'))}
						</Button>
					</div>
				</form>
			</DialogContent>
		</Dialog>
	)
}
