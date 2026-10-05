import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { SharedKey } from '../../shared-key-contracts'
import { formatAccountDate } from '../key-display'

const prefix = 'cinatoken.account.sharedKeys.'
export function SharedKeyList(props: {
	rows: SharedKey[]
	quoteCurrency: string
	earningsCurrency: string
	disabled: boolean
	onEdit: (row: SharedKey) => void
	onToggle: (row: SharedKey) => void
	onValidate: (row: SharedKey) => void
	onRemove: (row: SharedKey) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const number = (value: number) =>
		new Intl.NumberFormat(locale, { maximumFractionDigits: 6 }).format(value)
	const money = (value: number, currency: string) =>
		new Intl.NumberFormat(locale, {
			style: 'currency',
			currency,
			currencyDisplay: 'code',
			maximumFractionDigits: 6,
		}).format(value)
	const date = (value: string | null) =>
		value === null
			? t(prefix + 'unavailable')
			: formatAccountDate(value, locale)
	return (
		<div className='space-y-3'>
			{props.rows.map((row) => (
				<Card key={row.id} className='overflow-hidden py-0'>
					<CardContent className='space-y-4 p-4 sm:p-5'>
						<div className='flex flex-wrap items-start justify-between gap-3'>
							<div className='min-w-0 space-y-2'>
								<div className='flex flex-wrap items-center gap-2'>
									<h3 className='font-semibold break-all'>
										{row.label || t(prefix + 'unnamed')}
									</h3>
									<Badge variant='outline'>{row.channelType}</Badge>
									<Badge
										variant={row.status === 'active' ? 'secondary' : 'outline'}
									>
										{t(prefix + 'status_' + row.status)}
									</Badge>
								</div>
								<p className='font-mono text-xs break-all'>
									<span className='sr-only'>{t(prefix + 'masked')}: </span>
									{row.apiKeyMasked}
								</p>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'fingerprint')}: <code>{row.keyFingerprint}</code>
								</p>
							</div>
							<div className='flex flex-wrap gap-2'>
								<Button
									variant='outline'
									size='sm'
									disabled={props.disabled}
									onClick={() => props.onEdit(row)}
								>
									{t(prefix + 'edit')}
								</Button>
								{(row.status === 'active' || row.status === 'paused') && (
									<Button
										variant='outline'
										size='sm'
										disabled={props.disabled}
										onClick={() => props.onToggle(row)}
									>
										{t(prefix + (row.status === 'active' ? 'pause' : 'resume'))}
									</Button>
								)}
								{(row.status === 'invalid' || row.status === 'validating') && (
									<Button
										variant='outline'
										size='sm'
										disabled={props.disabled}
										onClick={() => props.onValidate(row)}
									>
										{t(prefix + 'revalidate')}
									</Button>
								)}
								<Button
									variant='outline'
									size='sm'
									disabled={props.disabled}
									onClick={() => props.onRemove(row)}
								>
									{t(prefix + 'remove')}
								</Button>
							</div>
						</div>
						<div className='bg-muted/30 grid gap-3 rounded-lg border p-3 text-sm sm:grid-cols-3'>
							<div>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'earned')}
								</p>
								<p className='mt-1 font-medium tabular-nums'>
									{money(row.earnedTotal, props.earningsCurrency)}
								</p>
							</div>
							<div>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'served')}
								</p>
								<p className='mt-1 font-medium tabular-nums'>
									{number(row.servedInputTokens + row.servedOutputTokens)}
								</p>
							</div>
							<div>
								<p className='text-muted-foreground text-xs'>
									{t(prefix + 'weight')}
								</p>
								<p className='mt-1 font-medium tabular-nums'>{row.weight}</p>
							</div>
						</div>
						<dl className='grid gap-3 text-sm sm:grid-cols-2'>
							<div>
								<dt className='text-muted-foreground text-xs'>
									{t(prefix + 'inputPrice')}
								</dt>
								<dd className='mt-1'>
									{money(row.inputPrice, props.quoteCurrency)}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground text-xs'>
									{t(prefix + 'outputPrice')}
								</dt>
								<dd className='mt-1'>
									{money(row.outputPrice, props.quoteCurrency)}
								</dd>
							</div>
						</dl>
						<p className='text-muted-foreground text-xs'>
							{t(prefix + 'priceUnit', { currency: props.quoteCurrency })}
						</p>
						{(row.status === 'disabled' ||
							row.status === 'invalid' ||
							row.status === 'validating') && (
							<p className='text-muted-foreground rounded-lg border p-3 text-xs'>
								{t(prefix + 'statusHint_' + row.status)}
							</p>
						)}
						<details className='border-t pt-3'>
							<summary className='text-muted-foreground cursor-pointer text-xs'>
								{t(prefix + 'details')}
							</summary>
							<dl className='mt-4 grid gap-4 text-xs sm:grid-cols-2'>
								{[
									{ key: 'identifier', value: row.id },
									{ key: 'priority', value: String(row.sellerPriority) },
									{
										key: 'cacheReadPrice',
										value:
											row.cacheReadPrice === null
												? t(prefix + 'unpriced')
												: money(row.cacheReadPrice, props.quoteCurrency),
									},
									{
										key: 'cacheWritePrice',
										value:
											row.cacheWritePrice === null
												? t(prefix + 'unpriced')
												: money(row.cacheWritePrice, props.quoteCurrency),
									},
									{ key: 'inputTokens', value: number(row.servedInputTokens) },
									{
										key: 'outputTokens',
										value: number(row.servedOutputTokens),
									},
									{ key: 'lastUsed', value: date(row.lastUsedAt) },
									{ key: 'validatedAt', value: date(row.validatedAt) },
									{ key: 'lastFailure', value: date(row.lastFailureAt) },
									{
										key: 'failureReason',
										value: row.failureReason || t(prefix + 'unavailable'),
									},
									{ key: 'createdAt', value: date(row.createdAt) },
									{ key: 'updatedAt', value: date(row.updatedAt) },
								].map((item) => (
									<div key={item.key}>
										<dt className='text-muted-foreground'>
											{t(prefix + item.key)}
										</dt>
										<dd className='mt-1 break-all'>{item.value}</dd>
									</div>
								))}
							</dl>
						</details>
					</CardContent>
				</Card>
			))}
		</div>
	)
}
