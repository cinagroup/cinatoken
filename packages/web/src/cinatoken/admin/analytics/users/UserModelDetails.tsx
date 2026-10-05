/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { ModelAnalyticsRow } from '../models/model-analytics-contracts'
import {
	formatAnalyticsMoney,
	formatTokens,
	type TokenMode,
} from '../models/model-analytics-domain'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import { userLogHref } from './user-analytics-domain'

const prefix = 'cinatoken.adminUserAnalytics.'
const detailKeys = [
	'model_id',
	'route_group',
	'request_count',
	'input_tokens',
	'output_tokens',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'avg_charged_per_request',
	'success_rate',
	'avg_latency_ms',
] as const

export function UserModelDetails(props: {
	row: UserAnalyticsRow
	range: { startUtc: string; endUtc: string }
	detail: ModelAnalyticsRow[] | undefined
	loading: boolean
	error: boolean
	logsAllowed: boolean
	currency: 'USD' | 'CNY' | null
	locale: string
	tokenMode: TokenMode
	onRetry: () => void
}) {
	const { t } = useTranslation()
	function money(value: number | undefined, digits = 4): string {
		return (
			formatAnalyticsMoney(value, props.currency, props.locale, digits) ??
			(props.currency ? '—' : t(prefix + 'hidden'))
		)
	}
	if (props.error)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={11} className='p-4'>
					<div role='alert' className='space-y-2'>
						<p>{t(prefix + 'detailFailed')}</p>
						<Button
							type='button'
							size='sm'
							variant='outline'
							onClick={props.onRetry}
						>
							{t(prefix + 'retry')}
						</Button>
					</div>
				</td>
			</tr>
		)
	if (props.loading || !props.detail)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={11} className='p-4'>
					<p role='status'>{t(prefix + 'loadingModels')}</p>
				</td>
			</tr>
		)
	if (props.detail.length === 0)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={11} className='p-4'>
					<p>{t(prefix + 'noModels')}</p>
				</td>
			</tr>
		)
	return (
		<tr className='bg-primary/5'>
			<td colSpan={11} className='p-4'>
				<div className='bg-background overflow-x-auto rounded-lg border'>
					<table className='w-full min-w-[1120px] text-left text-sm'>
						<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
							<tr>
								{detailKeys.map((key) => (
									<th
										key={key}
										scope='col'
										className='px-3 py-2 font-semibold whitespace-nowrap'
									>
										{t(prefix + key)}
									</th>
								))}
							</tr>
						</thead>
						<tbody className='divide-y'>
							{props.detail.map((model) => (
								<tr key={JSON.stringify([model.model_id, model.route_group])}>
									<td className='px-3 py-3 break-all'>
										{props.logsAllowed ? (
											<a
												className='text-primary hover:underline'
												href={userLogHref(
													props.row.user_email,
													props.range,
													model
												)}
												aria-label={t(prefix + 'modelLogs', {
													model: model.model_id,
												})}
											>
												{model.model_id}
											</a>
										) : (
											model.model_id
										)}
									</td>
									<td className='px-3 py-3 font-mono break-all'>
										{model.route_group}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{new Intl.NumberFormat(props.locale).format(
											model.request_count
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{formatTokens(
											model.input_tokens,
											props.tokenMode,
											props.locale
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{formatTokens(
											model.output_tokens,
											props.tokenMode,
											props.locale
										)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(model.standard_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(model.charged_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(model.metered_cost)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{money(model.avg_charged_per_request, 6)}
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{model.success_rate.toFixed(1)}%
									</td>
									<td className='px-3 py-3 tabular-nums'>
										{model.avg_latency_ms === null
											? '—'
											: `${Math.round(model.avg_latency_ms)} ms`}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</td>
		</tr>
	)
}
