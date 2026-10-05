/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	formatUserDetailMoney,
	formatUserDetailTime,
} from '../user-detail/user-detail-format'
import { GatewayKeyLinks } from './GatewayKeyLinks'
import type {
	GatewayKeyRow,
	GatewayKeysCapabilities,
} from './gateway-key-contracts'

const prefix = 'cinatoken.adminGatewayKeys.'
export function GatewayKeysTable(props: {
	rows: GatewayKeyRow[]
	capabilities: GatewayKeysCapabilities
	currency: 'USD' | 'CNY' | null
	canWrite: boolean
	onEdit: (row: GatewayKeyRow) => void
	onStatus: (row: GatewayKeyRow) => void
	onTombstone: (row: GatewayKeyRow) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage || 'en'
	const [copiedId, setCopiedId] = useState<string | null>(null)
	const [copyFailed, setCopyFailed] = useState(false)
	async function copyId(id: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(id)
			setCopiedId(id)
			setCopyFailed(false)
		} catch {
			setCopyFailed(true)
		}
	}
	function money(value: number): string {
		return formatUserDetailMoney(value, props.currency, locale)
	}
	return (
		<div className='rounded-xl border'>
			{copyFailed && (
				<p role='alert' className='text-destructive p-3 text-sm'>
					{t(prefix + 'copyFailed')}
				</p>
			)}
			<div className='overflow-x-auto'>
				<table className='w-full min-w-[1000px] text-left text-sm'>
					<thead>
						<tr className='bg-muted/40 border-b text-xs'>
							{[
								'owner',
								'key',
								'name',
								'budget',
								'metadata',
								'created',
								'actions',
							].map((column) => (
								<th key={column} className='p-3'>
									{t(prefix + column)}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{props.rows.map((row) => {
							const count = row.metadata_preview?.field_count ?? null
							let metadata = '—'
							if (row.metadata_unavailable)
								metadata = t(prefix + 'metadataUnavailableShort')
							else if (count !== null)
								metadata = t(prefix + 'metadataCount', { count })
							let budget = '—'
							if (props.currency) {
								const maximum =
									row.budget_max === null
										? t(prefix + 'unlimited')
										: money(row.budget_max)
								budget = money(row.budget_spent) + ' / ' + maximum
							}
							const ratio =
								props.currency !== null &&
								row.budget_max !== null &&
								row.budget_max > 0
									? Math.min(1, Math.max(0, row.budget_spent / row.budget_max))
									: null
							return (
								<tr key={row.id} className='border-b align-top'>
									<td className='max-w-60 p-3'>
										<p className='font-medium break-all'>
											{row.user_email ?? '—'}
										</p>
										<p className='text-muted-foreground text-xs break-all'>
											{row.user_id}
										</p>
										<span className='bg-muted mt-1 inline-block rounded-full px-2 py-0.5 text-xs'>
											{t(prefix + row.status)}
										</span>
									</td>
									<td className='p-3'>
										<code className='text-xs'>{row.key}</code>
										<p className='text-muted-foreground mt-1 max-w-36 text-xs break-all'>
											{row.id}
										</p>
										<Button
											type='button'
											size='sm'
											variant='outline'
											className='mt-2'
											onClick={() => void copyId(row.id)}
										>
											{t(prefix + (copiedId === row.id ? 'copied' : 'copyId'))}
										</Button>
									</td>
									<td className='max-w-44 p-3 break-words'>
										{row.name ?? '—'}
									</td>
									<td className='p-3'>
										<p className='whitespace-nowrap tabular-nums'>{budget}</p>
										{props.currency && (
											<p className='text-muted-foreground mt-1 text-xs'>
												{t(prefix + 'base')}: {money(row.budget_base)}
											</p>
										)}
										{ratio !== null && (
											<progress
												className='accent-primary mt-2 h-2 w-full'
												max={1}
												value={ratio}
												aria-label={t(prefix + 'budgetUsage')}
											/>
										)}
										<p className='text-muted-foreground mt-1 text-xs'>
											{t(prefix + row.budget_period)}
										</p>
										{row.budget_reset_at && (
											<p className='text-muted-foreground mt-1 max-w-48 text-xs'>
												{formatUserDetailTime(
													row.budget_reset_at,
													locale,
													'UTC'
												)}
											</p>
										)}
									</td>
									<td className='p-3 text-xs'>{metadata}</td>
									<td className='p-3 text-xs whitespace-nowrap'>
										{formatUserDetailTime(row.created_at, locale, 'UTC')}
									</td>
									<td className='max-w-64 space-y-3 p-3'>
										<GatewayKeyLinks
											row={row}
											capabilities={props.capabilities}
										/>
										<div className='flex flex-wrap gap-2'>
											<Button
												type='button'
												size='sm'
												variant='outline'
												onClick={() => props.onEdit(row)}
											>
												{t(prefix + 'edit')}
											</Button>
											{props.capabilities.effective_guardrails && (
												<Button
													type='button'
													size='sm'
													variant='outline'
													onClick={() => props.onEdit(row)}
												>
													{t(prefix + 'effectiveGuardrails')}
												</Button>
											)}
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite}
												onClick={() => props.onStatus(row)}
											>
												{t(
													prefix +
														(row.status === 'active' ? 'revoke' : 'activate')
												)}
											</Button>
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite}
												onClick={() => props.onTombstone(row)}
											>
												{t(prefix + 'tombstone')}
											</Button>
										</div>
									</td>
								</tr>
							)
						})}
					</tbody>
				</table>
			</div>
			{props.rows.length === 0 && (
				<p className='text-muted-foreground p-10 text-center text-sm'>
					{t(prefix + 'empty')}
				</p>
			)}
		</div>
	)
}
