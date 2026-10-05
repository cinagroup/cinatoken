import { Link } from '@tanstack/react-router'
import {
	ArrowRight,
	Building2,
	KeyRound,
	ShieldCheck,
	UserRound,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
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
import type { PortalMe, WorkspaceContext } from '../contracts'
import { useCinaTokenSession } from '../session-context'
import { AccountContributionSummary } from './AccountContributionSummary'
import { AccountLoading } from './AccountLoading'
import { isUserMismatch, requiresSessionRevalidation } from './account-access'
import { keyStatus } from './key-display'
import { useAccountClock } from './use-account-clock'
import { useGatewayKeys } from './use-gateway-keys'

type ScopedOverviewProps = {
	user: PortalMe
	workspaceContext: WorkspaceContext
	scopeVersion: number
}

function ScopedOverview(props: ScopedOverviewProps) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	const now = useAccountClock()
	const workspace = props.workspaceContext.currentWorkspace
	const canManageKeys = props.user.capabilities.includes('gateway_keys.manage')
	const query = useGatewayKeys(props.user.userId, workspace.id, canManageKeys)
	const activeCount = query.data?.keys.filter(
		(key) => keyStatus(key, now) === 'active'
	).length
	const personal = workspace.scopeType === 'personal'

	return (
		<div className='space-y-6'>
			<header className='space-y-2'>
				<p className='text-primary text-sm font-medium'>
					{t('cinatoken.account.overview.eyebrow')}
				</p>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t('cinatoken.account.overview.title')}
				</h1>
				<p className='text-muted-foreground max-w-2xl text-sm'>
					{t('cinatoken.account.overview.description')}
				</p>
			</header>
			<AccountContributionSummary
				user={props.user}
				workspaceId={workspace.id}
				scopeVersion={props.scopeVersion}
			/>
			<Card className='bg-primary/[0.03] relative overflow-hidden py-6 sm:py-8'>
				<CardContent className='flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between'>
					<div className='flex items-start gap-4'>
						<div className='bg-background text-primary flex size-12 shrink-0 items-center justify-center rounded-2xl border'>
							<Building2 className='size-5' aria-hidden='true' />
						</div>
						<div className='min-w-0 space-y-2'>
							<p className='text-muted-foreground text-xs font-medium'>
								{t('cinatoken.account.overview.currentWorkspace')}
							</p>
							<h2 className='text-xl font-semibold break-all'>
								{workspace.name}
							</h2>
							<div className='flex flex-wrap gap-2'>
								<Badge variant='outline'>
									{t(
										personal
											? 'cinatoken.account.overview.personal'
											: 'cinatoken.account.overview.organization'
									)}
								</Badge>
								<Badge variant='secondary'>
									{t(`cinatoken.account.overview.roles.${workspace.role}`)}
								</Badge>
							</div>
						</div>
					</div>
					{canManageKeys && (
						<Button
							size='lg'
							render={<Link to='/account/keys' />}
							className='w-fit'
						>
							{t('cinatoken.account.overview.manageKeys')}
							<ArrowRight className='size-4' aria-hidden='true' />
						</Button>
					)}
				</CardContent>
			</Card>
			<div className='grid gap-4 sm:grid-cols-3'>
				<Card>
					<CardHeader>
						<CardDescription>
							{t('cinatoken.account.overview.availableWorkspaces')}
						</CardDescription>
						<CardTitle className='text-3xl tabular-nums'>
							{props.workspaceContext.workspaces.length}
						</CardTitle>
					</CardHeader>
					<CardContent className='text-muted-foreground text-xs'>
						{t('cinatoken.account.overview.workspaceHint')}
					</CardContent>
				</Card>
				{canManageKeys && (
					<>
						<Card>
							<CardHeader>
								<CardDescription>
									{t('cinatoken.account.overview.totalKeys')}
								</CardDescription>
								{query.isPending ? (
									<Skeleton className='h-9 w-12' />
								) : (
									<CardTitle className='text-3xl tabular-nums'>
										{query.isError ? '—' : query.data?.keys.length}
									</CardTitle>
								)}
							</CardHeader>
							<CardContent className='text-muted-foreground text-xs'>
								{t('cinatoken.account.overview.keyScope')}
							</CardContent>
						</Card>
						<Card>
							<CardHeader>
								<CardDescription>
									{t('cinatoken.account.overview.activeKeys')}
								</CardDescription>
								{query.isPending ? (
									<Skeleton className='h-9 w-12' />
								) : (
									<CardTitle className='text-3xl tabular-nums'>
										{query.isError ? '—' : activeCount}
									</CardTitle>
								)}
							</CardHeader>
							<CardContent className='text-muted-foreground text-xs'>
								{t('cinatoken.account.overview.activeHint')}
							</CardContent>
						</Card>
					</>
				)}
			</div>
			{canManageKeys && query.isError && (
				<Alert variant='destructive'>
					<AlertTitle>{t('cinatoken.account.keys.loadFailed')}</AlertTitle>
					<AlertDescription>
						{t(
							isUserMismatch(query.error)
								? 'cinatoken.account.sessionChanged'
								: 'cinatoken.account.retryHint'
						)}
					</AlertDescription>
					<Button
						variant='outline'
						className='mt-2 w-fit'
						disabled={query.isFetching}
						onClick={() => {
							if (requiresSessionRevalidation(query.error))
								void session.revalidateScope()
							else void query.refetch()
						}}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			<div className='grid gap-5 lg:grid-cols-2'>
				<Card>
					<CardHeader>
						<CardTitle className='flex items-center gap-2'>
							<UserRound
								className='text-muted-foreground size-4'
								aria-hidden='true'
							/>
							{t('cinatoken.account.overview.identityTitle')}
						</CardTitle>
						<CardDescription>
							{t('cinatoken.account.overview.identityHint')}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<dl className='space-y-4'>
							<div>
								<dt className='text-muted-foreground mb-1 text-xs'>
									{t('cinatoken.account.overview.email')}
								</dt>
								<dd className='font-medium break-all'>
									{props.user.email || '—'}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground mb-1 text-xs'>
									{t('cinatoken.account.overview.accountId')}
								</dt>
								<dd className='font-mono text-xs break-all'>
									{props.user.userId}
								</dd>
							</div>
							<div>
								<dt className='text-muted-foreground mb-1 text-xs'>
									{t('cinatoken.account.overview.workspaceId')}
								</dt>
								<dd className='font-mono text-xs break-all'>{workspace.id}</dd>
							</div>
						</dl>
					</CardContent>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className='flex items-center gap-2'>
							<ShieldCheck
								className='text-muted-foreground size-4'
								aria-hidden='true'
							/>
							{t('cinatoken.account.overview.getStarted')}
						</CardTitle>
						<CardDescription>
							{t('cinatoken.account.overview.getStartedHint')}
						</CardDescription>
					</CardHeader>
					<CardContent className='space-y-4'>
						<div className='flex gap-3 rounded-lg border p-4'>
							<KeyRound
								className='text-primary mt-0.5 size-4 shrink-0'
								aria-hidden='true'
							/>
							<div>
								<h3 className='font-medium'>
									{t('cinatoken.account.overview.keyActionTitle')}
								</h3>
								<p className='text-muted-foreground mt-1 text-sm'>
									{t('cinatoken.account.overview.keyActionHint')}
								</p>
								{canManageKeys && (
									<Button
										variant='link'
										className='mt-2 h-auto px-0'
										render={<Link to='/account/keys' />}
									>
										{t('cinatoken.account.overview.manageKeys')}
										<ArrowRight className='size-4' aria-hidden='true' />
									</Button>
								)}
							</div>
						</div>
						<p className='text-muted-foreground text-xs'>
							{t('cinatoken.account.overview.workspaceIsolation')}
						</p>
					</CardContent>
				</Card>
			</div>
		</div>
	)
}

export function AccountOverview() {
	const session = useCinaTokenSession()
	if (
		session.status === 'loading' ||
		session.isSwitchingWorkspace ||
		session.isLoggingOut
	)
		return <AccountLoading />
	if (
		session.status !== 'authenticated' ||
		!session.user ||
		!session.workspaceContext
	)
		return null
	return (
		<ScopedOverview
			key={`${session.user.userId}:${session.workspaceContext.currentWorkspace.id}:${session.scopeVersion}`}
			user={session.user}
			workspaceContext={session.workspaceContext}
			scopeVersion={session.scopeVersion}
		/>
	)
}
