import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { ManagementKey } from '../contracts'
import { formatAccountDate, keyStatus } from './key-display'
import { useAccountClock } from './use-account-clock'

type Props = {
	keys: ManagementKey[]
	isPending: boolean
	onRevoke: (key: ManagementKey) => void
}

export function ManagementKeyList(props: Props) {
	const { t, i18n } = useTranslation()
	const now = useAccountClock()
	return (
		<div className='space-y-3'>
			{props.keys.map((row) => {
				const status = keyStatus(
					{ status: row.status, expiresAt: row.expires_at },
					now
				)
				return (
					<Card key={row.id}>
						<CardContent className='space-y-4'>
							<div className='flex flex-wrap items-start justify-between gap-3'>
								<div className='min-w-0 flex-1'>
									<div className='flex flex-wrap items-center gap-2'>
										<h3 className='font-semibold break-all'>{row.name}</h3>
										<Badge
											variant={status === 'active' ? 'secondary' : 'outline'}
										>
											{t(`cinatoken.account.keys.statuses.${status}`)}
										</Badge>
									</div>
									<code className='text-muted-foreground mt-1 block font-mono text-xs break-all'>
										{row.label}
									</code>
								</div>
								{row.status === 'active' && (
									<Button
										variant='destructive'
										size='sm'
										disabled={props.isPending}
										aria-label={t(
											'cinatoken.account.managementKeys.revokeNamed',
											{ name: row.name }
										)}
										onClick={() => props.onRevoke(row)}
									>
										{t('cinatoken.account.keys.revoke')}
									</Button>
								)}
							</div>
							<dl className='grid gap-x-5 gap-y-3 border-t pt-4 sm:grid-cols-3'>
								<div>
									<dt className='text-muted-foreground mb-1 text-xs'>
										{t('cinatoken.account.keys.expires')}
									</dt>
									<dd>
										{row.expires_at
											? formatAccountDate(row.expires_at, i18n.language)
											: t('cinatoken.account.keys.neverExpires')}
									</dd>
								</div>
								<div>
									<dt className='text-muted-foreground mb-1 text-xs'>
										{t('cinatoken.account.keys.lastUsed')}
									</dt>
									<dd>
										{row.last_used_at
											? formatAccountDate(row.last_used_at, i18n.language)
											: t('cinatoken.account.keys.neverUsed')}
									</dd>
								</div>
								<div>
									<dt className='text-muted-foreground mb-1 text-xs'>
										{t('cinatoken.account.keys.created')}
									</dt>
									<dd>{formatAccountDate(row.created_at, i18n.language)}</dd>
								</div>
							</dl>
						</CardContent>
					</Card>
				)
			})}
		</div>
	)
}
