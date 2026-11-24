/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../../components/ui/button'
import type { AnalyticsDetailState } from '../models/analytics-drilldowns'
import type { ModelAnalyticsRow } from '../models/model-analytics-contracts'
import {
	formatAnalyticsMoney,
	formatTokens,
	type TokenMode,
} from '../models/model-analytics-domain'
import { UserModelDetails } from './UserModelDetails'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import { formatLastActive, userKeyLogHref } from './user-analytics-domain'
import type { UserKeyAnalyticsRow } from './user-key-analytics'

const prefix = 'cinatoken.adminUserAnalytics.'
const columns = [
	'key_name',
	'api_key_id',
	'request_count',
	'input_tokens',
	'output_tokens',
	'standard_cost',
	'charged_cost',
	'metered_cost',
	'distinct_models',
	'last_active_at',
	'success_rate',
] as const
export function UserKeyDetails(props: {
	row: UserAnalyticsRow
	range: { startUtc: string; endUtc: string }
	keys: UserKeyAnalyticsRow[] | undefined
	loading: boolean
	error: boolean
	colSpan: number
	models: ReadonlyMap<string, AnalyticsDetailState<ModelAnalyticsRow>>
	currency: 'USD' | 'CNY' | null
	timezone: string | null
	locale: string
	tokenMode: TokenMode
	logsAllowed: boolean
	onToggleKey: (id: string) => void
	onRetry: () => void
}) {
	const { t } = useTranslation()
	const userId = props.row.user_id
	if (!userId) return null
	function money(value: number | undefined): string {
		return (
			formatAnalyticsMoney(value, props.currency, props.locale) ??
			(props.currency ? '—' : t(prefix + 'hidden'))
		)
	}
	let content: ReactNode
	if (props.error)
		content = (
			<div role='alert' className='space-y-2'>
				<p>{t(prefix + 'keysFailed')}</p>
				<Button variant='outline' size='sm' onClick={props.onRetry}>
					{t(prefix + 'retry')}
				</Button>
			</div>
		)
	else if (props.loading || !props.keys)
		content = <p role='status'>{t(prefix + 'loadingKeys')}</p>
	else if (!props.keys.length) content = <p>{t(prefix + 'noKeys')}</p>
	else
		content = (
			<div className='bg-background w-0 min-w-full overflow-x-auto rounded-lg border'>
				<table className='w-full min-w-[1120px] text-left text-sm'>
					<caption className='sr-only'>
						{t(prefix + 'keysTitle', { email: props.row.user_email })}
					</caption>
					<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
						<tr>
							{columns.map((key) => (
								<th
									key={key}
									scope='col'
									className='px-3 py-2 whitespace-nowrap'
								>
									{t(prefix + key)}
								</th>
							))}
						</tr>
					</thead>
					<tbody className='divide-y'>
						{props.keys.map((key) => {
							const detail = key.api_key_id
								? props.models.get(key.api_key_id)
								: undefined
							const id = key.api_key_id,
								name = id
									? key.key_name || t(prefix + 'unnamedKey')
									: t(prefix + 'deletedKey')
							return (
								<Fragment key={id ?? 'deleted-history'}>
									<tr>
										<td className='max-w-64 min-w-48 px-3 py-3 break-all'>
											{id ? (
												<>
													<Button
														variant='link'
														className='h-auto p-0 text-left whitespace-normal'
														aria-expanded={Boolean(detail)}
														aria-label={t(prefix + 'toggleKeyModels', {
															name,
															id,
															email: props.row.user_email,
														})}
														onClick={() => props.onToggleKey(id)}
													>
														{name}
													</Button>
													{props.logsAllowed && (
														<a
															href={userKeyLogHref(userId, id, props.range)}
															className='text-muted-foreground block text-xs underline'
															aria-label={t(prefix + 'keyLogs', { name })}
														>
															{t(prefix + 'viewLogs')}
														</a>
													)}
												</>
											) : (
												name
											)}
											<p className='text-muted-foreground mt-1 text-xs'>
												{t(prefix + 'keyOutcomes', {
													success: key.success_count,
													errors: key.error_count,
													other:
														key.request_count -
														key.success_count -
														key.error_count,
												})}
											</p>
										</td>
										<td className='max-w-64 min-w-48 px-3 py-3 font-mono text-xs break-all'>
											{id ?? '—'}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{new Intl.NumberFormat(props.locale).format(
												key.request_count
											)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{formatTokens(
												key.input_tokens,
												props.tokenMode,
												props.locale
											)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{formatTokens(
												key.output_tokens,
												props.tokenMode,
												props.locale
											)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{money(key.standard_cost)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{money(key.charged_cost)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{money(key.metered_cost)}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{new Intl.NumberFormat(props.locale).format(
												key.distinct_models
											)}
										</td>
										<td className='px-3 py-3 whitespace-nowrap'>
											{formatLastActive(
												key.last_active_at,
												props.timezone,
												props.locale
											) ?? '—'}
										</td>
										<td className='px-3 py-3 tabular-nums'>
											{key.success_rate.toFixed(1)}%
										</td>
									</tr>
									{id && detail && (
										<UserModelDetails
											row={props.row}
											keyScope={{ userId, apiKeyId: id }}
											range={props.range}
											detail={detail.rows}
											loading={detail.loading}
											error={detail.error}
											logsAllowed={props.logsAllowed}
											currency={props.currency}
											locale={props.locale}
											tokenMode={props.tokenMode}
											onRetry={detail.retry}
										/>
									)}
								</Fragment>
							)
						})}
					</tbody>
				</table>
			</div>
		)
	return (
		<tr className='bg-primary/5'>
			<td colSpan={props.colSpan} className='p-4'>
				<section
					className='space-y-3'
					aria-label={t(prefix + 'keysTitle', { email: props.row.user_email })}
				>
					<h3 className='max-w-[calc(100vw-4rem)] font-semibold break-words'>
						{t(prefix + 'keysTitle', { email: props.row.user_email })}
					</h3>
					<p className='text-muted-foreground max-w-[calc(100vw-4rem)] text-xs break-words'>
						{t(prefix + 'keyScope')}
					</p>
					{content}
				</section>
			</td>
		</tr>
	)
}
