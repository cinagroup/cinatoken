/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { SharedKeyApprovalFields } from './SharedKeyApprovalFields'
import type { AdminSharedKeyRow } from './shared-key-contracts'
import {
	adminSharedKeyEditSchema,
	adminSharedKeyEditInput,
	type AdminSharedKeyEditForm,
	type AdminSharedKeyPatch,
} from './shared-key-input'

const prefix = 'cinatoken.adminSharedKeys.'
export function SharedKeyEditor(props: {
	row: AdminSharedKeyRow
	busy: boolean
	canWrite: boolean
	error: string | null
	onCancel: () => void
	onSave: (input: AdminSharedKeyPatch) => Promise<void>
}) {
	const { t } = useTranslation()
	const id = useId()
	const form = useForm<AdminSharedKeyEditForm>({
		resolver: zodResolver(adminSharedKeyEditSchema),
		defaultValues: {
			sellerPriority: props.row.sellerPriority,
			weight: props.row.weight,
			reason: '',
			reviewed: false,
		},
	})
	return (
		<form
			className='space-y-4'
			onSubmit={form.handleSubmit(async (draft) => {
				try {
					const input = adminSharedKeyEditInput(props.row, draft)
					await props.onSave(input)
				} catch {
					form.setError('root', { message: 'invalidInput' })
				}
			})}
		>
			<p className='text-muted-foreground text-sm'>{t(prefix + 'editHint')}</p>
			<div className='grid gap-4 sm:grid-cols-2'>
				{(['sellerPriority', 'weight'] as const).map((field) => (
					<div key={field} className='space-y-1 text-sm'>
						<label htmlFor={id + '-' + field} className='block'>
							{t(prefix + (field === 'sellerPriority' ? 'priority' : 'weight'))}
						</label>
						<input
							id={id + '-' + field}
							type='number'
							step='1'
							min={field === 'weight' ? 1 : -2_147_483_648}
							max={field === 'weight' ? 100 : 2_147_483_647}
							className='bg-background w-full rounded-md border px-3 py-2'
							disabled={props.busy}
							aria-invalid={Boolean(form.formState.errors[field])}
							aria-describedby={
								form.formState.errors[field]
									? id + '-' + field + '-error'
									: undefined
							}
							{...form.register(field, { valueAsNumber: true })}
						/>
						{form.formState.errors[field] && (
							<p
								id={id + '-' + field + '-error'}
								role='alert'
								className='text-destructive text-xs'
							>
								{t(prefix + 'invalidInput')}
							</p>
						)}
					</div>
				))}
			</div>
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
				<Button type='submit' disabled={props.busy || !props.canWrite}>
					{t(prefix + (props.busy ? 'saving' : 'save'))}
				</Button>
			</div>
		</form>
	)
}
