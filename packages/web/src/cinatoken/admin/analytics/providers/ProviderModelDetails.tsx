/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ModelMetricCells } from '../models/ModelMetricCells'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from '../models/model-analytics-contracts'
import { modelSortKeys, type TokenMode } from '../models/model-analytics-domain'
import { providerLogHref } from './provider-analytics-domain'

const prefix = 'cinatoken.adminProviderAnalytics.'
const detailKeys = modelSortKeys.filter(
	(key) => key !== 'avg_upstream_response_ms' && key !== 'avg_attempts'
)

export function ProviderModelDetails(props: {
	row: ModelProviderRow
	range: { startUtc: string; endUtc: string }
	tag: string
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
	if (props.error)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={16} className='p-4'>
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
				<td colSpan={16} className='p-4'>
					<p role='status'>{t(prefix + 'loadingModels')}</p>
				</td>
			</tr>
		)
	if (props.detail.length === 0)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={16} className='p-4'>
					<p>{t(prefix + 'noModels')}</p>
				</td>
			</tr>
		)
	return (
		<tr className='bg-primary/5'>
			<td colSpan={16} className='p-4'>
				<div className='bg-background overflow-x-auto rounded-lg border'>
					{props.logsAllowed && props.tag && (
						<p className='text-muted-foreground border-b px-3 py-2 text-xs'>
							{t(prefix + 'logsUnfilteredTag')}
						</p>
					)}
					<table className='w-full min-w-[1450px] text-left text-sm'>
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
												href={providerLogHref(
													props.row.provider_id,
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
									<ModelMetricCells
										row={model}
										kind='detail'
										currency={props.currency}
										locale={props.locale}
										tokenMode={props.tokenMode}
									/>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</td>
		</tr>
	)
}
