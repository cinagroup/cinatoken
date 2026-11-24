/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { McpNotice, mcpPrefix } from './McpFields'
import type { McpPricingRule } from './mcp-contracts'
import { mcpPricingAmounts } from './mcp-domain'

const priceKeys = ['standard', 'charged', 'metered'] as const
const factorKeys = ['chargedFactor', 'meteredFactor'] as const

export function McpPricingSummary(props: {
	rule: McpPricingRule | null
	currency: 'USD' | 'CNY' | null
	showFactors?: boolean
}) {
	const { t, i18n } = useTranslation()
	const amounts = mcpPricingAmounts(props.rule)
	if (!amounts) return <McpNotice message='invalidPricing' destructive />
	if (!props.currency) return <McpNotice message='currencyUnknown' />
	const locale = i18n.resolvedLanguage ?? i18n.language
	const money = new Intl.NumberFormat(locale, { maximumFractionDigits: 6 })
	const factor = new Intl.NumberFormat(locale, { maximumFractionDigits: 20 })
	const factorRule =
		props.showFactors && props.rule?.v === 2 ? props.rule : null
	return (
		<section
			aria-label={t(mcpPrefix + 'resolvedPricing')}
			className='flex min-w-0 flex-col gap-3'
		>
			<p className='text-muted-foreground text-xs'>
				{t(mcpPrefix + 'pricePerRequest')}
			</p>
			<dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-3'>
				{priceKeys.map((key) => (
					<div key={key} className='min-w-0'>
						<dt className='text-muted-foreground'>{t(mcpPrefix + key)}</dt>
						<dd className='mt-1 font-mono break-words'>
							{money.format(amounts[key])} {props.currency}
						</dd>
					</div>
				))}
			</dl>
			{factorRule && (
				<dl className='grid min-w-0 gap-3 text-sm sm:grid-cols-2'>
					{factorKeys.map((key) => (
						<div key={key} className='min-w-0'>
							<dt className='text-muted-foreground'>{t(mcpPrefix + key)}</dt>
							<dd className='mt-1 font-mono break-words'>
								{factor.format(factorRule[key])} ×
							</dd>
						</div>
					))}
				</dl>
			)}
			{amounts.charged < amounts.metered && (
				<McpNotice message='priceBelowMetered' />
			)}
		</section>
	)
}
