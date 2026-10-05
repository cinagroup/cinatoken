import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { accountQueryKey, cinatokenApi } from '../api'
import type { PortalMe, Workspace } from '../contracts'
import { useCinaTokenSession } from '../session-context'
import { GatewayKeysSection } from './AccountKeys'
import { AccountLoading } from './AccountLoading'
import { isUserMismatch, requiresSessionRevalidation } from './account-access'
import { formatAccountDate } from './key-display'

function WalletSetting(props: {
	userId: string
	workspaceId: string
	scopeVersion: number
}) {
	const { t, i18n } = useTranslation()
	const session = useCinaTokenSession()
	const query = useQuery({
		queryKey: accountQueryKey(
			props.userId,
			props.workspaceId,
			'settings-wallet',
			props.scopeVersion
		),
		queryFn: ({ signal }) =>
			cinatokenApi.wallet({
				signal,
				expectedUserId: props.userId,
				expectedWorkspaceId: props.workspaceId,
			}),
		retry: false,
		staleTime: 15000,
	})
	const revalidate = requiresSessionRevalidation(query.error)
	const retry = () => {
		if (revalidate) void session.revalidateScope()
		else void query.refetch()
	}
	return (
		<Card>
			<CardHeader>
				<CardTitle>{t('cinatoken.account.settings.wallet')}</CardTitle>
				<CardDescription>
					{t('cinatoken.account.settings.walletHint')}
				</CardDescription>
			</CardHeader>
			<CardContent className='space-y-3'>
				{query.isPending && <Skeleton className='h-10' />}
				{query.isError && (
					<Alert>
						<AlertDescription>
							{t(
								isUserMismatch(query.error)
									? 'cinatoken.account.sessionChanged'
									: `cinatoken.account.settings.${revalidate ? 'mismatch' : 'failed'}`
							)}
						</AlertDescription>
						<Button
							variant='outline'
							className='mt-3 w-fit'
							onClick={retry}
							disabled={query.isFetching}
						>
							{t('cinatoken.account.settings.retry')}
						</Button>
					</Alert>
				)}
				{query.isSuccess && (
					<>
						<p className='font-mono text-sm break-all'>
							{query.data.data.walletMasked ??
								t('cinatoken.account.settings.none')}
						</p>
						{query.data.data.verifiedAt && (
							<p className='text-muted-foreground text-xs'>
								{t('cinatoken.account.settings.verified', {
									date: formatAccountDate(
										query.data.data.verifiedAt,
										i18n.resolvedLanguage ?? 'en'
									),
								})}
							</p>
						)}
						{query.data.data.walletAddress && !query.data.data.verifiedAt && (
							<p className='text-muted-foreground text-sm'>
								{t('cinatoken.account.settings.legacy')}
							</p>
						)}
						{query.data.availability === 'unavailable' && (
							<p className='text-muted-foreground text-sm'>
								{t('cinatoken.account.settings.unavailable')}
							</p>
						)}
					</>
				)}
				<Button variant='outline' render={<Link to='/account/withdraw' />}>
					{t('cinatoken.account.settings.manageWallet')}
				</Button>
			</CardContent>
		</Card>
	)
}

function ScopedSettings(props: {
	user: PortalMe
	workspace: Workspace
	scopeVersion: number
}) {
	const { t } = useTranslation()
	return (
		<div className='space-y-6'>
			<header>
				<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
					{t('cinatoken.account.settings.title')}
				</h1>
				<p className='text-muted-foreground mt-2 text-sm'>
					{t('cinatoken.account.settings.description')}
				</p>
			</header>
			<div className='grid items-start gap-4 lg:grid-cols-2'>
				{props.user.capabilities.includes('wallet.manage') && (
					<WalletSetting
						userId={props.user.userId}
						workspaceId={props.workspace.id}
						scopeVersion={props.scopeVersion}
					/>
				)}
				<Card>
					<CardHeader>
						<CardTitle>{t('cinatoken.account.settings.identity')}</CardTitle>
						<CardDescription>
							{t('cinatoken.account.settings.identityHint')}
						</CardDescription>
					</CardHeader>
					<CardContent className='space-y-3'>
						<p className='text-sm break-all'>{props.user.email || '—'}</p>
						<Button
							variant='outline'
							render={
								<a
									href='https://accounts.cinaseek.si'
									target='_blank'
									rel='noopener noreferrer'
								/>
							}
						>
							{t('cinatoken.account.settings.accountCenter')}
						</Button>
					</CardContent>
				</Card>
			</div>
			{props.user.capabilities.includes('gateway_keys.manage') && (
				<GatewayKeysSection
					userId={props.user.userId}
					workspaceId={props.workspace.id}
					workspaceName={props.workspace.name}
					headingLevel='h2'
				/>
			)}
		</div>
	)
}

export function AccountSettings() {
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
		<ScopedSettings
			key={`${session.user.userId}:${session.workspaceContext.currentWorkspace.id}:${session.scopeVersion}`}
			user={session.user}
			workspace={session.workspaceContext.currentWorkspace}
			scopeVersion={session.scopeVersion}
		/>
	)
}
