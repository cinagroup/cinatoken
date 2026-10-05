/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ModelMetricCells } from './ModelMetricCells'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from './model-analytics-contracts'
import {
	modelLogHref,
	modelSortKeys,
	type TokenMode,
} from './model-analytics-domain'

const prefix = 'cinatoken.adminModelAnalytics.'
const detailKeys = modelSortKeys.filter(
	(key) =>
		key !== 'route_group' &&
		key !== 'avg_upstream_response_ms' &&
		key !== 'avg_attempts'
)

export function ModelProviderDetails(props: {
	row: ModelAnalyticsRow
	range: { startUtc: string; endUtc: string }
	detail: ModelProviderRow[] | undefined
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
				<td colSpan={17} className='p-4'>
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
				<td colSpan={17} className='p-4'>
					<p role='status'>{t(prefix + 'loadingProviders')}</p>
				</td>
			</tr>
		)
	if (props.detail.length === 0)
		return (
			<tr className='bg-primary/5'>
				<td colSpan={17} className='p-4'>
					<p>{t(prefix + 'noProviders')}</p>
				</td>
			</tr>
		)
	return (
		<tr className='bg-primary/5'>
			<td colSpan={17} className='p-4'>
				<div className='bg-background overflow-x-auto rounded-lg border'>
					<table className='w-full min-w-[1400px] text-left text-sm'>
						<thead className='bg-muted/60 text-muted-foreground border-b text-xs'>
							<tr>
								{detailKeys.map((key) => (
									<th
										key={key}
										scope='col'
										className='px-3 py-2 font-semibold whitespace-nowrap'
									>
										{t(prefix + (key === 'model_id' ? 'provider' : key))}
									</th>
								))}
							</tr>
						</thead>
						<tbody className='divide-y'>
							{props.detail.map((provider) => (
								<tr key={provider.provider_id}>
									<td className='px-3 py-3 break-all'>
										{props.logsAllowed ? (
											<a
												className='text-primary hover:underline'
												href={modelLogHref(props.row, props.range, provider)}
											>
												{provider.provider_name ?? provider.provider_id}
											</a>
										) : (
											(provider.provider_name ?? provider.provider_id)
										)}
									</td>
									<ModelMetricCells
										row={provider}
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
