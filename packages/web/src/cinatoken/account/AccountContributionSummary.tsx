import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { CinaTokenApiError } from '../api'
import type { PortalMe } from '../contracts'
import { canRequestNft } from '../nft-contracts'
import { useCinaTokenSession } from '../session-context'
import {
	invalidatesAccountAccess,
	isUserMismatch,
	requiresSessionRevalidation,
} from './account-access'
import { formatEarningsMoney } from './earnings/earnings-display'
import { useContributionSummary } from './use-contribution-summary'

export function AccountContributionSummary(props: {
	user: PortalMe
	workspaceId: string
	scopeVersion: number
}) {
	const { t, i18n } = useTranslation()
	const session = useCinaTokenSession()
	const locale = i18n.resolvedLanguage ?? 'en'
	const { canEarn, canShare, canNft, earnings, shared, nft } =
		useContributionSummary(props)
	const errors = [earnings.error, shared.error, nft.error]
	const blocked = errors.some(
		(error) =>
			invalidatesAccountAccess(error) ||
			(error instanceof CinaTokenApiError && error.code === 'invalid-response')
	)
	const mismatch = errors.some(requiresSessionRevalidation)
	const busy = earnings.isFetching || shared.isFetching || nft.isFetching
	const retry = () => {
		if (mismatch) {
			void session.revalidateScope()
			return
		}
		void Promise.all([
			canEarn ? earnings.refetch() : undefined,
			canShare ? shared.refetch() : undefined,
			canNft ? nft.refetch() : undefined,
		])
	}
	if (!canEarn && !canShare && !canNft) return null
	if (blocked)
		return (
			<Alert>
				<AlertDescription>
					{t(
						errors.some(isUserMismatch)
							? 'cinatoken.account.sessionChanged'
							: `cinatoken.account.contribution.${mismatch ? 'mismatch' : 'failed'}`
					)}
				</AlertDescription>
				<Button
					variant='outline'
					className='mt-3 w-fit'
					disabled={busy}
					onClick={retry}
				>
					{t('cinatoken.account.contribution.retry')}
				</Button>
			</Alert>
		)
	const summary = earnings.isSuccess ? earnings.data.data : null
	const tiers =
		nft.isSuccess && nft.data.availability === 'available'
			? nft.data.data.tiers
			: []
	const nextTier = [...tiers]
		.sort((a, b) => a.threshold - b.threshold)
		.find((tier) => !tier.minted && !tier.eligible)
	const mintable = nft.isSuccess
		? tiers.filter((tier) => canRequestNft(nft.data, tier)).length
		: 0
	const recent = shared.isSuccess
		? [...shared.data.keys]
				.sort(
					(a, b) =>
						Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
						a.id.localeCompare(b.id)
				)
				.slice(0, 5)
		: []
	const number = new Intl.NumberFormat(locale)
	const money = (value: number) => formatEarningsMoney(value, 'USD', locale)
	return (
		<section className='space-y-4' aria-labelledby='contribution-title'>
			<div>
				<h2 id='contribution-title' className='text-lg font-semibold'>
					{t('cinatoken.account.contribution.title')}
				</h2>
				<p className='text-muted-foreground mt-1 text-xs'>
					{t('cinatoken.account.contribution.scope')}
				</p>
			</div>
			{errors.some(Boolean) && (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.contribution.failed')}
					</AlertDescription>
					<Button
						variant='outline'
						className='mt-3 w-fit'
						disabled={busy}
						onClick={retry}
					>
						{t('cinatoken.account.contribution.retry')}
					</Button>
				</Alert>
			)}
			<div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
				{canEarn &&
					(earnings.isPending ? (
						<Skeleton className='h-32 rounded-xl' />
					) : (
						summary && (
							<>
								<SummaryMetric
									label={t('cinatoken.account.contribution.balance')}
									value={money(summary.balance)}
									hint={t('cinatoken.account.contribution.locked', {
										amount: money(summary.lockedAmount),
									})}
								/>
								<SummaryMetric
									label={t('cinatoken.account.contribution.contribution')}
									value={money(summary.contributionValue)}
									hint={
										nextTier
											? t('cinatoken.account.contribution.nextTier', {
													tier: nextTier.tierName,
													threshold: money(nextTier.threshold),
													progress: number.format(
														Math.floor(nextTier.progress * 100)
													),
												})
											: undefined
									}
								/>
								<SummaryMetric
									label={t('cinatoken.account.contribution.earned')}
									value={money(summary.lifetimeEarned)}
									hint={t('cinatoken.account.contribution.withdrawn', {
										amount: money(summary.lifetimeWithdrawn),
									})}
								/>
							</>
						)
					))}
				{canShare &&
					(shared.isPending ? (
						<Skeleton className='h-32 rounded-xl' />
					) : (
						shared.isSuccess && (
							<SummaryMetric
								label={t('cinatoken.account.contribution.active')}
								value={number.format(
									shared.data.keys.filter((row) => row.status === 'active')
										.length
								)}
								hint={t('cinatoken.account.contribution.total', {
									count: shared.data.keys.length,
								})}
							/>
						)
					))}
			</div>
			{canEarn &&
				earnings.isSuccess &&
				earnings.data.availability === 'unavailable' && (
					<p className='text-muted-foreground text-sm'>
						{t('cinatoken.account.contribution.unavailable')}
					</p>
				)}
			{canNft && nft.isSuccess && (
				<Card>
					<CardContent className='flex flex-wrap items-center justify-between gap-3'>
						<p className='text-sm'>
							{nft.data.availability === 'unavailable'
								? t('cinatoken.account.contribution.unavailable')
								: t('cinatoken.account.contribution.availableBadges', {
										count: mintable,
									})}
						</p>
						<Button variant='outline' render={<Link to='/account/nft' />}>
							{t('cinatoken.account.contribution.badges')}
						</Button>
					</CardContent>
				</Card>
			)}
			{canShare && shared.isSuccess && (
				<Card>
					<CardHeader>
						<CardTitle>{t('cinatoken.account.contribution.recent')}</CardTitle>
					</CardHeader>
					<CardContent>
						{recent.length === 0 ? (
							<p className='text-muted-foreground text-sm'>
								{t('cinatoken.account.contribution.empty')}
							</p>
						) : (
							<div className='overflow-x-auto'>
								<table className='w-full min-w-96 text-sm'>
									<thead>
										<tr className='text-muted-foreground border-b text-left'>
											<th className='py-2 pr-4'>
												{t('cinatoken.account.contribution.channel')}
											</th>
											<th className='py-2 pr-4'>
												{t('cinatoken.account.contribution.status')}
											</th>
											<th className='py-2 pr-4'>
												{t('cinatoken.account.contribution.tokens')}
											</th>
											<th className='py-2'>
												{t('cinatoken.account.contribution.earnings')}
											</th>
										</tr>
									</thead>
									<tbody>
										{recent.map((row) => (
											<tr key={row.id} className='border-b last:border-0'>
												<td className='py-3 pr-4'>{row.channelType}</td>
												<td className='py-3 pr-4'>
													<Badge variant='outline'>
														{t(
															`cinatoken.account.sharedKeys.status_${row.status}`
														)}
													</Badge>
												</td>
												<td className='py-3 pr-4 tabular-nums'>
													{number.format(
														BigInt(row.servedInputTokens) +
															BigInt(row.servedOutputTokens)
													)}
												</td>
												<td className='py-3 tabular-nums'>
													{formatEarningsMoney(
														row.earnedTotal,
														shared.data.earningsCurrency,
														locale
													)}
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
						<Button
							className='mt-4'
							variant='outline'
							render={<Link to='/account/keys' />}
						>
							{t('cinatoken.account.contribution.manage')}
						</Button>
					</CardContent>
				</Card>
			)}
			{canEarn && (
				<Button
					variant='link'
					className='px-0'
					render={<Link to='/account/earnings' />}
				>
					{t('cinatoken.account.contribution.details')}
				</Button>
			)}
		</section>
	)
}

function SummaryMetric(props: { label: string; value: string; hint?: string }) {
	return (
		<Card>
			<CardHeader>
				<CardDescription>{props.label}</CardDescription>
				<CardTitle className='text-2xl break-words tabular-nums'>
					{props.value}
				</CardTitle>
			</CardHeader>
			{props.hint && (
				<CardContent className='text-muted-foreground text-xs'>
					{props.hint}
				</CardContent>
			)}
		</Card>
	)
}
