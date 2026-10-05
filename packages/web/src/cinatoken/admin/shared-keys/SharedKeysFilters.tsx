/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import type { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	sharedKeyChannelSchema,
	sharedKeyStatusSchema,
} from '../../shared-key-contracts'
import {
	adminSharedKeySearchSchema,
	validateAdminSharedKeySearch,
	type AdminSharedKeySearch,
} from './shared-key-search'

const prefix = 'cinatoken.adminSharedKeys.'
const schema = adminSharedKeySearchSchema.omit({ page: true })
export function SharedKeysFilters(props: {
	search: AdminSharedKeySearch
	disabled: boolean
	onChange: (search: AdminSharedKeySearch) => void
}) {
	const { t } = useTranslation()
	const id = useId()
	const form = useForm<
		z.input<typeof schema>,
		unknown,
		z.output<typeof schema>
	>({
		resolver: zodResolver(schema),
		defaultValues: {
			status: props.search.status,
			channelType: props.search.channelType,
			seller_user_id: props.search.seller_user_id,
			search: props.search.search,
		},
	})
	return (
		<form
			className='grid items-end gap-3 rounded-xl border p-4 sm:grid-cols-2 xl:grid-cols-5'
			onSubmit={form.handleSubmit((values) =>
				props.onChange({ ...values, page: 1 })
			)}
		>
			{(['status', 'channelType'] as const).map((field) => (
				<div key={field} className='space-y-1 text-sm'>
					<label className='block' htmlFor={id + field}>
						{t(prefix + (field === 'status' ? 'status' : 'channel'))}
					</label>
					<select
						id={id + field}
						className='bg-background w-full rounded-md border px-3 py-2'
						disabled={props.disabled}
						{...form.register(field)}
					>
						<option value=''>{t(prefix + 'all')}</option>
						{(field === 'status'
							? sharedKeyStatusSchema.options
							: sharedKeyChannelSchema.options
						).map((option) => (
							<option key={option} value={option}>
								{field === 'status' ? t(prefix + 'status_' + option) : option}
							</option>
						))}
					</select>
				</div>
			))}
			{(['seller_user_id', 'search'] as const).map((field) => (
				<div key={field} className='space-y-1 text-sm'>
					<label className='block' htmlFor={id + field}>
						{t(prefix + (field === 'search' ? 'search' : 'sellerId'))}
					</label>
					<input
						id={id + field}
						className='bg-background w-full rounded-md border px-3 py-2'
						maxLength={field === 'search' ? 200 : 255}
						disabled={props.disabled}
						aria-invalid={Boolean(form.formState.errors[field])}
						aria-describedby={
							form.formState.errors[field] ? id + field + '-error' : undefined
						}
						{...form.register(field)}
					/>
					{form.formState.errors[field] && (
						<p
							id={id + field + '-error'}
							role='alert'
							className='text-destructive text-xs'
						>
							{t(prefix + 'invalidInput')}
						</p>
					)}
				</div>
			))}
			<div className='flex flex-wrap gap-2'>
				<Button type='submit' disabled={props.disabled}>
					{t(prefix + 'applyFilters')}
				</Button>
				<Button
					type='button'
					variant='outline'
					disabled={props.disabled}
					onClick={() => props.onChange(validateAdminSharedKeySearch({}))}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</div>
		</form>
	)
}
