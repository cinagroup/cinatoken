/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import type { UserDetailKey } from './user-detail-contracts'
import { formatUserDetailTime } from './user-detail-format'

const prefix = 'cinatoken.adminUserDetail.'
const keyPrefix = 'cinatoken.adminGatewayKeys.'
export function UserDetailKeysTable(props: {
	keys: UserDetailKey[]
	timezone: string | null
	canWrite: boolean
	busy: boolean
	onStatus: (keyId: string, status: 'active' | 'revoked') => Promise<void>
	onDelete: (keyId: string) => Promise<void>
	onEdit: (row: UserDetailKey) => void
}) {
	const { t, i18n } = useTranslation()
	return (
		<div className='overflow-x-auto'>
			<table className='w-full min-w-[730px] text-left text-sm'>
				<thead>
					<tr className='border-b text-xs'>
						<th className='p-2'>{t(prefix + 'keyName')}</th>
						<th className='p-2'>{t(prefix + 'keyPreview')}</th>
						<th className='p-2'>{t(prefix + 'status')}</th>
						<th className='p-2'>
							{t(prefix + 'time', { timezone: props.timezone ?? 'UTC' })}
						</th>
						<th className='p-2'>{t(prefix + 'metadata')}</th>
						<th className='p-2'>—</th>
					</tr>
				</thead>
				<tbody>
					{props.keys.map((row) => {
						let status = row.status
						if (row.status === 'active') status = t(prefix + 'active')
						else if (row.status === 'revoked') status = t(prefix + 'revoke')
						let summary = '—'
						if (row.metadata_unavailable)
							summary = t(keyPrefix + 'metadataUnavailableShort')
						else if (row.metadata_preview)
							summary = t(keyPrefix + 'metadataCount', {
								count: row.metadata_preview.field_count,
							})
						return (
							<tr key={row.id} className='border-b align-top'>
								<td className='p-2'>
									<span>{row.name ?? '—'}</span>
									<code className='text-muted-foreground block text-xs break-all'>
										{row.id}
									</code>
								</td>
								<td className='p-2 font-mono text-xs'>{row.key}</td>
								<td className='p-2'>{status}</td>
								<td className='p-2 text-xs whitespace-nowrap'>
									{formatUserDetailTime(
										row.last_used_at ?? row.created_at,
										i18n.resolvedLanguage ?? 'en',
										props.timezone
									)}
								</td>
								<td className='p-2'>{summary}</td>
								<td className='p-2'>
									<div className='flex flex-wrap gap-1'>
										<Button
											type='button'
											size='sm'
											variant='outline'
											disabled={!props.canWrite || props.busy}
											onClick={() => props.onEdit(row)}
										>
											{t(keyPrefix + 'edit')}
										</Button>
										{(row.status === 'active' || row.status === 'revoked') && (
											<Button
												type='button'
												size='sm'
												variant='outline'
												disabled={!props.canWrite || props.busy}
												onClick={() =>
													void props.onStatus(
														row.id,
														row.status === 'active' ? 'revoked' : 'active'
													)
												}
											>
												{t(
													prefix +
														(row.status === 'active' ? 'revoke' : 'activate')
												)}
											</Button>
										)}
										<Button
											type='button'
											size='sm'
											variant='outline'
											disabled={!props.canWrite || props.busy}
											onClick={() => {
												if (window.confirm(t(prefix + 'deleteKeyConfirm')))
													void props.onDelete(row.id)
											}}
										>
											{t(prefix + 'deleteKey')}
										</Button>
									</div>
								</td>
							</tr>
						)
					})}
				</tbody>
			</table>
			{props.keys.length === 0 && (
				<p className='text-muted-foreground p-3 text-sm'>
					{t(prefix + 'empty')}
				</p>
			)}
		</div>
	)
}
