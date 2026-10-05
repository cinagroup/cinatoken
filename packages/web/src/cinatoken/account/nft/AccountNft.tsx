import { Award, ExternalLink, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { NftApi } from '../../nft-api'
import {
	canRequestNft,
	hasPendingNft,
	nftTransactionUrl,
} from '../../nft-contracts'
import { useCinaTokenSession } from '../../session-context'
import { nftErrorKey, useNftManager, type NftScope } from './use-nft-manager'

function ScopedNft(props: { api: NftApi; scope: NftScope }) {
	const { t, i18n } = useTranslation()
	const manager = useNftManager(props.api, props.scope)
	const query = manager.query
	const text = (key: string) => t(`cinatoken.account.nft.${key}`)
	const money = (value: number) =>
		new Intl.NumberFormat(i18n.resolvedLanguage, {
			style: 'currency',
			currency: 'USD',
		}).format(value)
	const time = (value: string) =>
		new Intl.DateTimeFormat(i18n.resolvedLanguage, {
			dateStyle: 'medium',
			timeStyle: 'short',
		}).format(new Date(value))
	const tierName = (name: string) =>
		['Bronze', 'Silver', 'Gold', 'Platinum'].includes(name) ? text(name) : name
	const snapshot = !manager.blocked && !query.isError ? query.data : undefined
	return (
		<div className='space-y-5'>
			<div className='flex justify-end'>
				<Button
					variant='outline'
					disabled={query.isFetching || manager.minting !== null}
					onClick={() => void manager.refresh()}
				>
					<RefreshCw
						aria-hidden='true'
						className={query.isFetching ? 'animate-spin' : ''}
					/>
					{text('refresh')}
				</Button>
			</div>
			{query.isPending ? (
				<div role='status' className='space-y-3'>
					<p className='text-muted-foreground text-sm'>{text('loading')}</p>
					<Skeleton className='h-28' />
					<Skeleton className='h-60' />
				</div>
			) : null}
			{query.isError || manager.blocked ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text(manager.blocked ?? 'loadFailed')}{' '}
						<Button variant='link' onClick={() => void manager.refresh()}>
							{text('retry')}
						</Button>
					</AlertDescription>
				</Alert>
			) : null}
			{manager.notice ? (
				<p role='status' className='bg-muted rounded-lg border p-3 text-sm'>
					{text(manager.notice)}
				</p>
			) : null}
			{manager.mutationError ? (
				<Alert variant='destructive'>
					<AlertDescription>
						{text(nftErrorKey(manager.mutationError))}
					</AlertDescription>
				</Alert>
			) : null}
			{snapshot ? (
				<>
					{snapshot.availability === 'unavailable' ? (
						<Alert>
							<AlertDescription>{text('unavailable')}</AlertDescription>
						</Alert>
					) : (
						<Card>
							<CardHeader>
								<CardTitle className='text-sm'>
									{text('contribution')}
								</CardTitle>
							</CardHeader>
							<CardContent>
								<p className='text-3xl font-semibold tabular-nums'>
									{money(snapshot.data.contributionValue)}
								</p>
								<p className='text-muted-foreground mt-2 text-sm'>
									{text('contributionHint')}
								</p>
								<p className='mt-3 text-sm'>
									{text('highestTier')}: {snapshot.data.highestBadgeTier}
								</p>
							</CardContent>
						</Card>
					)}
					{!snapshot.data.chainConfigured ? (
						<Alert>
							<AlertDescription>{text('chainUnavailable')}</AlertDescription>
						</Alert>
					) : null}
					{!snapshot.data.walletBound ? (
						<Alert>
							<AlertDescription>
								{text('walletRequired')}{' '}
								<a
									className='underline underline-offset-4'
									href='/account/withdraw'
								>
									{text('walletLink')}
								</a>
							</AlertDescription>
						</Alert>
					) : null}
					{snapshot.availability === 'available' ? (
						<div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
							{snapshot.data.tiers.map((tier) => {
								const existing = snapshot.data.mints.find(
									(row) => row.badgeTokenId === tier.badgeTokenId
								)
								const percent = Math.floor(tier.progress * 100)
								return (
									<Card key={tier.badgeTokenId}>
										<CardHeader>
											<CardTitle className='flex items-center justify-between gap-2 text-base'>
												<span>{tierName(tier.tierName)}</span>
												<Award
													aria-hidden='true'
													className='text-muted-foreground size-5'
												/>
											</CardTitle>
											<p className='text-muted-foreground text-xs'>
												#{tier.badgeTokenId} · {text('threshold')}:{' '}
												{money(tier.threshold)}
											</p>
										</CardHeader>
										<CardContent className='space-y-3'>
											<div
												role='progressbar'
												aria-label={`${tierName(tier.tierName)} ${text('progress')}`}
												aria-valuemin={0}
												aria-valuemax={100}
												aria-valuenow={percent}
												className='bg-muted h-2 overflow-hidden rounded-full'
											>
												<div
													className='bg-primary h-full'
													style={{ width: `${percent}%` }}
												/>
											</div>
											<p className='text-muted-foreground text-xs'>
												{text('progress')}: {percent}%
											</p>
											{existing || tier.minted ? (
												<Badge
													variant={
														existing?.status === 'failed'
															? 'destructive'
															: 'secondary'
													}
												>
													{existing
														? text(`status_${existing.status}`)
														: text('requested')}
												</Badge>
											) : (
												<Button
													className='w-full'
													disabled={
														manager.minting !== null ||
														query.isFetching ||
														!canRequestNft(snapshot, tier)
													}
													onClick={() => void manager.mint(tier)}
												>
													{manager.minting === tier.badgeTokenId
														? text('minting')
														: text('mint')}
												</Button>
											)}
										</CardContent>
									</Card>
								)
							})}
							{snapshot.data.tiers.length === 0 ? (
								<p className='text-muted-foreground text-sm'>
									{text('noTiers')}
								</p>
							) : null}
						</div>
					) : null}
					<Card>
						<CardHeader>
							<CardTitle className='text-base'>{text('history')}</CardTitle>
							{hasPendingNft(snapshot.data.mints) ? (
								<p className='text-muted-foreground text-xs'>
									{text('polling')}
								</p>
							) : null}
						</CardHeader>
						<CardContent>
							{snapshot.data.mints.length === 0 ? (
								<p className='text-muted-foreground py-6 text-center text-sm'>
									{text('empty')}
								</p>
							) : (
								<ul className='divide-y'>
									{snapshot.data.mints.map((mint) => {
										const transaction = nftTransactionUrl(mint)
										return (
											<li
												key={mint.id}
												className='space-y-3 py-4 first:pt-0 last:pb-0'
											>
												<div className='flex flex-wrap items-center justify-between gap-2'>
													<p className='font-medium'>
														{tierName(mint.tierName)}{' '}
														<span className='text-muted-foreground text-xs'>
															#{mint.badgeTokenId}
														</span>
													</p>
													<Badge
														variant={
															mint.status === 'failed'
																? 'destructive'
																: 'secondary'
														}
													>
														{text(`status_${mint.status}`)}
													</Badge>
												</div>
												<dl className='text-muted-foreground grid gap-x-6 gap-y-2 text-xs sm:grid-cols-2'>
													<div>
														<dt>{text('created')}</dt>
														<dd className='text-foreground mt-1'>
															{time(mint.createdAt)}
														</dd>
													</div>
													<div>
														<dt>{text('snapshot')}</dt>
														<dd className='text-foreground mt-1'>
															{money(mint.valueSnapshot)}
														</dd>
													</div>
													<div>
														<dt>{text('wallet')}</dt>
														<dd className='text-foreground mt-1 font-mono break-all'>
															{mint.walletAddress}
														</dd>
													</div>
													{mint.confirmedAt ? (
														<div>
															<dt>{text('confirmed')}</dt>
															<dd className='text-foreground mt-1'>
																{time(mint.confirmedAt)}
															</dd>
														</div>
													) : null}
													{mint.chainId ? (
														<div>
															<dt>{text('chain')}</dt>
															<dd className='text-foreground mt-1'>
																{mint.chainId}
															</dd>
														</div>
													) : null}
													{mint.txHash ? (
														<div className='min-w-0'>
															<dt>{text('transaction')}</dt>
															<dd className='text-foreground mt-1 font-mono break-all'>
																{mint.txHash}
															</dd>
														</div>
													) : null}
												</dl>
												{transaction ? (
													<a
														href={transaction}
														target='_blank'
														rel='noopener noreferrer'
														className='text-primary inline-flex items-center gap-1 text-xs underline underline-offset-4'
													>
														{text('viewTx')}
														<ExternalLink
															aria-hidden='true'
															className='size-3'
														/>
													</a>
												) : null}
												{mint.status === 'failed' ? (
													<Alert variant='destructive'>
														<AlertDescription>
															<p>{text('failedHelp')}</p>
															{mint.failureReason ? (
																<p className='mt-1 break-words'>
																	{mint.failureReason}
																</p>
															) : null}
														</AlertDescription>
													</Alert>
												) : null}
											</li>
										)
									})}
								</ul>
							)}
						</CardContent>
					</Card>
				</>
			) : null}
		</div>
	)
}

/** User ledger ownership is independent of the selected organization's role. */
export function AccountNft(props: { api: NftApi }) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	if (
		session.status !== 'authenticated' ||
		!session.user ||
		!session.workspaceContext ||
		session.isSwitchingWorkspace ||
		session.isLoggingOut
	)
		return null
	const workspace = session.workspaceContext.currentWorkspace
	return (
		<section aria-labelledby='nft-title' className='space-y-6'>
			<header className='space-y-2'>
				<h1 id='nft-title' className='text-2xl font-semibold tracking-tight'>
					{t('cinatoken.account.nft.title')}
				</h1>
				<p className='text-muted-foreground max-w-3xl text-sm leading-6'>
					{t('cinatoken.account.nft.subtitle')}
				</p>
			</header>
			{session.user.capabilities.includes('nft.read') ? (
				<ScopedNft
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					api={props.api}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						scopeVersion: session.scopeVersion,
					}}
				/>
			) : (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.nft.noCapability')}
					</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
