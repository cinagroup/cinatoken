/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import {
	requestChargeAmount,
	requestChargeSplit,
	type RequestChargeSource,
} from './request-charge-split'

const prefix = 'cinatoken.adminRequestLogs.chargeSplit.'
export function RequestChargeSplit(props: {
	log: RequestChargeSource
	currency: string | null
	compact?: boolean
}) {
	const { t, i18n } = useTranslation()
	const split = requestChargeSplit(props.log)
	const locale = i18n.resolvedLanguage || 'en'
	function amount(value: number | undefined): string {
		const checked = requestChargeAmount(value)
		if (
			checked === undefined ||
			!props.currency ||
			!/^[A-Z]{3}$/u.test(props.currency)
		)
			return '—'
		return new Intl.NumberFormat(locale, {
			style: 'currency',
			currency: props.currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 6,
		}).format(checked)
	}
	const period = split.status === 'known' ? split.period : undefined
	const wallet = split.status === 'known' ? split.wallet : undefined
	let hint = t(prefix + 'hint')
	if (split.status !== 'known') hint = t(prefix + split.status)
	const fields = [
		{ key: 'period', value: period },
		{ key: 'wallet', value: wallet },
	]
	if (!props.compact)
		fields.unshift({ key: 'total', value: props.log.charged_cost })
	const className = props.compact
		? 'mt-2 space-y-1 text-xs'
		: 'bg-muted/20 min-w-0 space-y-3 rounded-lg border p-3'
	return (
		<section
			aria-label={t(prefix + 'title')}
			className={className}
			title={hint}
		>
			{!props.compact && (
				<h3 className='text-sm font-semibold'>{t(prefix + 'title')}</h3>
			)}
			<dl className={props.compact ? 'space-y-1' : 'grid gap-3 sm:grid-cols-3'}>
				{fields.map((field) => (
					<div key={field.key}>
						<dt className='text-muted-foreground text-xs'>
							{t(prefix + field.key)}
						</dt>
						<dd className='font-mono text-xs tabular-nums'>
							{amount(field.value)}
						</dd>
					</div>
				))}
			</dl>
			{!props.compact && (
				<p className='text-muted-foreground text-xs'>{hint}</p>
			)}
		</section>
	)
}
