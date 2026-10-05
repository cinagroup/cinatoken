import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { accountQueryKey, CinaTokenApiError } from '../../api'
import type { EarningsApi, EarningsRequestOptions } from '../../earnings-api'
import { useCinaTokenSession } from '../../session-context'
import {
	invalidatesAccountAccess,
	isUserMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import { EarningsList } from './EarningsList'
import { EarningsSummaryCards } from './EarningsSummaryCards'
import { earningsPageCount } from './earnings-display'

type Scope = { userId: string; workspaceId: string; version: number }
function unsafeContext(error: unknown) {
	return (
		error instanceof CinaTokenApiError &&
		(invalidatesAccountAccess(error) || error.code === 'invalid-response')
	)
}

function ScopedEarnings(props: {
	api: EarningsApi
	scope: Scope
	revalidate: () => Promise<void>
}) {
	const { t } = useTranslation()
	const [page, setPage] = useState(1)
	const options = useMemo<EarningsRequestOptions>(
		() => ({
			expectedSellerUserId: props.scope.userId,
			expectedUserId: props.scope.userId,
			expectedWorkspaceId: props.scope.workspaceId,
		}),
		[props.scope.userId, props.scope.workspaceId]
	)
	const queryKey = accountQueryKey(
		props.scope.userId,
		props.scope.workspaceId,
		'earnings',
		props.scope.version
	)
	const summary = useQuery({
		queryKey: [...queryKey, 'summary', options],
		queryFn: ({ signal }) => props.api.earningsSummary({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const list = useQuery({
		queryKey: [...queryKey, 'list', page, options],
		queryFn: ({ signal }) =>
			props.api.earnings({ ...options, page, pageSize: 20, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const errors = [summary.error, list.error]
	const blocked = errors.some(unsafeContext)
	const revalidation = errors.some(requiresSessionRevalidation)
	const busy = summary.isFetching || list.isFetching
	const retry = () => {
		if (revalidation) {
			void props.revalidate()
			return
		}
		void Promise.all([summary.refetch(), list.refetch()])
	}
	const total = list.data?.total ?? 0
	const pages = earningsPageCount(total)
	return (
		<div className='space-y-5'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<div className='flex flex-wrap gap-2'>
					<Badge variant='outline'>
						{t('cinatoken.account.earnings.scope')}
					</Badge>
					<Badge variant='secondary'>
						{t('cinatoken.account.earnings.ledger')}
					</Badge>
				</div>
				<Button variant='outline' disabled={busy} onClick={retry}>
					<RefreshCw
						aria-hidden='true'
						className={busy ? 'animate-spin' : ''}
					/>
					{t('cinatoken.account.earnings.refresh')}
				</Button>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.account.earnings.units')}
			</p>
			{blocked && (
				<Alert>
					<AlertDescription>
						{t(
							errors.some(isUserMismatch)
								? 'cinatoken.account.sessionChanged'
								: revalidation
									? 'cinatoken.account.earnings.mismatch'
									: 'cinatoken.account.earnings.access'
						)}
					</AlertDescription>
					<Button
						className='mt-3 w-fit'
						variant='outline'
						disabled={busy}
						onClick={retry}
					>
						{t(
							revalidation
								? 'cinatoken.account.earnings.verify'
								: 'cinatoken.account.earnings.retry'
						)}
					</Button>
				</Alert>
			)}
			{!blocked && (
				<>
					{summary.isPending && (
						<Skeleton
							role='status'
							aria-label={t('cinatoken.account.earnings.loading')}
							className='h-48'
						/>
					)}
					{summary.isError && (
						<Alert variant='destructive'>
							<AlertDescription>
								{t('cinatoken.account.earnings.error')}
							</AlertDescription>
							<Button
								className='mt-3 w-fit'
								variant='outline'
								disabled={summary.isFetching}
								onClick={() => void summary.refetch()}
							>
								{t('cinatoken.account.earnings.retry')}
							</Button>
						</Alert>
					)}
					{summary.isSuccess && summary.data.data === null && (
						<Alert>
							<AlertTitle>
								{t('cinatoken.account.earnings.unavailable')}
							</AlertTitle>
							<AlertDescription>
								{t('cinatoken.account.earnings.unavailableHint')}
							</AlertDescription>
							<Button
								className='mt-3 w-fit'
								variant='outline'
								disabled={summary.isFetching}
								onClick={() => void summary.refetch()}
							>
								{t('cinatoken.account.earnings.retry')}
							</Button>
						</Alert>
					)}
					{summary.isSuccess && summary.data.data && (
						<EarningsSummaryCards summary={summary.data.data} />
					)}
					<div className='flex flex-wrap gap-4 text-sm'>
						<a
							className='underline underline-offset-4'
							href='/account/withdraw'
						>
							{t('cinatoken.account.earnings.wallet')}
						</a>
						<a className='underline underline-offset-4' href='/account/nft'>
							{t('cinatoken.account.earnings.badges')}
						</a>
					</div>
					<section
						className='space-y-3'
						aria-labelledby='recorded-earnings-title'
					>
						<h2 id='recorded-earnings-title' className='font-semibold'>
							{t('cinatoken.account.earnings.recorded')}
						</h2>
						<p className='text-muted-foreground text-xs leading-5'>
							{t('cinatoken.account.earnings.recordedHint')}
						</p>
						{list.isPending && (
							<Skeleton
								role='status'
								aria-label={t('cinatoken.account.earnings.loading')}
								className='h-48'
							/>
						)}
						{list.isError && (
							<Alert variant='destructive'>
								<AlertDescription>
									{t('cinatoken.account.earnings.error')}
								</AlertDescription>
								<Button
									className='mt-3 w-fit'
									variant='outline'
									disabled={list.isFetching}
									onClick={() => void list.refetch()}
								>
									{t('cinatoken.account.earnings.retry')}
								</Button>
							</Alert>
						)}
						{list.isSuccess && list.data.data.length === 0 && (
							<Card>
								<CardContent className='space-y-2 p-6 text-center'>
									<p className='font-medium'>
										{t('cinatoken.account.earnings.empty')}
									</p>
									<p className='text-muted-foreground text-sm'>
										{t('cinatoken.account.earnings.emptyHint')}
									</p>
								</CardContent>
							</Card>
						)}
						{list.isSuccess && list.data.data.length > 0 && (
							<EarningsList rows={list.data.data} />
						)}
						{list.isSuccess && total > 0 && (
							<div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
								<p className='text-muted-foreground'>
									{t('cinatoken.account.earnings.pagination', {
										page,
										pages,
										total,
									})}
								</p>
								<div className='flex gap-2'>
									<Button
										size='sm'
										variant='outline'
										disabled={page === 1 || list.isFetching}
										onClick={() => setPage((value) => Math.max(1, value - 1))}
									>
										{t('cinatoken.account.earnings.previous')}
									</Button>
									<Button
										size='sm'
										variant='outline'
										disabled={page >= pages || list.isFetching}
										onClick={() => setPage((value) => value + 1)}
									>
										{t('cinatoken.account.earnings.next')}
									</Button>
								</div>
							</div>
						)}
					</section>
				</>
			)}
		</div>
	)
}

export function AccountEarnings(props: { api: EarningsApi }) {
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
		<section className='space-y-6' aria-labelledby='earnings-title'>
			<header className='space-y-2'>
				<h1
					id='earnings-title'
					className='text-2xl font-semibold tracking-tight'
				>
					{t('cinatoken.account.earnings.title')}
				</h1>
				<p className='text-muted-foreground max-w-2xl text-sm leading-6'>
					{t('cinatoken.account.earnings.subtitle')}
				</p>
			</header>
			{session.user.capabilities.includes('earnings.read') ? (
				<ScopedEarnings
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					api={props.api}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						version: session.scopeVersion,
					}}
					revalidate={session.revalidateScope}
				/>
			) : (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.earnings.noAccess')}
					</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
