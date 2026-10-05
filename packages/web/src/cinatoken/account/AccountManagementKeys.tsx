import { Plus, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import type { PortalMe, Workspace } from '../contracts'
import { useCinaTokenSession } from '../session-context'
import { ManagementKeyCreateDialog } from './ManagementKeyCreateDialog'
import { ManagementKeyList } from './ManagementKeyList'
import { ManagementKeyRevokeDialog } from './ManagementKeyRevokeDialog'
import { OneTimeKeyDialog } from './OneTimeKeyDialog'
import {
	managementAccessRestriction,
	managementAccount,
} from './management-account'
import { useManagementKeyManager } from './use-management-key-manager'

type ScopeProps = { user: PortalMe; workspace: Workspace; scopeName: string }

function ScopedManagementKeys(props: ScopeProps) {
	const { t } = useTranslation()
	const manager = useManagementKeyManager({
		userId: props.user.userId,
		workspaceId: props.workspace.id,
		account: managementAccount(props.workspace),
	})
	const isPending = manager.create.isPending || manager.revoke.isPending
	const query = manager.query
	return (
		<div className='space-y-4'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<Badge variant='outline'>
					{t('cinatoken.account.managementKeys.scope', {
						name: props.scopeName,
					})}
				</Badge>
				<div className='flex gap-2'>
					<Button
						variant='outline'
						size='icon'
						disabled={query.isFetching || isPending}
						onClick={manager.retryAccess}
						aria-label={t('cinatoken.account.managementKeys.refresh')}
					>
						<RefreshCw
							aria-hidden='true'
							className={query.isFetching ? 'animate-spin' : ''}
						/>
					</Button>
					<Button
						disabled={!query.isSuccess || manager.accessDenied || isPending}
						onClick={manager.openCreate}
					>
						<Plus aria-hidden='true' />
						{t('cinatoken.account.managementKeys.create')}
					</Button>
				</div>
			</div>
			{query.isPending && (
				<div
					role='status'
					aria-label={t('cinatoken.account.managementKeys.loading')}
					className='space-y-3'
				>
					<span className='sr-only'>
						{t('cinatoken.account.managementKeys.loading')}
					</span>
					<Skeleton className='h-36' />
					<Skeleton className='h-36' />
				</div>
			)}
			{manager.accessDenied && (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>
						{t(
							manager.userMismatch
								? 'cinatoken.account.sessionChanged'
								: manager.contextMismatch
									? 'cinatoken.shell.workspaceChanged'
									: 'cinatoken.account.managementKeys.adminRequired'
						)}
					</AlertDescription>
					<Button
						variant='outline'
						className='mt-2 w-fit'
						disabled={query.isFetching}
						onClick={manager.retryAccess}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{query.isError && !manager.accessDenied && (
				<Alert variant='destructive'>
					<AlertTitle>
						{t('cinatoken.account.managementKeys.loadFailed')}
					</AlertTitle>
					<AlertDescription>
						{t('cinatoken.account.retryHint')}
					</AlertDescription>
					<Button
						variant='outline'
						className='mt-2 w-fit'
						disabled={query.isFetching}
						onClick={manager.retryAccess}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{query.isSuccess && !manager.accessDenied && query.data.length === 0 && (
				<Card>
					<CardContent className='flex flex-col items-center py-8 text-center'>
						<ShieldCheck
							aria-hidden='true'
							className='text-muted-foreground mb-3 size-6'
						/>
						<h3 className='font-semibold'>
							{t('cinatoken.account.managementKeys.emptyTitle')}
						</h3>
						<p className='text-muted-foreground mt-2 max-w-md text-sm'>
							{t('cinatoken.account.managementKeys.empty')}
						</p>
						<Button
							className='mt-4'
							disabled={isPending}
							onClick={manager.openCreate}
						>
							{t('cinatoken.account.managementKeys.create')}
						</Button>
					</CardContent>
				</Card>
			)}
			{query.isSuccess && !manager.accessDenied && query.data.length > 0 && (
				<ManagementKeyList
					keys={query.data}
					isPending={isPending}
					onRevoke={manager.openRevoke}
				/>
			)}
			{manager.createOpen && !manager.accessDenied && (
				<ManagementKeyCreateDialog
					scopeName={props.scopeName}
					isPending={manager.create.isPending}
					error={manager.create.isError}
					onClose={() => manager.setCreateOpen(false)}
					onSubmit={(values) => manager.create.mutate(values)}
				/>
			)}
			{manager.secret && !manager.accessDenied && (
				<OneTimeKeyDialog
					kind='management'
					secret={manager.secret}
					onClose={() => manager.setSecret(null)}
				/>
			)}
			{manager.revokeKey && !manager.accessDenied && (
				<ManagementKeyRevokeDialog
					managementKey={manager.revokeKey}
					isPending={manager.revoke.isPending}
					error={manager.revoke.isError}
					onClose={() => manager.setRevokeKey(null)}
					onConfirm={() => {
						if (manager.revokeKey) manager.revoke.mutate(manager.revokeKey)
					}}
				/>
			)}
		</div>
	)
}

export function AccountManagementKeys() {
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
	const restriction = managementAccessRestriction(session.user, workspace)
	let scopeName = session.user.email || workspace.name
	if (workspace.scopeType === 'organization')
		scopeName = workspace.organizationName || workspace.name
	let restrictionMessage = t('cinatoken.account.managementKeys.adminRequired')
	if (restriction === 'capability')
		restrictionMessage = t('cinatoken.account.managementKeys.noCapability')
	if (restriction === 'owner')
		restrictionMessage = t('cinatoken.account.managementKeys.ownerRequired')

	return (
		<section
			aria-labelledby='management-keys-title'
			className='space-y-4 border-t pt-8'
		>
			<header className='space-y-2'>
				<h2
					id='management-keys-title'
					className='text-xl font-semibold tracking-tight'
				>
					{t('cinatoken.account.managementKeys.title')}
				</h2>
				<p className='text-muted-foreground max-w-2xl text-sm'>
					{t('cinatoken.account.managementKeys.description')}
				</p>
			</header>
			<p className='bg-muted/30 text-muted-foreground rounded-xl border px-4 py-3 text-sm'>
				{t('cinatoken.account.managementKeys.scopeNotice')}
			</p>
			{restriction ? (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>{restrictionMessage}</AlertDescription>
				</Alert>
			) : (
				<ScopedManagementKeys
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					user={session.user}
					workspace={workspace}
					scopeName={scopeName}
				/>
			)}
		</section>
	)
}
