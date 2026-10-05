/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	gatewayKeySearchSchema,
	type GatewayKeySearch,
} from './gateway-key-search'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeysFilters(props: {
	search: GatewayKeySearch
	currency: string | null
	onChange: (search: GatewayKeySearch) => void
}) {
	const { t } = useTranslation()
	const form = useForm<
		z.input<typeof gatewayKeySearchSchema>,
		unknown,
		GatewayKeySearch
	>({
		resolver: zodResolver(gatewayKeySearchSchema),
		defaultValues: props.search,
	})
	return (
		<form
			className='grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_auto_auto_auto]'
			onSubmit={form.handleSubmit((value) =>
				props.onChange({ ...value, page: 1 })
			)}
		>
			{(['email', 'user_id'] as const).map((field) => (
				<label key={field} className='space-y-1 text-sm'>
					<span>{t(prefix + (field === 'email' ? 'email' : 'userId'))}</span>
					<input
						className='bg-background w-full rounded-md border px-3 py-2'
						maxLength={field === 'email' ? 320 : 600}
						{...form.register(field)}
					/>
					{form.formState.errors[field] && (
						<span role='alert' className='text-destructive block text-xs'>
							{t(prefix + 'invalidInput')}
						</span>
					)}
				</label>
			))}
			<label className='space-y-1 text-sm'>
				<span>{t(prefix + 'sort')}</span>
				<select
					className='bg-background w-full rounded-md border px-3 py-2'
					{...form.register('sort')}
				>
					<option value='created_at'>{t(prefix + 'created')}</option>
					<option value='budget_spent' disabled={props.currency === null}>
						{t(prefix + 'budgetSpent')}
					</option>
					<option value='budget_reset_at' disabled={props.currency === null}>
						{t(prefix + 'budgetReset')}
					</option>
				</select>
			</label>
			<label className='space-y-1 text-sm'>
				<span>{t(prefix + 'order')}</span>
				<select
					className='bg-background w-full rounded-md border px-3 py-2'
					{...form.register('order')}
				>
					<option value='desc'>{t(prefix + 'descending')}</option>
					<option value='asc'>{t(prefix + 'ascending')}</option>
				</select>
			</label>
			<div className='flex flex-wrap items-end gap-2'>
				<Button type='submit'>{t(prefix + 'applyFilters')}</Button>
				<Button
					type='button'
					variant='outline'
					onClick={() =>
						props.onChange({ ...props.search, page: 1, email: '', user_id: '' })
					}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</div>
		</form>
	)
}
