import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import type { EarningsSummary } from '../../earnings-contracts'
import { formatAccountDate } from '../key-display'
import { formatEarningsMoney } from './earnings-display'

const cards = [
	['balance', 'balance'],
	['locked', 'lockedAmount'],
	['earned', 'lifetimeEarned'],
	['withdrawn', 'lifetimeWithdrawn'],
	['contribution', 'contributionValue'],
] as const

export function EarningsSummaryCards(props: { summary: EarningsSummary }) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	return (
		<div className='space-y-3'>
			<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
				{cards.map(([label, field]) => (
					<Card key={field}>
						<CardContent className='p-4'>
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.account.earnings.' + label)}
							</p>
							<p className='mt-2 text-xl font-semibold break-all tabular-nums'>
								{formatEarningsMoney(props.summary[field], 'USD', locale)}
							</p>
						</CardContent>
					</Card>
				))}
			</div>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.account.earnings.contributionHint')}
			</p>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.account.earnings.updated', {
					time: formatAccountDate(props.summary.updatedAt, locale),
				})}
			</p>
		</div>
	)
}
