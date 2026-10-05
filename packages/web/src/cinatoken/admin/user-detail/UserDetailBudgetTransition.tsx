/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import type {
	UserBudgetTransitionInput,
	UserBudgetTransitionPreview,
	UserDetail,
} from './user-detail-contracts'
import { UserDetailInputError } from './user-detail-domain'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from './user-detail-format'
import {
	buildBudgetTransitionInput,
	type BudgetTransitionDraft,
} from './user-detail-transition-domain'
import { BudgetTransitionPersistenceError } from './user-detail-transition-recovery'

const prefix = 'cinatoken.adminUserDetail.'
export function UserDetailBudgetTransition(props: {
	user: UserDetail
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	canWrite: boolean
	busy: boolean
	preview: UserBudgetTransitionPreview | null
	error: unknown
	unknown: boolean
	safetyUnavailable: boolean
	onPreview: (input: UserBudgetTransitionInput) => Promise<void>
	onApply: () => Promise<void>
	onInvalidate: () => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const [draft, setDraft] = useState<BudgetTransitionDraft>(() => ({
		targetBase: String(props.user.budget_base),
		period: props.user.budget_period,
		resetAt: '',
		carryover: 'remaining_or_overage',
		resetSpent: true,
		reason: '',
	}))
	const [confirmed, setConfirmed] = useState(false)
	const [inputError, setInputError] = useState(false)
	function change<K extends keyof BudgetTransitionDraft>(
		key: K,
		value: BudgetTransitionDraft[K]
	): void {
		setDraft((before) => ({ ...before, [key]: value }))
		setConfirmed(false)
		setInputError(false)
		props.onInvalidate()
	}
	async function requestPreview(): Promise<void> {
		try {
			setInputError(false)
			setConfirmed(false)
			await props.onPreview(buildBudgetTransitionInput(draft))
		} catch (error) {
			if (error instanceof UserDetailInputError) setInputError(true)
		}
	}
	const preview = props.preview
	let errorKey: string | null = null
	if (props.error instanceof BudgetTransitionPersistenceError)
		errorKey = 'transitionStorage'
	else if (
		props.error instanceof CinaTokenApiError &&
		props.error.status === 409
	)
		errorKey = 'transitionStale'
	else if (props.error) errorKey = 'transitionFailed'
	return (
		<section className='bg-card min-w-0 space-y-5 rounded-xl border p-4 sm:p-6'>
			<h2 className='text-lg font-semibold'>{t(prefix + 'transitionTitle')}</h2>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'transitionHelp')}
			</p>
			{!props.currency ? (
				<p role='status' className='rounded-md border p-3 text-sm'>
					{t(prefix + 'currencyUnavailable')}
				</p>
			) : (
				<>
					<div className='grid gap-4 md:grid-cols-2'>
						<label className='block space-y-1 text-sm'>
							<span>
								{t(prefix + 'transitionBase')} ({props.currency})
							</span>
							<input
								className='bg-background w-full rounded-md border px-3 py-2 tabular-nums'
								inputMode='decimal'
								value={draft.targetBase}
								onChange={(event) => change('targetBase', event.target.value)}
								disabled={!props.canWrite}
							/>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'period')}</span>
							<select
								className='bg-background w-full rounded-md border px-3 py-2'
								value={draft.period}
								onChange={(event) =>
									change(
										'period',
										event.target.value as BudgetTransitionDraft['period']
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
							<span>{t(prefix + 'transitionResetAt')}</span>
							<input
								type='datetime-local'
								step='1'
								className='bg-background w-full rounded-md border px-3 py-2 dark:[color-scheme:dark]'
								value={draft.resetAt}
								onChange={(event) => change('resetAt', event.target.value)}
								disabled={!props.canWrite}
							/>
						</label>
						<label className='block space-y-1 text-sm'>
							<span>{t(prefix + 'transitionCarryover')}</span>
							<select
								className='bg-background w-full rounded-md border px-3 py-2'
								value={draft.carryover}
								onChange={(event) =>
									change(
										'carryover',
										event.target.value as BudgetTransitionDraft['carryover']
									)
								}
								disabled={!props.canWrite}
							>
								<option value='remaining_or_overage'>
									{t(prefix + 'transitionCarryoverRemaining')}
								</option>
								<option value='none'>
									{t(prefix + 'transitionCarryoverNone')}
								</option>
							</select>
						</label>
					</div>
					<label className='flex items-start gap-2 text-sm'>
						<input
							type='checkbox'
							checked={draft.resetSpent}
							onChange={(event) => change('resetSpent', event.target.checked)}
							disabled={!props.canWrite}
						/>
						<span>{t(prefix + 'transitionResetSpent')}</span>
					</label>
					<label className='block space-y-1 text-sm'>
						<span>{t(prefix + 'transitionReason')}</span>
						<input
							className='bg-background w-full rounded-md border px-3 py-2'
							maxLength={256}
							value={draft.reason}
							onChange={(event) => change('reason', event.target.value)}
							disabled={!props.canWrite}
						/>
					</label>
					<Button
						type='button'
						variant='outline'
						onClick={() => void requestPreview()}
						disabled={!props.canWrite || props.busy}
					>
						{t(prefix + 'transitionPreviewAction')}
					</Button>
					{inputError && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + 'invalidInput')}
						</p>
					)}
					{errorKey && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + errorKey)}
						</p>
					)}
					{props.unknown && (
						<p role='alert' className='text-destructive text-sm'>
							{t(prefix + 'transitionUnknown')}
						</p>
					)}
					{props.safetyUnavailable && (
						<p role='status' className='text-muted-foreground text-sm'>
							{t(prefix + 'transitionStorage')}
						</p>
					)}
					{preview && (
						<div className='space-y-4 rounded-lg border p-4 text-sm'>
							<h3 className='font-semibold'>
								{t(prefix + 'transitionReview')}
							</h3>
							{preview.before.budget_max === null && (
								<p role='status' className='text-muted-foreground'>
									{t(prefix + 'transitionUnlimited')}
								</p>
							)}
							<div className='grid gap-2 sm:grid-cols-3'>
								<div>
									<span className='text-muted-foreground'>
										{t(prefix + 'max')}
									</span>
									<p>
										{preview.before.budget_max === null
											? t(prefix + 'noLimit')
											: formatUserDetailMoney(
													preview.before.budget_max,
													props.currency,
													locale
												)}{' '}
										→{' '}
										{formatUserDetailMoney(
											preview.after.budget_max,
											props.currency,
											locale
										)}
									</p>
								</div>
								<div>
									<span className='text-muted-foreground'>
										{t(prefix + 'spent')}
									</span>
									<p>
										{formatUserDetailMoney(
											preview.before.budget_spent,
											props.currency,
											locale
										)}{' '}
										→{' '}
										{formatUserDetailMoney(
											preview.after.budget_spent,
											props.currency,
											locale
										)}
									</p>
								</div>
								<div>
									<span className='text-muted-foreground'>
										{t(prefix + 'transitionCarryover')}
									</span>
									<p>
										{formatUserDetailMoney(
											preview.carryover,
											props.currency,
											locale
										)}
									</p>
								</div>
							</div>
							<p>
								{t(prefix + 'base')}:{' '}
								{formatUserDetailMoney(
									preview.before.budget_base,
									props.currency,
									locale
								)}{' '}
								→{' '}
								{formatUserDetailMoney(
									preview.after.budget_base,
									props.currency,
									locale
								)}
							</p>
							<p>
								{t(prefix + 'transitionReserved')}:{' '}
								{formatUserDetailMoney(
									preview.before.budget_reserved_micros / 1_000_000,
									props.currency,
									locale
								)}{' '}
								→{' '}
								{formatUserDetailMoney(
									preview.after.budget_reserved_micros / 1_000_000,
									props.currency,
									locale
								)}
							</p>
							<p>
								{t(prefix + 'period')}:{' '}
								{t(
									prefix +
										`period${preview.before.budget_period[0].toUpperCase()}${preview.before.budget_period.slice(1)}`
								)}{' '}
								→{' '}
								{t(
									prefix +
										`period${preview.after.budget_period[0].toUpperCase()}${preview.after.budget_period.slice(1)}`
								)}
							</p>
							<p>
								{t(prefix + 'resetAt')}:{' '}
								{formatUserDetailTime(
									preview.before.budget_reset_at,
									locale,
									props.timezone
								)}{' '}
								→{' '}
								{formatUserDetailTime(
									preview.after.budget_reset_at,
									locale,
									props.timezone
								)}
							</p>
							<p>
								{t(prefix + 'transitionEpoch')}: {preview.before.budget_epoch} →{' '}
								{preview.after.budget_epoch}
							</p>
							<label className='flex items-start gap-2 border-t pt-4'>
								<input
									type='checkbox'
									checked={confirmed}
									onChange={(event) => setConfirmed(event.target.checked)}
									disabled={!props.canWrite || props.busy}
								/>
								<span>{t(prefix + 'transitionConfirm')}</span>
							</label>
							<Button
								type='button'
								onClick={() => void props.onApply()}
								disabled={
									!props.canWrite ||
									props.busy ||
									!confirmed ||
									props.safetyUnavailable
								}
							>
								{props.busy
									? t(prefix + 'saving')
									: t(prefix + 'transitionApplyAction')}
							</Button>
						</div>
					)}
				</>
			)}
		</section>
	)
}
