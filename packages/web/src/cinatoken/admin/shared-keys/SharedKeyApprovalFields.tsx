/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import type { UseFormRegisterReturn } from 'react-hook-form'
import { useTranslation } from 'react-i18next'

const prefix = 'cinatoken.adminSharedKeys.'
export function SharedKeyApprovalFields(props: {
	reason: UseFormRegisterReturn<'reason'>
	reviewed: UseFormRegisterReturn<'reviewed'>
	reasonError: boolean
	reviewedError: boolean
	disabled: boolean
}) {
	const { t } = useTranslation()
	const id = useId()
	return (
		<>
			<div className='space-y-1 text-sm'>
				<label className='block' htmlFor={id + '-reason'}>
					{t(prefix + 'reason')}
				</label>
				<input
					id={id + '-reason'}
					className='bg-background w-full rounded-md border px-3 py-2'
					maxLength={600}
					disabled={props.disabled}
					aria-invalid={props.reasonError}
					aria-describedby={
						props.reasonError ? id + '-reason-error' : undefined
					}
					{...props.reason}
				/>
				{props.reasonError && (
					<p
						id={id + '-reason-error'}
						role='alert'
						className='text-destructive text-xs'
					>
						{t(prefix + 'invalidInput')}
					</p>
				)}
			</div>
			<div className='space-y-1 text-sm'>
				<div className='flex items-start gap-2'>
					<input
						id={id + '-reviewed'}
						type='checkbox'
						className='mt-1 shrink-0'
						disabled={props.disabled}
						aria-invalid={props.reviewedError}
						aria-describedby={
							props.reviewedError ? id + '-reviewed-error' : undefined
						}
						{...props.reviewed}
					/>
					<label htmlFor={id + '-reviewed'}>
						{t(prefix + 'reviewConfirmation')}
					</label>
				</div>
				{props.reviewedError && (
					<p
						id={id + '-reviewed-error'}
						role='alert'
						className='text-destructive text-xs'
					>
						{t(prefix + 'invalidInput')}
					</p>
				)}
			</div>
		</>
	)
}
