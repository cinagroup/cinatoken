/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { z } from 'zod'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import type { useWalletCredit } from './use-wallet-credit'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from './user-detail-format'
import {
	WalletCreditClientError,
	walletCreditFormInput,
	walletCreditKinds,
	type WalletCreditReceipt,
} from './wallet-credit-contracts'

const prefix = 'cinatoken.adminUserDetail.'
const formSchema = z
	.object({
		amount: z.string(),
		kind: z.enum(walletCreditKinds),
		external_ref: z.string(),
		reason: z.string(),
		confirmed: z.boolean().refine((value) => value),
	})
	.refine((value) => {
		try {
			walletCreditFormInput(value)
			return true
		} catch {
			return false
		}
	})
const kindKeys = [
	'creditTopup',
	'creditSignup',
	'creditAdjust',
	'creditRefund',
] as const
function errorKey(error: unknown): string {
	if (error instanceof WalletCreditClientError) {
		if (error.code === 'legacy') return 'creditLegacy'
		if (error.code === 'conflict') return 'creditConflict'
		if (error.code === 'storage') return 'creditStorage'
		if (error.code === 'input') return 'creditInvalid'
	}
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'creditConflict'
	return 'creditFailed'
}
export function WalletCreditReceiptView(props: {
	receipt: WalletCreditReceipt
	currency: 'USD' | 'CNY' | null
	timezone: string | null
}) {
	const { t, i18n } = useTranslation(),
		receipt = props.receipt
	const values = [
		['creditReference', receipt.externalRef],
		['creditAudit', receipt.auditId],
		[
			'creditAmount',
			formatUserDetailMoney(
				receipt.amountMicros / 1e6,
				props.currency,
				i18n.language
			),
		],
		[
			'creditTime',
			formatUserDetailTime(receipt.creditedAt, i18n.language, props.timezone),
		],
		[
			'creditBefore',
			formatUserDetailMoney(
				receipt.before.walletGranted,
				props.currency,
				i18n.language
			),
		],
		[
			'creditAfter',
			formatUserDetailMoney(
				receipt.after.walletGranted,
				props.currency,
				i18n.language
			),
		],
	] as const
	return (
		<section
			aria-label={t(prefix + 'creditVerified')}
			className='space-y-3 rounded-lg border p-4'
		>
			<h3 className='font-semibold'>{t(prefix + 'creditVerified')}</h3>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'creditReceiptHint')}
			</p>
			<dl className='grid gap-3 text-sm sm:grid-cols-2'>
				{values.map(([key, value]) => (
					<div key={key} className='min-w-0'>
						<dt className='text-muted-foreground'>{t(prefix + key)}</dt>
						<dd className='mt-1 break-all tabular-nums'>{value}</dd>
					</div>
				))}
			</dl>
		</section>
	)
}
export function UserDetailWalletCredit(props: {
	userId: string
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	writer: ReturnType<typeof useWalletCredit>
}) {
	const { t } = useTranslation(),
		writer = props.writer
	const [retryConfirmed, setRetryConfirmed] = useState(false)
	const form = useForm({
		resolver: zodResolver(formSchema),
		defaultValues: {
			amount: '',
			kind: 'topup' as const,
			external_ref: '',
			reason: '',
			confirmed: false,
		},
	})
	const disabled =
		!writer.canStart ||
		!props.currency ||
		writer.busy ||
		writer.status !== 'ready'
	const pending = writer.pending
	const fields = [
		['amount', 'creditAmount'],
		['external_ref', 'creditReference'],
		['reason', 'creditReason'],
	] as const
	async function submit(value: z.infer<typeof formSchema>) {
		await writer.submit(walletCreditFormInput(value))
		form.setValue('confirmed', false)
	}
	return (
		<section
			aria-label={t(prefix + 'creditTitle')}
			className='bg-card space-y-4 rounded-xl border p-4 sm:p-6'
		>
			<h2 className='text-lg font-semibold'>{t(prefix + 'creditTitle')}</h2>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'creditHint')}
			</p>
			<p className='font-mono text-xs break-all'>{props.userId}</p>
			{writer.status === 'unavailable' && (
				<p role='alert'>{t(prefix + 'creditStorage')}</p>
			)}
			{writer.status === 'pending' && (
				<div className='space-y-3 rounded-lg border p-4 text-sm'>
					<p role='alert'>{t(prefix + 'creditPending')}</p>
					{pending && (
						<dl className='grid gap-2 sm:grid-cols-2'>
							<div className='min-w-0'>
								<dt>{t(prefix + 'creditReference')}</dt>
								<dd className='font-mono break-all'>
									{pending.input.external_ref}
								</dd>
							</div>
							<div>
								<dt>{t(prefix + 'creditAmount')}</dt>
								<dd className='tabular-nums'>{pending.input.amount}</dd>
							</div>
							<div>
								<dt>{t(prefix + 'creditKind')}</dt>
								<dd>
									{t(
										prefix +
											kindKeys[walletCreditKinds.indexOf(pending.input.kind)]
									)}
								</dd>
							</div>
						</dl>
					)}
					<Button
						type='button'
						variant='outline'
						disabled={!pending || !writer.allowed || writer.busy}
						onClick={() => {
							setRetryConfirmed(false)
							void writer.reconcile()
						}}
					>
						{t(prefix + 'creditCheck')}
					</Button>
					{writer.observation === 'not_found' && (
						<>
							<p role='status'>{t(prefix + 'creditNotFound')}</p>
							<label className='flex items-start gap-2'>
								<input
									type='checkbox'
									checked={retryConfirmed}
									disabled={!writer.allowed || writer.busy}
									onChange={(event) => setRetryConfirmed(event.target.checked)}
								/>
								<span>{t(prefix + 'creditRetryConfirm')}</span>
							</label>
							<Button
								type='button'
								disabled={!retryConfirmed || !writer.allowed || writer.busy}
								onClick={() => {
									setRetryConfirmed(false)
									void writer.retrySameOrder()
								}}
							>
								{t(prefix + 'creditRetry')}
							</Button>
						</>
					)}
					{writer.observation === 'legacy_unverified' && (
						<p role='status'>{t(prefix + 'creditLegacy')}</p>
					)}
				</div>
			)}
			<form onSubmit={form.handleSubmit(submit)} className='space-y-4'>
				<fieldset
					disabled={disabled}
					className='grid gap-4 sm:grid-cols-2'
					onChange={() => form.setValue('confirmed', false)}
				>
					{fields.map(([name, key]) => (
						<label key={name} className='min-w-0 space-y-1 text-sm'>
							<span>
								{t(prefix + key)}
								{name === 'amount' && props.currency && ` (${props.currency})`}
							</span>
							<input
								className='bg-background block w-full rounded-md border px-3 py-2'
								inputMode={name === 'amount' ? 'decimal' : undefined}
								maxLength={name === 'reason' ? 2000 : undefined}
								{...form.register(name)}
							/>
						</label>
					))}
					<label className='space-y-1 text-sm'>
						<span>{t(prefix + 'creditKind')}</span>
						<select
							className='bg-background block w-full rounded-md border px-3 py-2'
							{...form.register('kind')}
						>
							{walletCreditKinds.map((kind, index) => (
								<option key={kind} value={kind}>
									{t(prefix + kindKeys[index])}
								</option>
							))}
						</select>
					</label>
				</fieldset>
				<label className='flex items-start gap-2 text-sm'>
					<input
						type='checkbox'
						disabled={disabled}
						{...form.register('confirmed')}
						onChange={(event) =>
							form.setValue('confirmed', event.target.checked)
						}
					/>
					<span>{t(prefix + 'creditConfirm')}</span>
				</label>
				{Object.keys(form.formState.errors).length > 0 && (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'creditInvalid')}
					</p>
				)}
				<Button type='submit' disabled={disabled}>
					{t(prefix + 'creditSubmit')}
				</Button>
			</form>
			{Boolean(writer.error) && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + errorKey(writer.error))}
				</p>
			)}
			{writer.receipt && (
				<WalletCreditReceiptView
					receipt={writer.receipt}
					currency={props.currency}
					timezone={props.timezone}
				/>
			)}
		</section>
	)
}
