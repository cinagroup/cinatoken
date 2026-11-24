/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import type { UserDetail } from './user-detail-contracts'
import type { UserDetailDraft } from './user-detail-domain'
import { formatUserDetailMoney } from './user-detail-format'

const prefix = 'cinatoken.adminUserDetail.'
type WalletField = 'walletGranted' | 'walletSpent' | 'walletReason'
export function UserDetailWalletFields(props: {
	user: UserDetail
	currency: 'USD' | 'CNY'
	draft: Pick<UserDetailDraft, WalletField>
	canWrite: boolean
	onChange: (key: WalletField, value: string) => void
}) {
	const { t, i18n } = useTranslation()
	if (props.user.wallet_granted === undefined)
		return (
			<Alert>
				<AlertDescription>{t(prefix + 'walletUnavailable')}</AlertDescription>
			</Alert>
		)
	return (
		<fieldset className='flex flex-col gap-4 border-t pt-4'>
			<legend className='px-1 font-semibold'>{t(prefix + 'wallet')}</legend>
			<p className='text-sm'>
				{t(prefix + 'walletBalance')}:{' '}
				<span className='font-medium tabular-nums'>
					{formatUserDetailMoney(
						props.user.wallet_balance ?? null,
						props.currency,
						i18n.resolvedLanguage ?? 'en'
					)}
				</span>
			</p>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'walletHint')}
			</p>
			<div className='grid gap-4 sm:grid-cols-2'>
				{(['walletGranted', 'walletSpent'] as const).map((key) => (
					<label key={key} className='flex flex-col gap-1 text-sm'>
						<span>
							{t(prefix + key)} ({props.currency})
						</span>
						<input
							className='bg-background w-full rounded-md border px-3 py-2 tabular-nums'
							inputMode='decimal'
							value={props.draft[key]}
							disabled={!props.canWrite}
							onChange={(event) => props.onChange(key, event.target.value)}
						/>
					</label>
				))}
			</div>
			<label className='flex flex-col gap-1 text-sm'>
				<span>{t(prefix + 'walletReason')}</span>
				<input
					className='bg-background w-full rounded-md border px-3 py-2'
					maxLength={256}
					value={props.draft.walletReason}
					disabled={!props.canWrite}
					onChange={(event) =>
						props.onChange('walletReason', event.target.value)
					}
				/>
			</label>
		</fieldset>
	)
}
