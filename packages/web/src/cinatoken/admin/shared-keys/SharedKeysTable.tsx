/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { SharedKeyConfirmationKind } from './SharedKeyConfirmation'
import { SharedKeyPrices } from './SharedKeyPrices'
import type {
	AdminSharedKeyCapabilities,
	AdminSharedKeyRow,
} from './shared-key-contracts'
import {
	formatSharedKeyEarnings,
	formatSharedKeyNumber,
} from './shared-key-display'

const prefix = 'cinatoken.adminSharedKeys.'
export type SharedKeyDialogKind =
	SharedKeyConfirmationKind | 'details' | 'edit' | 'audit'
export function SharedKeysTable(props: {
	rows: AdminSharedKeyRow[]
	capabilities: AdminSharedKeyCapabilities
	canWrite: boolean
	onOpen: (row: AdminSharedKeyRow, kind: SharedKeyDialogKind) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	return (
		<div className='overflow-x-auto rounded-xl border'>
			<table className='w-full min-w-[1280px] text-left text-sm'>
				<caption className='sr-only'>{t(prefix + 'title')}</caption>
				<thead className='bg-muted/40'>
					<tr>
						{[
							'keyId',
							'seller',
							'channel',
							'status',
							'pricing',
							'priority',
							'weight',
							'usage',
							'earned',
							'actions',
						].map((column) => (
							<th key={column} scope='col' className='px-3 py-3 font-medium'>
								{t(prefix + column)}
							</th>
						))}
					</tr>
				</thead>
				<tbody>
					{props.rows.map((row) => (
						<tr key={row.id} className='border-t align-top'>
							<td className='max-w-56 space-y-1 px-3 py-3'>
								<p className='font-mono text-xs break-all'>{row.id}</p>
								<p className='break-all'>
									{row.label ?? t(prefix + 'unnamed')}
								</p>
								<p className='text-muted-foreground font-mono text-xs'>
									{row.apiKeyMasked}
								</p>
							</td>
							<td className='max-w-48 space-y-1 px-3 py-3'>
								<p className='break-all'>
									{row.sellerEmail ?? row.sellerUserId}
								</p>
								<p className='text-muted-foreground font-mono text-xs break-all'>
									{row.sellerUserId}
								</p>
								{props.capabilities.user_detail && (
									<a
										className='text-primary text-xs underline'
										href={
											'/admin/users/' + encodeURIComponent(row.sellerUserId)
										}
									>
										{t(prefix + 'userDetail')}
									</a>
								)}
							</td>
							<td className='px-3 py-3'>{row.channelType}</td>
							<td className='px-3 py-3'>
								<span>{t(prefix + 'status_' + row.status)}</span>
								{row.failureCode !== null && (
									<p className='text-destructive mt-1 max-w-44 text-xs'>
										{t(prefix + 'failure_' + row.failureCode)}
									</p>
								)}
							</td>
							<td className='min-w-48 px-3 py-3'>
								<SharedKeyPrices row={row} />
							</td>
							<td className='px-3 py-3 tabular-nums'>{row.sellerPriority}</td>
							<td className='px-3 py-3 tabular-nums'>{row.weight}</td>
							<td className='space-y-1 px-3 py-3 text-xs'>
								<p>
									{t(prefix + 'inputTokens')}:{' '}
									{formatSharedKeyNumber(row.servedInputTokens, locale)}
								</p>
								<p>
									{t(prefix + 'outputTokens')}:{' '}
									{formatSharedKeyNumber(row.servedOutputTokens, locale)}
								</p>
								<p className='text-muted-foreground max-w-40'>
									{t(prefix + 'statistics_' + row.statisticsBasis)}
								</p>
							</td>
							<td className='px-3 py-3 tabular-nums'>
								{formatSharedKeyEarnings(row.earnedTotal, locale)}
							</td>
							<td className='min-w-48 px-3 py-3'>
								<div className='flex max-w-56 flex-wrap gap-2'>
									<Button
										type='button'
										size='sm'
										variant='outline'
										onClick={() => props.onOpen(row, 'details')}
									>
										{t(prefix + 'details')}
									</Button>
									{props.capabilities.can_write && (
										<>
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite}
												onClick={() => props.onOpen(row, 'edit')}
											>
												{t(prefix + 'edit')}
											</Button>
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite}
												onClick={() =>
													props.onOpen(
														row,
														row.status === 'disabled' ? 'restore' : 'disable'
													)
												}
											>
												{t(
													prefix +
														(row.status === 'disabled' ? 'restore' : 'disable')
												)}
											</Button>
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite}
												onClick={() => props.onOpen(row, 'delete')}
											>
												{t(prefix + 'delete')}
											</Button>
										</>
									)}
								</div>
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}
