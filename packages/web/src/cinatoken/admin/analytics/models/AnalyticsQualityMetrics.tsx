/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import type { ModelAnalyticsRow } from './model-analytics-contracts'

const prefix = 'cinatoken.adminModelAnalytics.'
type QualityRow = Pick<
	ModelAnalyticsRow,
	| 'stream_tokens_per_second'
	| 'stream_sample_count'
	| 'failover_request_rate'
	| 'failover_request_count'
>

export function StreamSpeedValue(props: { row: QualityRow; locale: string }) {
	const { t } = useTranslation()
	if (props.row.stream_sample_count === undefined)
		return (
			<span className='text-muted-foreground'>
				{t(prefix + 'qualityUnavailable')}
			</span>
		)
	const value = props.row.stream_tokens_per_second
	return (
		<div className='space-y-1 tabular-nums'>
			<div>
				{value == null
					? t(prefix + 'noStreamSamples')
					: new Intl.NumberFormat(props.locale, {
							maximumFractionDigits: 1,
						}).format(value)}
			</div>
			<div className='text-muted-foreground text-xs whitespace-nowrap'>
				{t(prefix + 'streamSamples', {
					samples: new Intl.NumberFormat(props.locale).format(
						props.row.stream_sample_count
					),
				})}
			</div>
		</div>
	)
}

export function FailoverRequestValue(props: {
	row: QualityRow
	locale: string
}) {
	const { t } = useTranslation()
	if (props.row.failover_request_rate === undefined)
		return (
			<span className='text-muted-foreground'>
				{t(prefix + 'qualityUnavailable')}
			</span>
		)
	return (
		<div className='space-y-1 tabular-nums'>
			<div>
				{new Intl.NumberFormat(props.locale, {
					style: 'percent',
					minimumFractionDigits: 1,
					maximumFractionDigits: 1,
				}).format(props.row.failover_request_rate / 100)}
			</div>
			<div className='text-muted-foreground text-xs whitespace-nowrap'>
				{t(prefix + 'failoverRequests', {
					requests: new Intl.NumberFormat(props.locale).format(
						props.row.failover_request_count!
					),
				})}
			</div>
		</div>
	)
}

export function AnalyticsQualityHelp() {
	const { t } = useTranslation()
	return (
		<details className='text-muted-foreground border-b px-3 py-3 text-sm'>
			<summary className='text-foreground cursor-pointer font-medium'>
				{t(prefix + 'qualityHelp')}
			</summary>
			<div className='mt-2 max-w-3xl space-y-2'>
				<p>{t(prefix + 'streamDefinition')}</p>
				<p>{t(prefix + 'failoverDefinition')}</p>
				<p>{t(prefix + 'qualityUnavailableHint')}</p>
			</div>
		</details>
	)
}
