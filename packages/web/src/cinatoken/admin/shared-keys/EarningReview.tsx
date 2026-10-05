/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { EarningReviewResult } from './EarningReviewResult'
import { SharedKeyManualRecovery } from './SharedKeyManualRecovery'
import { adminEarningReviewInputSchema } from './review-contracts'
import { adminSharedKeyRecovery } from './shared-key-recovery'
import { useEarningReview, type EarningReviewProps } from './use-earning-review'
import { useSharedKeyAccess } from './use-shared-key-access'

const prefix = 'cinatoken.adminSharedKeys.'
const schema = adminEarningReviewInputSchema.extend({ reviewed: z.boolean() })
export function EarningReview(props: EarningReviewProps) {
	const { t } = useTranslation()
	const [epoch, setEpoch] = useState(0)
	const denied = useSharedKeyAccess(
		adminSharedKeyRecovery(props.api).reviewAccess,
		props.reconciliationKey
	)
	if (denied)
		return (
			<p role='alert' className='rounded-xl border p-4 text-sm'>
				{t(prefix + 'reviewDenied')}
			</p>
		)
	return (
		<EarningReviewSession
			key={JSON.stringify([props.scopeKey, props.reconciliationKey, epoch])}
			onRestart={() => setEpoch((value) => value + 1)}
			{...props}
		/>
	)
}
function EarningReviewSession(
	props: EarningReviewProps & { onRestart: () => void }
) {
	const { t } = useTranslation()
	const id = useId()
	const [initialSince] = useState(() =>
		new Date(Date.now() - 86_400_000).toISOString()
	)
	const manager = useEarningReview(props)
	const form = useForm<
		z.input<typeof schema>,
		unknown,
		z.output<typeof schema>
	>({
		resolver: zodResolver(schema),
		defaultValues: {
			since: initialSince,
			limit: 200,
			reviewed: false,
		},
	})
	return (
		<section className='space-y-4 rounded-xl border p-4 sm:p-5'>
			<SharedKeyManualRecovery
				api={props.api}
				store={adminSharedKeyRecovery(props.api).reviewWrite}
				identity={props.reconciliationKey}
				consoleSubject={props.consoleSubject}
				enabled={!manager.busy}
				canReadLogs={props.canReadLogs}
				onAccessLost={(stage, status) => {
					if (status === 401 || stage === 'detail') props.onReadLost()
					else if (
						adminSharedKeyRecovery(props.api).reviewAccess.block(
							props.reconciliationKey
						)
					)
						void props.revalidate().catch(() => undefined)
				}}
				onRecovered={props.onRestart}
			/>
			<header>
				<h2 className='text-lg font-semibold'>{t(prefix + 'reviewTitle')}</h2>
				<p className='text-muted-foreground mt-1 text-sm'>
					{t(prefix + 'reviewHint')}
				</p>
			</header>
			<form
				className='space-y-4'
				onSubmit={form.handleSubmit((input) =>
					manager.run({ since: input.since, limit: input.limit }, false)
				)}
			>
				<div className='grid gap-4 sm:grid-cols-2'>
					<div className='space-y-1 text-sm'>
						<label className='block' htmlFor={id + '-since'}>
							{t(prefix + 'since')}
						</label>
						<input
							id={id + '-since'}
							className='bg-background w-full rounded-md border px-3 py-2 font-mono text-xs'
							maxLength={24}
							disabled={manager.busy}
							aria-invalid={Boolean(form.formState.errors.since)}
							aria-describedby={
								form.formState.errors.since ? id + '-since-error' : undefined
							}
							{...form.register('since', { onChange: manager.clear })}
						/>
						{form.formState.errors.since && (
							<p
								id={id + '-since-error'}
								role='alert'
								className='text-destructive text-xs'
							>
								{t(prefix + 'invalidInput')}
							</p>
						)}
					</div>
					<div className='space-y-1 text-sm'>
						<label className='block' htmlFor={id + '-limit'}>
							{t(prefix + 'limit')}
						</label>
						<input
							id={id + '-limit'}
							type='number'
							min='1'
							max='1000'
							step='1'
							className='bg-background w-full rounded-md border px-3 py-2'
							disabled={manager.busy}
							aria-invalid={Boolean(form.formState.errors.limit)}
							aria-describedby={
								form.formState.errors.limit ? id + '-limit-error' : undefined
							}
							{...form.register('limit', {
								valueAsNumber: true,
								onChange: manager.clear,
							})}
						/>
						{form.formState.errors.limit && (
							<p
								id={id + '-limit-error'}
								role='alert'
								className='text-destructive text-xs'
							>
								{t(prefix + 'invalidInput')}
							</p>
						)}
					</div>
				</div>
				<div className='space-y-1 text-sm'>
					<div className='flex items-start gap-2'>
						<input
							id={id + '-review'}
							type='checkbox'
							className='mt-1 shrink-0'
							disabled={manager.busy}
							aria-invalid={Boolean(form.formState.errors.reviewed)}
							aria-describedby={
								form.formState.errors.reviewed
									? id + '-review-error'
									: undefined
							}
							{...form.register('reviewed')}
						/>
						<label htmlFor={id + '-review'}>
							{t(prefix + 'reviewConfirm')}
						</label>
					</div>
					{form.formState.errors.reviewed && (
						<p
							id={id + '-review-error'}
							role='alert'
							className='text-destructive text-xs'
						>
							{t(prefix + 'invalidInput')}
						</p>
					)}
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button type='submit' variant='outline' disabled={manager.busy}>
						{t(prefix + 'discover')}
					</Button>
					<Button
						type='button'
						disabled={
							manager.busy || manager.pending !== 'ready' || !manager.result
						}
						onClick={() =>
							void form.handleSubmit((input) => {
								if (!input.reviewed) {
									form.setError('reviewed', { message: 'invalidInput' })
									return
								}
								return manager.run(
									{ since: input.since, limit: input.limit },
									true
								)
							})()
						}
					>
						{t(prefix + (manager.busy ? 'saving' : 'requestReview'))}
					</Button>
				</div>
			</form>
			{manager.pending !== 'ready' && (
				<p role='alert' className='text-sm'>
					{t(
						prefix +
							(manager.pending === 'pending'
								? 'reviewPending'
								: 'storageUnavailable')
					)}
				</p>
			)}
			{manager.error && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + manager.error)}
				</p>
			)}
			{manager.result && (
				<EarningReviewResult
					key={JSON.stringify(manager.result.data.range)}
					result={manager.result}
					canReadLogs={props.canReadLogs}
				/>
			)}
		</section>
	)
}
