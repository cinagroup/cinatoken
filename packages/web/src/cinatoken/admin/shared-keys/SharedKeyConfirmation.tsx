/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SharedKeyApprovalFields } from './SharedKeyApprovalFields'
import type { AdminSharedKeyRow } from './shared-key-contracts'
import {
	adminSharedKeyConfirmationSchema,
	adminSharedKeyConfirmationInput,
	type AdminSharedKeyConfirmationForm,
	type AdminSharedKeyPatch,
} from './shared-key-input'

const prefix = 'cinatoken.adminSharedKeys.'
export type SharedKeyConfirmationKind = 'disable' | 'restore' | 'delete'
export function SharedKeyConfirmation(props: {
	row: AdminSharedKeyRow
	kind: SharedKeyConfirmationKind
	busy: boolean
	canWrite: boolean
	error: string | null
	onCancel: () => void
	onConfirm: (input: AdminSharedKeyPatch) => Promise<void>
}) {
	const { t } = useTranslation()
	const form = useForm<AdminSharedKeyConfirmationForm>({
		resolver: zodResolver(adminSharedKeyConfirmationSchema),
		defaultValues: { reason: '', reviewed: false },
	})
	return (
		<form
			className='space-y-4'
			onSubmit={form.handleSubmit(async (draft) => {
				try {
					const input = adminSharedKeyConfirmationInput(
						props.row,
						props.kind,
						draft
					)
					await props.onConfirm(input)
				} catch {
					form.setError('root', { message: 'invalidInput' })
				}
			})}
		>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + props.kind + 'Hint')}
			</p>
			<SharedKeyApprovalFields
				reason={form.register('reason')}
				reviewed={form.register('reviewed')}
				reasonError={Boolean(form.formState.errors.reason)}
				reviewedError={Boolean(form.formState.errors.reviewed)}
				disabled={props.busy}
			/>
			{(props.error || form.formState.errors.root) && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + (props.error ?? 'invalidInput'))}
				</p>
			)}
			<div className='flex flex-wrap justify-end gap-2'>
				<Button
					type='button'
					variant='outline'
					disabled={props.busy}
					onClick={props.onCancel}
				>
					{t(prefix + 'cancel')}
				</Button>
				<Button
					type='submit'
					variant={props.kind === 'delete' ? 'destructive' : 'default'}
					disabled={props.busy || !props.canWrite}
				>
					{t(prefix + (props.busy ? 'saving' : 'confirm'))}
				</Button>
			</div>
		</form>
	)
}
