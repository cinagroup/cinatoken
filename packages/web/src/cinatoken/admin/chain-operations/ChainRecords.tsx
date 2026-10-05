/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogTitle,
} from '../../../components/ui/dialog'
import {
	canRejectChainWithdrawal,
	chainTransactionUrl,
	type AdminWithdrawalRow,
	type ChainRecord,
} from './chain-operations-contracts'
import {
	chainAmount,
	chainRecordFieldValues,
	chainTime,
} from './chain-operations-format'

const prefix = 'cinatoken.adminChainOperations.'
function ChainRecordDetails(props: { row: ChainRecord; onClose: () => void }) {
	const { t, i18n } = useTranslation()
	const titleRef = useRef<HTMLHeadingElement>(null)
	const fields = chainRecordFieldValues(
		props.row,
		i18n.resolvedLanguage ?? 'en',
		t(prefix + 'notRecorded')
	)
	const explorer = chainTransactionUrl(props.row)
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open) props.onClose()
			}}
		>
			<DialogContent
				showCloseButton={false}
				initialFocus={titleRef}
				className='max-h-[85vh] overflow-y-auto sm:max-w-xl'
			>
				<DialogTitle ref={titleRef} tabIndex={-1}>
					{t(prefix + 'detailsTitle')}
				</DialogTitle>
				<dl className='grid min-w-0 gap-3 text-sm'>
					{fields.map(([label, value]) => (
						<div
							key={label}
							className='grid min-w-0 gap-1 sm:grid-cols-[160px_minmax(0,1fr)]'
						>
							<dt className='text-muted-foreground'>{t(prefix + label)}</dt>
							<dd className='min-w-0 break-all'>
								{label === 'status' ? t(prefix + value) : value}
							</dd>
						</div>
					))}
				</dl>
				{explorer ? (
					<a
						href={explorer}
						target='_blank'
						rel='noopener noreferrer'
						className='text-primary underline'
					>
						{t(prefix + 'explorer')}
					</a>
				) : (
					props.row.txHash && (
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'unknownChain')}
						</p>
					)
				)}
				<Button type='button' variant='outline' onClick={props.onClose}>
					{t(prefix + 'cancel')}
				</Button>
			</DialogContent>
		</Dialog>
	)
}

function Transaction(props: { row: ChainRecord }) {
	const { t } = useTranslation()
	const url = chainTransactionUrl(props.row)
	if (!props.row.txHash) return <span>{t(prefix + 'notRecorded')}</span>
	if (url)
		return (
			<a
				href={url}
				target='_blank'
				rel='noopener noreferrer'
				title={props.row.txHash}
				className='text-primary underline'
				aria-label={t(prefix + 'explorer')}
			>
				{props.row.txHash.slice(0, 12)}…
			</a>
		)
	return <span title={props.row.txHash}>{props.row.txHash.slice(0, 12)}…</span>
}

export function ChainRecords(props: {
	rows: readonly ChainRecord[]
	withdrawals: boolean
	canWrite: boolean
	onReject: (row: AdminWithdrawalRow) => void
}) {
	const { t, i18n } = useTranslation()
	const [details, setDetails] = useState<ChainRecord | null>(null)
	const locale = i18n.resolvedLanguage ?? 'en'
	const empty = t(prefix + 'notRecorded')
	return (
		<>
			<div className='max-w-full overflow-x-auto rounded-xl border'>
				<table className='w-full min-w-[1000px] text-left text-sm'>
					<thead className='bg-muted/40 text-muted-foreground'>
						<tr>
							{[
								'time',
								'user',
								props.withdrawals ? 'amount' : 'tier',
								'wallet',
								'status',
								'tx',
								'actions',
							].map((label) => (
								<th key={label} className='px-4 py-3 font-medium' scope='col'>
									{t(prefix + label)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => (
							<tr key={row.id} className='border-t align-top'>
								<td className='px-4 py-3 text-xs whitespace-nowrap'>
									{chainTime(row.createdAt, locale, empty)}
								</td>
								<td className='max-w-40 px-4 py-3 font-mono text-xs break-all'>
									{row.userId}
								</td>
								<td className='min-w-48 px-4 py-3'>
									{'netAmount' in row ? (
										<div className='space-y-1'>
											<p className='font-medium'>
												{chainAmount(row.amount, locale, row.currency)}
											</p>
											<p className='text-muted-foreground text-xs'>
												{t(prefix + 'fee')}:{' '}
												{chainAmount(row.fee, locale, row.currency)}
											</p>
											<p className='text-muted-foreground text-xs'>
												{t(prefix + 'net')}:{' '}
												{chainAmount(row.netAmount, locale, row.currency)}
											</p>
											<p className='text-muted-foreground text-xs'>
												CINA-C:{' '}
												{row.tokenAmount === null
													? empty
													: chainAmount(row.tokenAmount, locale)}
											</p>
										</div>
									) : (
										<div className='space-y-1'>
											<p>
												{row.tierName}{' '}
												<span className='text-muted-foreground'>
													#{row.badgeTokenId}
												</span>
											</p>
											<p className='text-muted-foreground text-xs'>
												{chainAmount(row.valueSnapshot, locale, 'USD')}
											</p>
										</div>
									)}
								</td>
								<td className='max-w-52 px-4 py-3 font-mono text-xs break-all'>
									{row.walletAddress}
								</td>
								<td className='max-w-64 px-4 py-3'>
									<span className='bg-muted inline-block rounded-md px-2 py-1 text-xs'>
										{t(prefix + row.status)}
									</span>
									{row.failureReason && (
										<p className='text-destructive mt-2 text-xs break-words'>
											{row.failureReason}
										</p>
									)}
									{'netAmount' in row && row.status === 'processing' && (
										<p className='text-muted-foreground mt-2 text-xs'>
											{t(prefix + 'processingReview')}
										</p>
									)}
								</td>
								<td className='px-4 py-3 text-xs'>
									<Transaction row={row} />
								</td>
								<td className='min-w-40 space-y-2 px-4 py-3'>
									<Button
										type='button'
										size='sm'
										variant='outline'
										onClick={() => setDetails(row)}
									>
										{t(prefix + 'details')}
									</Button>
									{canRejectChainWithdrawal(row) && (
										<Button
											type='button'
											size='sm'
											variant='outline'
											disabled={!props.canWrite}
											onClick={() => props.onReject(row)}
										>
											{t(prefix + 'reject')}
										</Button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{details && (
				<ChainRecordDetails row={details} onClose={() => setDetails(null)} />
			)}
		</>
	)
}
