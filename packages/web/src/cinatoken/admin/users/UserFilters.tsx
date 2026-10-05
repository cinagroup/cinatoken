/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	userOrderSchema,
	userSortSchema,
	type UsersSearch,
} from './users-search'

const prefix = 'cinatoken.adminUsers.'
const sortLabels: Record<UsersSearch['sort'], string> = {
	created_at: 'sortCreated',
	budget_spent: 'sortSpent',
	budget_max: 'sortMax',
	budget_base: 'sortBase',
	budget_reset_at: 'sortReset',
}

export function UserFilters(props: {
	search: UsersSearch
	currency: 'USD' | 'CNY' | null
	currencySource: 'configured' | 'missing' | null
	onChange: (next: UsersSearch) => void
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState({
		email: props.search.email,
		external_system: props.search.external_system,
		external_user_id: props.search.external_user_id,
		status: props.search.status,
		max_budget: props.search.max_budget,
	})
	function update(patch: Partial<UsersSearch>): void {
		props.onChange({ ...props.search, ...patch, page: 1 })
	}
	return (
		<>
			<form
				className='bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-5'
				onSubmit={(event) => {
					event.preventDefault()
					update({
						email: draft.email.trim(),
						external_system: draft.external_system.trim(),
						external_user_id: draft.external_user_id.trim(),
						status: draft.status,
						max_budget: draft.max_budget,
					})
				}}
			>
				<div className='space-y-1'>
					<Label htmlFor='user-filter-email'>{t(prefix + 'email')}</Label>
					<Input
						id='user-filter-email'
						value={draft.email}
						onChange={(event) =>
							setDraft({ ...draft, email: event.target.value })
						}
					/>
				</div>
				<div className='space-y-1'>
					<Label htmlFor='user-filter-system'>
						{t(prefix + 'externalSystem')}
					</Label>
					<Input
						id='user-filter-system'
						value={draft.external_system}
						onChange={(event) =>
							setDraft({ ...draft, external_system: event.target.value })
						}
					/>
				</div>
				<div className='space-y-1'>
					<Label htmlFor='user-filter-external-id'>
						{t(prefix + 'externalUserId')}
					</Label>
					<Input
						id='user-filter-external-id'
						value={draft.external_user_id}
						onChange={(event) =>
							setDraft({ ...draft, external_user_id: event.target.value })
						}
					/>
				</div>
				<div className='space-y-1'>
					<Label htmlFor='user-filter-status'>{t(prefix + 'status')}</Label>
					<select
						id='user-filter-status'
						className='bg-background w-full rounded-md border px-3 py-2 text-sm'
						value={draft.status}
						onChange={(event) =>
							setDraft({
								...draft,
								status: event.target.value as UsersSearch['status'],
							})
						}
					>
						{(['all', 'active', 'disabled'] as const).map((status) => (
							<option key={status} value={status}>
								{t(prefix + status)}
							</option>
						))}
					</select>
				</div>
				<div className='space-y-1'>
					<Label htmlFor='user-filter-budget'>
						{t(prefix + 'maxBudgetFilter')}
					</Label>
					<select
						id='user-filter-budget'
						className='bg-background w-full rounded-md border px-3 py-2 text-sm'
						value={draft.max_budget}
						onChange={(event) =>
							setDraft({
								...draft,
								max_budget: event.target.value as UsersSearch['max_budget'],
							})
						}
					>
						<option value='all'>{t(prefix + 'all')}</option>
						<option value='positive'>{t(prefix + 'maxBudgetPositive')}</option>
						<option value='zero_or_negative'>
							{t(prefix + 'maxBudgetZero')}
						</option>
						<option value='null'>{t(prefix + 'maxBudgetNull')}</option>
					</select>
				</div>
				<div className='flex flex-wrap items-end gap-2 sm:col-span-2 lg:col-span-5'>
					<Button type='submit'>{t(prefix + 'apply')}</Button>
					<Button
						type='button'
						variant='outline'
						onClick={() =>
							props.onChange({
								page: 1,
								email: '',
								external_system: '',
								external_user_id: '',
								status: 'all',
								max_budget: 'all',
								sort: 'created_at',
								order: 'desc',
							})
						}
					>
						{t(prefix + 'clear')}
					</Button>
				</div>
			</form>
			<div className='flex flex-wrap items-end gap-3'>
				<div className='space-y-1'>
					<Label htmlFor='user-sort'>{t(prefix + 'sort')}</Label>
					<select
						id='user-sort'
						className='bg-background w-full rounded-md border px-3 py-2 text-sm'
						value={props.search.sort}
						onChange={(event) =>
							update({ sort: userSortSchema.parse(event.target.value) })
						}
					>
						{userSortSchema.options.map((sort) => (
							<option key={sort} value={sort}>
								{t(prefix + sortLabels[sort])}
							</option>
						))}
					</select>
				</div>
				<div className='space-y-1'>
					<Label htmlFor='user-order'>{t(prefix + 'order')}</Label>
					<select
						id='user-order'
						className='bg-background w-full rounded-md border px-3 py-2 text-sm'
						value={props.search.order}
						onChange={(event) =>
							update({ order: userOrderSchema.parse(event.target.value) })
						}
					>
						{userOrderSchema.options.map((order) => (
							<option key={order} value={order}>
								{t(prefix + (order === 'asc' ? 'ascending' : 'descending'))}
							</option>
						))}
					</select>
				</div>
				{props.currency ? (
					<p className='text-muted-foreground pb-2 text-sm'>
						{t(
							prefix +
								(props.currencySource === 'missing'
									? 'currencyFallback'
									: 'currency'),
							{ currency: props.currency }
						)}
					</p>
				) : (
					<p role='status' className='text-muted-foreground pb-2 text-sm'>
						{t(prefix + 'currencyUnavailable')}
					</p>
				)}
			</div>
		</>
	)
}
