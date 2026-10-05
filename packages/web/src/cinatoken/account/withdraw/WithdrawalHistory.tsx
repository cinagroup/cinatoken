import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
	withdrawalTransactionUrl,
	type WithdrawalPage,
} from '../../withdrawal-contracts'

export function WithdrawalHistory(props: {
	context: WithdrawalPage
	page: number
	pending: boolean
	onPage: (page: number) => void
}) {
	const { t, i18n } = useTranslation()
	const text = (key: string, values?: Record<string, unknown>) =>
		t(`cinatoken.account.withdraw.${key}`, values)
	const money = (value: number, currency: string) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			style: 'currency',
			currency,
			minimumFractionDigits: 2,
			maximumFractionDigits: 6,
		}).format(value)
	const quantity = (value: number) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			maximumFractionDigits: 6,
		}).format(value)
	const time = (value: string) =>
		new Intl.DateTimeFormat(i18n.resolvedLanguage, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(value))
	const pages = Math.max(
		1,
		Math.ceil(props.context.total / props.context.pageSize)
	)
	return (
		<Card>
			<CardHeader>
				<CardTitle>{text('history')}</CardTitle>
				<p className='text-muted-foreground text-sm'>{text('polling')}</p>
			</CardHeader>
			<CardContent className='space-y-4'>
				{props.context.data.length === 0 ? (
					<p className='text-muted-foreground text-sm'>{text('empty')}</p>
				) : (
					<ul className='space-y-3'>
						{props.context.data.map((row) => {
							const link = withdrawalTransactionUrl(row)
							return (
								<li
									key={row.id}
									className='min-w-0 space-y-3 rounded-lg border p-4'
								>
									<div className='flex flex-wrap items-center justify-between gap-2'>
										<p className='font-medium'>
											{money(row.amount, row.currency)}
										</p>
										<Badge
											variant={
												row.status === 'failed' ? 'destructive' : 'secondary'
											}
										>
											{text(`status_${row.status}`)}
										</Badge>
									</div>
									{row.currency !== 'USD' ? (
										<p className='text-muted-foreground text-xs'>
											{text('historicalCurrency', { currency: row.currency })}
										</p>
									) : null}
									<dl className='grid gap-3 text-sm sm:grid-cols-2'>
										<div>
											<dt className='text-muted-foreground'>{text('fee')}</dt>
											<dd>{money(row.fee, row.currency)}</dd>
										</div>
										<div>
											<dt className='text-muted-foreground'>{text('net')}</dt>
											<dd>{money(row.netAmount, row.currency)}</dd>
										</div>
										<div>
											<dt className='text-muted-foreground'>
												{text('tokens')}
											</dt>
											<dd>
												{row.tokenAmount === null
													? text('unknown')
													: `${quantity(row.tokenAmount)} CINA-C`}
											</dd>
										</div>
										<div>
											<dt className='text-muted-foreground'>
												{text('created')}
											</dt>
											<dd>{time(row.createdAt)}</dd>
										</div>
										<div className='min-w-0 sm:col-span-2'>
											<dt className='text-muted-foreground'>
												{text('receivingWallet')}
											</dt>
											<dd className='font-mono text-xs break-all'>
												{row.walletAddress}
											</dd>
										</div>
										<div className='min-w-0 sm:col-span-2'>
											<dt className='text-muted-foreground'>
												{text('orderId')}
											</dt>
											<dd className='font-mono text-xs break-all'>{row.id}</dd>
										</div>
									</dl>
									{row.txHash ? (
										<div className='space-y-1 text-xs'>
											<p>
												{text('chain', { id: row.chainId ?? text('unknown') })}
											</p>
											{link ? (
												<a
													href={link}
													target='_blank'
													rel='noopener noreferrer'
													className='text-primary inline-flex max-w-full items-start gap-1 underline'
												>
													<span className='break-all'>{row.txHash}</span>
													<ExternalLink
														className='mt-0.5 size-3 shrink-0'
														aria-hidden='true'
													/>
												</a>
											) : (
												<p className='font-mono break-all'>{row.txHash}</p>
											)}
										</div>
									) : null}
									{row.status === 'failed' ? (
										<Alert variant='destructive'>
											<AlertDescription>
												{text('failedHelp')}
												{row.failureReason ? (
													<p className='mt-1 break-words'>
														{row.failureReason}
													</p>
												) : null}
											</AlertDescription>
										</Alert>
									) : null}
									{row.confirmedAt ? (
										<p className='text-muted-foreground text-xs'>
											{text('confirmedAt', { time: time(row.confirmedAt) })}
										</p>
									) : null}
								</li>
							)
						})}
					</ul>
				)}
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<p className='text-muted-foreground text-sm'>
						{text('pagination', {
							page: props.page,
							pages,
							total: props.context.total,
						})}
					</p>
					<div className='flex gap-2'>
						<Button
							variant='outline'
							disabled={props.pending || props.page <= 1}
							onClick={() => props.onPage(props.page - 1)}
						>
							{text('previous')}
						</Button>
						<Button
							variant='outline'
							disabled={props.pending || props.page >= pages}
							onClick={() => props.onPage(props.page + 1)}
						>
							{text('next')}
						</Button>
					</div>
				</div>
			</CardContent>
		</Card>
	)
}
