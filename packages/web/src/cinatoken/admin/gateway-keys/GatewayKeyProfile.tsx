/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from '../user-detail/user-detail-format'
import type { GatewayKeyDetail } from './gateway-key-contracts'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeyProfile(props: {
	detail: GatewayKeyDetail
	currency: 'USD' | 'CNY' | null
}) {
	const { t, i18n } = useTranslation()
	let budget = t(prefix + 'currencyUnavailable')
	if (props.currency) {
		const maximum =
			props.detail.budget_max === null
				? t(prefix + 'unlimited')
				: formatUserDetailMoney(
						props.detail.budget_max,
						props.currency,
						i18n.resolvedLanguage || 'en'
					)
		budget =
			formatUserDetailMoney(
				props.detail.budget_spent,
				props.currency,
				i18n.resolvedLanguage || 'en'
			) +
			' / ' +
			maximum
	}
	return (
		<dl className='grid gap-2 text-xs sm:grid-cols-2'>
			<dt>{t(prefix + 'keyId')}</dt>
			<dd className='break-all'>{props.detail.id}</dd>
			<dt>{t(prefix + 'userId')}</dt>
			<dd className='break-all'>{props.detail.user_id}</dd>
			<dt>{t(prefix + 'workspace')}</dt>
			<dd className='break-all'>{props.detail.workspace_id}</dd>
			<dt>{t(prefix + 'key')}</dt>
			<dd className='font-mono'>{props.detail.key}</dd>
			<dt>{t(prefix + 'budget')}</dt>
			<dd>{budget}</dd>
			{props.currency && (
				<>
					<dt>{t(prefix + 'base')}</dt>
					<dd>
						{formatUserDetailMoney(
							props.detail.budget_base,
							props.currency,
							i18n.resolvedLanguage || 'en'
						)}
					</dd>
				</>
			)}
			<dt>{t(prefix + 'period')}</dt>
			<dd>{t(prefix + props.detail.budget_period)}</dd>
			<dt>{t(prefix + 'budgetReset')}</dt>
			<dd>
				{formatUserDetailTime(
					props.detail.budget_reset_at,
					i18n.resolvedLanguage || 'en',
					'UTC'
				)}
			</dd>
			<dt>{t(prefix + 'created')}</dt>
			<dd>
				{formatUserDetailTime(
					props.detail.created_at,
					i18n.resolvedLanguage || 'en',
					'UTC'
				)}
			</dd>
			<dt>{t(prefix + 'updated')}</dt>
			<dd>
				{formatUserDetailTime(
					props.detail.updated_at,
					i18n.resolvedLanguage || 'en',
					'UTC'
				)}
			</dd>
		</dl>
	)
}
