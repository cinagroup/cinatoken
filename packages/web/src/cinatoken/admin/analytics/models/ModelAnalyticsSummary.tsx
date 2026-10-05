/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { formatAnalyticsMoney, type TokenMode } from './model-analytics-domain'

const prefix = 'cinatoken.adminModelAnalytics.'

export function ModelAnalyticsSummary(props: {
	currency: 'USD' | 'CNY' | null
	locale: string
	totals: { standard: number | null; charged: number; metered: number }
	tokenMode: TokenMode
	exportDisabled: boolean
	onToggleTokens: () => void
	onExport: () => void
}) {
	const { t } = useTranslation()
	return (
		<div className='bg-card flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4'>
			<div className='flex flex-wrap gap-x-5 gap-y-2 text-sm'>
				{props.currency ? (
					<>
						<span>
							{t(prefix + 'totalStandard')}:{' '}
							{props.totals.standard === null
								? t(prefix + 'unavailable')
								: formatAnalyticsMoney(
										props.totals.standard,
										props.currency,
										props.locale
									)}
						</span>
						<span>
							{t(prefix + 'totalCharged')}:{' '}
							{formatAnalyticsMoney(
								props.totals.charged,
								props.currency,
								props.locale
							)}
						</span>
						<span>
							{t(prefix + 'totalMetered')}:{' '}
							{formatAnalyticsMoney(
								props.totals.metered,
								props.currency,
								props.locale
							)}
						</span>
					</>
				) : (
					<span>{t(prefix + 'amountsHidden')}</span>
				)}
			</div>
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					size='sm'
					variant='outline'
					onClick={props.onToggleTokens}
				>
					{t(
						prefix +
							(props.tokenMode === 'compact'
								? 'showExactTokens'
								: 'showCompactTokens')
					)}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					onClick={props.onExport}
					disabled={props.exportDisabled}
				>
					{t(prefix + 'exportCsv')}
				</Button>
			</div>
		</div>
	)
}
