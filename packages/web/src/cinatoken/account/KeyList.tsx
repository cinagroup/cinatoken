import { KeyRound, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import type { GatewayKey } from '../contracts'
import { formatAccountDate, formatKeyLimit, keyStatus } from './key-display'
import { useAccountClock } from './use-account-clock'

type KeyListProps = {
	keys: GatewayKey[]
	billingCurrency: string
	isPending: boolean
	onCreate: () => void
	onRevoke: (key: GatewayKey) => void
}

function KeyItem(props: {
	gatewayKey: GatewayKey
	billingCurrency: string
	now: number
	isPending: boolean
	onRevoke: (key: GatewayKey) => void
}) {
	const { t, i18n } = useTranslation()
	const row = props.gatewayKey
	const status = keyStatus(row, props.now)
	const displayStatus = ['active', 'revoked', 'disabled', 'expired'].includes(
		status
	)
		? t(`cinatoken.account.keys.statuses.${status}`)
		: status
	const expiry = row.expiresAt
		? formatAccountDate(row.expiresAt, i18n.language)
		: t('cinatoken.account.keys.neverExpires')
	const lastUsed = row.lastUsedAt
		? formatAccountDate(row.lastUsedAt, i18n.language)
		: t('cinatoken.account.keys.neverUsed')
	return (
		<Card className='shadow-none'>
			<CardContent className='space-y-4'>
				<div className='flex flex-wrap items-start justify-between gap-3'>
					<div className='min-w-0 flex-1'>
						<div className='flex flex-wrap items-center gap-2'>
							<h3 className='font-semibold break-all'>
								{row.name || t('cinatoken.account.keys.unnamed')}
							</h3>
							<Badge variant={status === 'active' ? 'secondary' : 'outline'}>
								{displayStatus}
							</Badge>
						</div>
						<code className='text-muted-foreground mt-1 block font-mono text-xs'>
							{row.key}
						</code>
					</div>
					{row.status === 'active' && (
						<Button
							variant='destructive'
							size='sm'
							disabled={props.isPending}
							onClick={() => props.onRevoke(row)}
							aria-label={t('cinatoken.account.keys.revokeNamed', {
								name: row.name || row.key,
							})}
						>
							{t('cinatoken.account.keys.revoke')}
						</Button>
					)}
				</div>
				<dl className='grid gap-x-5 gap-y-3 border-t pt-4 sm:grid-cols-2 lg:grid-cols-4'>
					<div>
						<dt className='text-muted-foreground mb-1 text-xs'>
							{t('cinatoken.account.keys.limitColumn')}
						</dt>
						<dd className='text-sm'>
							{row.limit === null
								? t('cinatoken.account.keys.unlimited')
								: formatKeyLimit(
										row.limit,
										i18n.language,
										props.billingCurrency
									)}
							{row.limit !== null && (
								<span className='text-muted-foreground mt-0.5 block text-xs'>
									{t(`cinatoken.account.keys.${row.limitReset ?? 'lifetime'}`)}
								</span>
							)}
						</dd>
					</div>
					<div>
						<dt className='text-muted-foreground mb-1 text-xs'>
							{t('cinatoken.account.keys.lastUsed')}
						</dt>
						<dd className='text-sm'>{lastUsed}</dd>
					</div>
					<div>
						<dt className='text-muted-foreground mb-1 text-xs'>
							{t('cinatoken.account.keys.expires')}
						</dt>
						<dd className='text-sm'>{expiry}</dd>
					</div>
					<div>
						<dt className='text-muted-foreground mb-1 text-xs'>
							{t('cinatoken.account.keys.created')}
						</dt>
						<dd className='text-sm'>
							{formatAccountDate(row.createdAt, i18n.language)}
						</dd>
					</div>
				</dl>
			</CardContent>
		</Card>
	)
}

export function KeyList(props: KeyListProps) {
	const { t } = useTranslation()
	const now = useAccountClock()
	if (props.keys.length === 0)
		return (
			<Card>
				<CardContent className='flex flex-col items-center py-12 text-center'>
					<div className='bg-muted/50 mb-4 flex size-12 items-center justify-center rounded-2xl border'>
						<KeyRound
							aria-hidden='true'
							className='text-muted-foreground size-5'
						/>
					</div>
					<h2 className='text-lg font-semibold'>
						{t('cinatoken.account.keys.emptyTitle')}
					</h2>
					<p className='text-muted-foreground mt-2 max-w-sm text-sm'>
						{t('cinatoken.account.keys.empty')}
					</p>
					<Button
						className='mt-5'
						disabled={props.isPending}
						onClick={props.onCreate}
					>
						<Plus aria-hidden='true' />
						{t('cinatoken.account.keys.create')}
					</Button>
				</CardContent>
			</Card>
		)
	return (
		<div className='space-y-3'>
			{props.keys.map((key) => (
				<KeyItem
					key={key.id}
					gatewayKey={key}
					billingCurrency={props.billingCurrency}
					now={now}
					isPending={props.isPending}
					onRevoke={props.onRevoke}
				/>
			))}
		</div>
	)
}
