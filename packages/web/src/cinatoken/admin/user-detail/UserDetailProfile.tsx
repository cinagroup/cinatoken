/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { UserDetail } from './user-detail-contracts'
import { draftFromUser, type UserDetailDraft } from './user-detail-domain'

const prefix = 'cinatoken.adminUserDetail.'
type Currency = 'USD' | 'CNY' | null
export function UserDetailProfile(props: {
	user: UserDetail
	currency: Currency
	canWrite: boolean
	busy: boolean
	onSave: (draft: UserDetailDraft) => Promise<void>
	onDelete: () => Promise<void>
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState(() => draftFromUser(props.user))
	function update<K extends keyof UserDetailDraft>(
		key: K,
		value: UserDetailDraft[K]
	): void {
		setDraft((before) => ({ ...before, [key]: value }))
	}
	function field(
		key: 'email' | 'externalSystem' | 'externalUserId',
		label: string
	) {
		return (
			<label className='block space-y-1 text-sm'>
				<span>{label}</span>
				<input
					className='bg-background w-full rounded-md border px-3 py-2'
					value={draft[key]}
					onChange={(event) => update(key, event.target.value)}
					disabled={!props.canWrite}
				/>
			</label>
		)
	}
	function amount(
		key: 'budgetMax' | 'budgetBase' | 'budgetSpent',
		label: string
	) {
		return (
			<label className='block space-y-1 text-sm'>
				<span>
					{label} ({props.currency})
				</span>
				<input
					className='bg-background w-full rounded-md border px-3 py-2 tabular-nums'
					inputMode='decimal'
					value={draft[key]}
					onChange={(event) => update(key, event.target.value)}
					disabled={!props.canWrite}
				/>
			</label>
		)
	}
	const knownStatus =
		props.user.status === 'active' || props.user.status === 'disabled'
	return (
		<section className='bg-card space-y-5 rounded-xl border p-4 sm:p-6'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<h2 className='text-lg font-semibold'>
					{t(prefix + 'profile')} / {t(prefix + 'budget')}
				</h2>
				<span className='text-muted-foreground font-mono text-xs break-all'>
					{props.user.id}
				</span>
			</div>
			<div className='grid gap-4 md:grid-cols-2'>
				{field('email', t(prefix + 'email'))}
				<label className='block space-y-1 text-sm'>
					<span>{t(prefix + 'status')}</span>
					{knownStatus ? (
						<select
							className='bg-background w-full rounded-md border px-3 py-2'
							value={draft.status}
							onChange={(event) => update('status', event.target.value)}
							disabled={!props.canWrite}
						>
							<option value='active'>{t(prefix + 'active')}</option>
							<option value='disabled'>{t(prefix + 'disabled')}</option>
						</select>
					) : (
						<p className='rounded-md border px-3 py-2'>{props.user.status}</p>
					)}
				</label>
				{field('externalSystem', t(prefix + 'externalSystem'))}
				{field('externalUserId', t(prefix + 'externalId'))}
			</div>
			<label className='block space-y-1 text-sm'>
				<span>{t(prefix + 'metadata')}</span>
				<textarea
					className='bg-background min-h-28 w-full rounded-md border px-3 py-2 font-mono text-xs'
					value={draft.metadata}
					onChange={(event) => update('metadata', event.target.value)}
					disabled={!props.canWrite}
				/>
			</label>
			{props.currency ? (
				<div className='space-y-4 border-t pt-4'>
					<div className='grid gap-4 md:grid-cols-3'>
						{amount('budgetMax', t(prefix + 'max'))}
						{amount('budgetBase', t(prefix + 'base'))}
						{amount('budgetSpent', t(prefix + 'spent'))}
					</div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'spentEpoch')}
					</p>
					<div className='grid gap-4 md:grid-cols-2'>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'period')}</span>
							<select
								className='bg-background w-full rounded-md border px-3 py-2'
								value={draft.budgetPeriod}
								onChange={(event) =>
									update(
										'budgetPeriod',
										event.target.value as UserDetailDraft['budgetPeriod']
									)
								}
								disabled={!props.canWrite}
							>
								<option value='none'>{t(prefix + 'periodNone')}</option>
								<option value='daily'>{t(prefix + 'periodDaily')}</option>
								<option value='weekly'>{t(prefix + 'periodWeekly')}</option>
								<option value='monthly'>{t(prefix + 'periodMonthly')}</option>
							</select>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'resetAt')}</span>
							<input
								className='bg-background w-full rounded-md border px-3 py-2 dark:[color-scheme:dark]'
								type='datetime-local'
								step='1'
								value={draft.budgetResetAt}
								onChange={(event) =>
									update('budgetResetAt', event.target.value)
								}
								disabled={!props.canWrite}
							/>
						</label>
					</div>
					<label className='flex items-start gap-2 text-sm'>
						<input
							type='checkbox'
							checked={draft.resetBudget}
							onChange={(event) => update('resetBudget', event.target.checked)}
							disabled={!props.canWrite}
						/>
						<span>{t(prefix + 'resetBudget')}</span>
					</label>
				</div>
			) : (
				<p
					role='status'
					className='text-muted-foreground rounded-md border p-3 text-sm'
				>
					{t(prefix + 'currencyUnavailable')}
				</p>
			)}
			<div className='flex flex-wrap justify-between gap-3 border-t pt-4'>
				<Button
					type='button'
					onClick={() => void props.onSave(draft)}
					disabled={!props.canWrite || props.busy}
				>
					{props.busy ? t(prefix + 'saving') : t(prefix + 'save')}
				</Button>
				<Button
					type='button'
					variant='destructive'
					disabled={!props.canWrite || props.busy}
					onClick={() => {
						if (window.confirm(t(prefix + 'deleteUserConfirm')))
							void props.onDelete()
					}}
				>
					{t(prefix + 'deleteUser')}
				</Button>
			</div>
		</section>
	)
}
