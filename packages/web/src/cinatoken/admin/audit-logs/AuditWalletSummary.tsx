/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { AuditLog } from './audit-log-contracts'
import {
	auditWallet,
	formatAuditWalletMoney,
	type AuditWalletAmount,
	type AuditWalletPair,
} from './audit-wallet'

const prefix = 'cinatoken.adminAuditLogs.'
function WalletValue(props: {
	amount: AuditWalletAmount
	currency: string | null
	locale: string
}) {
	const { t } = useTranslation()
	if (!props.currency)
		return (
			<span className='text-muted-foreground'>
				{t(prefix + 'wallet.hidden')}
			</span>
		)
	if (props.amount.kind !== 'value')
		return (
			<span className='text-muted-foreground'>
				{t(prefix + 'wallet.' + props.amount.kind)}
			</span>
		)
	const value = formatAuditWalletMoney(
		props.amount.micros,
		props.currency,
		props.locale
	)
	return (
		<span className='tabular-nums'>{value ?? t(prefix + 'wallet.hidden')}</span>
	)
}
function WalletPair(props: {
	pair: AuditWalletPair
	currency: string | null
	locale: string
}) {
	const { t } = useTranslation()
	if (!props.currency || props.pair.equal)
		return (
			<WalletValue
				amount={props.pair.after}
				currency={props.currency}
				locale={props.locale}
			/>
		)
	return (
		<span className='inline-flex flex-wrap items-baseline gap-x-1 gap-y-0.5'>
			<span>
				<span className='sr-only'>{t(prefix + 'wallet.before')}: </span>
				<WalletValue
					amount={props.pair.before}
					currency={props.currency}
					locale={props.locale}
				/>
			</span>
			<span aria-hidden='true'>→</span>
			<span>
				<span className='sr-only'>{t(prefix + 'wallet.after')}: </span>
				<WalletValue
					amount={props.pair.after}
					currency={props.currency}
					locale={props.locale}
				/>
			</span>
		</span>
	)
}
export function AuditWalletSummary(props: {
	log: AuditLog
	currency: string | null
	locale: string
}) {
	const { t } = useTranslation()
	const wallet = auditWallet(props.log)
	return (
		<dl className='min-w-48 space-y-1 text-xs leading-relaxed'>
			{(['granted', 'spent', 'balance'] as const).map((key) => (
				<div key={key}>
					<dt className='text-muted-foreground'>
						{t(prefix + 'wallet.' + key)}
					</dt>
					<dd>
						<WalletPair
							pair={wallet[key]}
							currency={props.currency}
							locale={props.locale}
						/>
					</dd>
				</div>
			))}
		</dl>
	)
}
