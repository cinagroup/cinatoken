import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { Earning } from '../../earnings-contracts'
import { formatAccountDate } from '../key-display'
import { formatEarningsMoney } from './earnings-display'

const tokens = [
	['input', 'inputTokens'],
	['output', 'outputTokens'],
	['cacheRead', 'cacheReadTokens'],
	['cacheWrite', 'cacheWriteTokens'],
] as const
const amounts = [
	['gross', 'grossAmount'],
	['fee', 'platformFee'],
	['net', 'netAmount'],
] as const

export function EarningsList(props: { rows: readonly Earning[] }) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	return (
		<div className='space-y-3'>
			{props.rows.map((row) => (
				<Card key={row.id}>
					<CardContent className='space-y-4 p-4'>
						<div className='flex flex-wrap items-start justify-between gap-2'>
							<p className='text-sm font-medium'>
								{formatAccountDate(row.createdAt, locale)}
							</p>
							<Badge variant='outline'>
								{t('cinatoken.account.earnings.statusRecorded')}
							</Badge>
						</div>
						<dl className='grid gap-3 sm:grid-cols-2'>
							{(
								[
									['request', row.requestLogId],
									['sharedKey', row.sharedKeyId],
								] as const
							).map(([label, value]) => (
								<div key={label} className='min-w-0'>
									<dt className='text-muted-foreground text-xs'>
										{t('cinatoken.account.earnings.' + label)}
									</dt>
									<dd className='mt-1 font-mono text-xs break-all'>{value}</dd>
								</div>
							))}
						</dl>
						<dl className='grid grid-cols-2 gap-3 border-y py-3 sm:grid-cols-4'>
							{tokens.map(([label, field]) => (
								<div key={field}>
									<dt className='text-muted-foreground text-xs'>
										{t('cinatoken.account.earnings.' + label)}
									</dt>
									<dd className='mt-1 text-sm tabular-nums'>
										{row[field].toLocaleString(locale)}
									</dd>
								</div>
							))}
						</dl>
						<dl className='grid gap-3 sm:grid-cols-3'>
							{amounts.map(([label, field]) => (
								<div key={field}>
									<dt className='text-muted-foreground text-xs'>
										{t('cinatoken.account.earnings.' + label)}
									</dt>
									<dd className='mt-1 text-sm font-medium break-all tabular-nums'>
										{formatEarningsMoney(row[field], row.currency, locale)}
									</dd>
								</div>
							))}
						</dl>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
