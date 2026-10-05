/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AdminConfigWebhookChannel } from './config-contracts'
import {
	useAdminConfigFull,
	type AdminConfigFullProps,
	type ConfigField,
} from './use-admin-config-full'

const prefix = 'cinatoken.adminConfigFull.'
const sourceLabels = {
	configured: 'sourceConfigured',
	legacy: 'sourceLegacy',
	missing: 'sourceMissing',
	invalid: 'sourceInvalid',
	unsupported: 'sourceUnsupported',
} as const
const strategies = [
	{ value: 'hash_affinity', label: 'strategyHash' },
	{ value: 'weighted_random', label: 'strategyRandom' },
	{ value: 'weight_priority', label: 'strategyPriority' },
	{ value: 'weighted_round_robin', label: 'strategyRoundRobin' },
] as const

function LockedNotice(props: { field: ConfigField; locked: boolean }) {
	const { t } = useTranslation()
	if (!props.locked) return null
	return (
		<p
			role='alert'
			className='rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm'
		>
			{t(prefix + 'unconfirmed')}
		</p>
	)
}

export function AdminConfigFull(props: AdminConfigFullProps) {
	const { t } = useTranslation()
	const state = useAdminConfigFull(props)
	const data = state.data
	const canWrite = Boolean(data?.canWrite && props.canWrite)

	function webhookCard(channel: AdminConfigWebhookChannel) {
		if (!data) return null
		const title = t(prefix + channel)
		const configured = data.webhooks[channel].configured
		const isEditing = state.editingWebhook === channel
		const isRevealed = state.revealed?.channel === channel
		const locked = state.locked[channel]
		const canEdit = state.canEdit(channel)
		const canReveal =
			data.canReveal &&
			configured &&
			!state.refreshing &&
			!state.mutation.isPending
		const inputId = `admin-config-${channel}-new-url`
		return (
			<section
				key={channel}
				className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
				aria-labelledby={`admin-config-${channel}-title`}
			>
				<div className='space-y-1'>
					<h2 id={`admin-config-${channel}-title`} className='font-semibold'>
						{title}
					</h2>
					<p className='text-muted-foreground text-sm'>
						{t(
							prefix +
								(channel === 'wecom' ? 'webhookHintWecom' : 'webhookHintFeishu')
						)}
					</p>
					<p className='text-sm'>
						{t(prefix + (configured ? 'configured' : 'notConfigured'))}
					</p>
				</div>
				<LockedNotice field={channel} locked={locked} />
				{locked ? (
					<div className='space-y-2 text-sm'>
						<p>{t(prefix + 'verifyHint')}</p>
						{data.canReveal &&
						state.reconciled[channel] &&
						state.candidateAvailable[channel] ? (
							<Button
								type='button'
								variant='outline'
								onClick={() => void state.verify(channel)}
								disabled={state.verifying !== null || state.refreshing}
							>
								{state.verifying === channel
									? t(prefix + 'loading')
									: t(prefix + 'verifyWebhook')}
							</Button>
						) : (
							<p className='text-muted-foreground'>
								{t(prefix + 'verifyUnavailable')}
							</p>
						)}
						{data.canReveal &&
						state.reconciled[channel] &&
						!state.candidateAvailable[channel] ? (
							<div className='space-y-2'>
								<p>{t(prefix + 'reviewCurrentHint')}</p>
								{!configured || isRevealed ? (
									<Button
										type='button'
										variant='outline'
										onClick={() => state.reviewCurrent(channel)}
									>
										{t(prefix + 'reviewCurrent')}
									</Button>
								) : null}
							</div>
						) : null}
					</div>
				) : null}
				{data.canReveal && configured ? (
					<div className='space-y-2'>
						{isRevealed ? (
							<>
								<label
									className='text-sm font-medium'
									htmlFor={`admin-config-${channel}-revealed`}
								>
									{t(prefix + 'revealed')}
								</label>
								<Input
									id={`admin-config-${channel}-revealed`}
									value={state.revealed?.value ?? ''}
									readOnly
									autoComplete='off'
									spellCheck={false}
									className='font-mono'
								/>
								<Button
									type='button'
									variant='outline'
									onClick={() => state.setRevealed(null)}
								>
									{t(prefix + 'hide')}
								</Button>
							</>
						) : (
							<Button
								type='button'
								variant='outline'
								onClick={() => void state.reveal(channel)}
								disabled={!canReveal || state.revealing !== null}
							>
								{state.revealing === channel
									? t(prefix + 'loading')
									: t(prefix + 'reveal')}
							</Button>
						)}
					</div>
				) : null}
				{canWrite && !locked ? (
					<div className='space-y-3'>
						{isEditing ? (
							<div className='space-y-2'>
								<label className='text-sm font-medium' htmlFor={inputId}>
									{t(prefix + 'newWebhook')}
								</label>
								<Input
									id={inputId}
									type='password'
									value={state.webhookDraft[channel]}
									onChange={(event) =>
										state.setWebhookDraft((prior) => ({
											...prior,
											[channel]: event.target.value,
										}))
									}
									autoComplete='off'
									spellCheck={false}
									disabled={!canEdit}
								/>
								<div className='flex flex-wrap gap-2'>
									<Button
										type='button'
										onClick={() =>
											state.askConfirmation({
												field: channel,
												kind: 'webhook-replace',
											})
										}
										disabled={!canEdit || !state.webhookDraft[channel].trim()}
									>
										{t(prefix + 'replace')}
									</Button>
									<Button
										type='button'
										variant='outline'
										onClick={() => {
											state.setWebhookDraft((prior) => ({
												...prior,
												[channel]: '',
											}))
											state.setEditingWebhook(null)
										}}
										disabled={!canEdit}
									>
										{t(prefix + 'closeEditor')}
									</Button>
								</div>
							</div>
						) : (
							<div className='flex flex-wrap gap-2'>
								<Button
									type='button'
									variant='outline'
									onClick={() => {
										state.setRevealed(null)
										state.setEditingWebhook(channel)
									}}
									disabled={!canEdit}
								>
									{t(prefix + 'replace')}
								</Button>
								{configured ? (
									<Button
										type='button'
										variant='outline'
										onClick={() =>
											state.askConfirmation({
												field: channel,
												kind: 'webhook-clear',
											})
										}
										disabled={!canEdit}
									>
										{t(prefix + 'clear')}
									</Button>
								) : null}
							</div>
						)}
					</div>
				) : null}
			</section>
		)
	}

	let confirmText = t(prefix + 'confirmOther')
	if (state.confirmation?.kind === 'currency')
		confirmText = t(prefix + 'confirmCurrency')
	if (state.confirmation?.kind === 'webhook-replace')
		confirmText = t(prefix + 'confirmReplace')
	if (state.confirmation?.kind === 'webhook-clear')
		confirmText = t(prefix + 'confirmClear')

	return (
		<main className='mx-auto w-full max-w-5xl min-w-0 space-y-6 px-4 py-6 sm:px-6'>
			<header className='space-y-2'>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t(prefix + 'title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t(prefix + 'subtitle')}
				</p>
			</header>
			{state.errorKey ? (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/10 rounded-lg border p-3 text-sm'
				>
					{t(state.errorKey)}
				</p>
			) : null}
			{state.statusKey ? (
				<p role='status' className='rounded-lg border p-3 text-sm'>
					{t(state.statusKey)}
				</p>
			) : null}
			<Button
				type='button'
				variant='outline'
				onClick={() => void state.refresh()}
				disabled={
					state.refreshing ||
					state.mutation.isPending ||
					state.revealing !== null ||
					state.verifying !== null
				}
			>
				{t(prefix + 'refresh')}
			</Button>
			{!data ? (
				<p role='status' className='text-muted-foreground text-sm'>
					{state.overview.isFetching
						? t(prefix + 'loading')
						: t(prefix + 'unavailable')}
				</p>
			) : (
				<>
					{!canWrite ? (
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'readOnly')}
						</p>
					) : null}
					<div className='grid gap-4 lg:grid-cols-2'>
						<section
							className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
							aria-labelledby='admin-config-timezone-title'
						>
							<div>
								<h2 id='admin-config-timezone-title' className='font-semibold'>
									{t(prefix + 'timezone')}
								</h2>
								<p className='text-muted-foreground text-sm'>
									{t(prefix + 'timezoneHint')}
								</p>
							</div>
							<p className='text-sm'>
								{t(prefix + 'current')}: {data.businessTimezone.value} ·{' '}
								{t(prefix + sourceLabels[data.businessTimezone.source])}
							</p>
							<LockedNotice field='timezone' locked={state.locked.timezone} />
							{canWrite && !state.locked.timezone ? (
								<div className='space-y-2'>
									<label
										className='text-sm font-medium'
										htmlFor='admin-config-timezone'
									>
										{t(prefix + 'newTimezone')}
									</label>
									<Input
										id='admin-config-timezone'
										value={state.timezoneDraft ?? data.businessTimezone.value}
										onChange={(event) =>
											state.setTimezoneDraft(event.target.value)
										}
										autoComplete='off'
										spellCheck={false}
										disabled={!state.canEdit('timezone')}
									/>
									<Button
										type='button'
										onClick={() =>
											state.askConfirmation({
												field: 'timezone',
												kind: 'timezone',
												value:
													state.timezoneDraft ?? data.businessTimezone.value,
											})
										}
										disabled={!state.canEdit('timezone')}
									>
										{t(prefix + 'saveTimezone')}
									</Button>
								</div>
							) : null}
						</section>
						<section
							className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
							aria-labelledby='admin-config-currency-title'
						>
							<div>
								<h2 id='admin-config-currency-title' className='font-semibold'>
									{t(prefix + 'currency')}
								</h2>
								<p className='text-muted-foreground text-sm'>
									{t(prefix + 'currencyWarning')}
								</p>
							</div>
							<p className='text-sm'>
								{t(prefix + 'current')}: {data.billingCurrency.value} ·{' '}
								{t(prefix + sourceLabels[data.billingCurrency.source])}
							</p>
							<LockedNotice field='currency' locked={state.locked.currency} />
							{canWrite && !state.locked.currency ? (
								<div className='space-y-2'>
									<label
										className='text-sm font-medium'
										htmlFor='admin-config-currency'
									>
										{t(prefix + 'selectCurrency')}
									</label>
									<select
										id='admin-config-currency'
										value={
											state.currencyDraft ??
											(data.billingCurrency.value === 'CNY' ? 'CNY' : 'USD')
										}
										onChange={(event) =>
											state.setCurrencyDraft(
												event.target.value === 'CNY' ? 'CNY' : 'USD'
											)
										}
										className='border-input bg-background w-full rounded-md border px-3 py-2 text-sm'
										disabled={!state.canEdit('currency')}
									>
										<option value='USD'>USD</option>
										<option value='CNY'>CNY</option>
									</select>
									<Button
										type='button'
										onClick={() =>
											state.askConfirmation({
												field: 'currency',
												kind: 'currency',
												value:
													state.currencyDraft ??
													(data.billingCurrency.value === 'CNY'
														? 'CNY'
														: 'USD'),
											})
										}
										disabled={
											!state.canEdit('currency') ||
											(data.billingCurrency.source === 'configured' &&
												(state.currencyDraft === null ||
													state.currencyDraft === data.billingCurrency.value))
										}
									>
										{t(prefix + 'saveCurrency')}
									</Button>
								</div>
							) : null}
						</section>
						<section
							className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
							aria-labelledby='admin-config-strategy-title'
						>
							<h2 id='admin-config-strategy-title' className='font-semibold'>
								{t(prefix + 'strategy')}
							</h2>
							<p className='text-sm'>
								{t(prefix + 'current')}: {data.routeStrategy.value} ·{' '}
								{t(prefix + sourceLabels[data.routeStrategy.source])}
							</p>
							<LockedNotice field='strategy' locked={state.locked.strategy} />
							{canWrite && !state.locked.strategy ? (
								<div className='space-y-2'>
									<label
										className='text-sm font-medium'
										htmlFor='admin-config-strategy'
									>
										{t(prefix + 'selectStrategy')}
									</label>
									<select
										id='admin-config-strategy'
										value={state.strategyDraft ?? data.routeStrategy.value}
										onChange={(event) => {
											const match = strategies.find(
												(item) => item.value === event.target.value
											)
											if (match) state.setStrategyDraft(match.value)
										}}
										className='border-input bg-background w-full rounded-md border px-3 py-2 text-sm'
										disabled={!state.canEdit('strategy')}
									>
										{strategies.map((item) => (
											<option key={item.value} value={item.value}>
												{t(prefix + item.label)}
											</option>
										))}
									</select>
									<Button
										type='button'
										onClick={() =>
											state.askConfirmation({
												field: 'strategy',
												kind: 'strategy',
												value: state.strategyDraft ?? data.routeStrategy.value,
											})
										}
										disabled={
											!state.canEdit('strategy') ||
											(data.routeStrategy.source === 'configured' &&
												(state.strategyDraft === null ||
													state.strategyDraft === data.routeStrategy.value))
										}
									>
										{t(prefix + 'saveStrategy')}
									</Button>
								</div>
							) : null}
						</section>
						{webhookCard('wecom')}
						{webhookCard('feishu')}
					</div>
				</>
			)}
			{state.confirmation ? (
				<div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4'>
					<div
						role='dialog'
						aria-modal='true'
						aria-labelledby='admin-config-confirm-title'
						className='bg-card w-full max-w-lg space-y-4 rounded-xl border p-5 shadow-xl'
					>
						<h2
							id='admin-config-confirm-title'
							className='text-lg font-semibold'
						>
							{t(prefix + 'confirmTitle')}
						</h2>
						<p className='text-sm'>{confirmText}</p>
						{'value' in state.confirmation ? (
							<p className='text-sm font-medium'>
								{t(prefix + 'targetValue', { value: state.confirmation.value })}
							</p>
						) : (
							<p className='text-sm font-medium'>
								{t(prefix + state.confirmation.field)}
							</p>
						)}
						<div className='flex justify-end gap-2'>
							<Button
								type='button'
								variant='outline'
								onClick={() => state.setConfirmation(null)}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button type='button' onClick={state.confirm}>
								{t(prefix + 'confirmChange')}
							</Button>
						</div>
					</div>
				</div>
			) : null}
			{state.resolutionChannel ? (
				<div className='fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4'>
					<div
						role='dialog'
						aria-modal='true'
						aria-labelledby='admin-config-review-title'
						className='bg-card w-full max-w-lg space-y-4 rounded-xl border p-5 shadow-xl'
					>
						<h2
							id='admin-config-review-title'
							className='text-lg font-semibold'
						>
							{t(prefix + 'reviewCurrent')}
						</h2>
						<p className='text-sm'>{t(prefix + 'reviewCurrentConfirm')}</p>
						<div className='flex justify-end gap-2'>
							<Button
								type='button'
								variant='outline'
								onClick={() => state.setResolutionChannel(null)}
							>
								{t(prefix + 'cancel')}
							</Button>
							<Button type='button' onClick={state.acceptCurrent}>
								{t(prefix + 'acceptCurrent')}
							</Button>
						</div>
					</div>
				</div>
			) : null}
		</main>
	)
}
