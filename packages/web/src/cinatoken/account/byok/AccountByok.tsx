import { useState } from 'react'
import { KeyRound, Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useCinaTokenSession } from '../../session-context'
import { managementAccount } from '../management-account'
import { ByokCredentialDialog } from './ByokCredentialDialog'
import { ByokCredentialList } from './ByokCredentialList'
import { ByokOrderDialog } from './ByokOrderDialog'
import { ByokRemoveDialog } from './ByokRemoveDialog'
import {
	byokErrorKey,
	useByokManager,
	type ByokScope,
} from './use-byok-manager'

function ScopedByok(props: { scope: ByokScope; workspaceName: string }) {
	const { t } = useTranslation()
	const manager = useByokManager(props.scope)
	const [filter, setFilter] = useState('')
	const [filterInvalid, setFilterInvalid] = useState(false)
	const query = manager.query
	const total = query.data?.total ?? 0
	const pages = Math.max(1, Math.ceil(total / 50))
	const pending = manager.mutation.isPending
	const disabled = !query.isSuccess || pending || manager.accessDenied
	const hasDialog = manager.createOpen || manager.selected !== null
	return (
		<div className='space-y-5'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<Badge variant='outline'>
					{t('cinatoken.account.byok.scope', { name: props.workspaceName })}
				</Badge>
				<Button disabled={disabled} onClick={manager.openCreate}>
					<Plus aria-hidden='true' />
					{t('cinatoken.account.byok.add')}
				</Button>
			</div>
			<form
				className='bg-card flex flex-wrap items-start gap-2 rounded-xl border p-3'
				onSubmit={(event) => {
					event.preventDefault()
					const value = filter.trim()
					if (
						value &&
						(value.length > 128 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value))
					) {
						setFilterInvalid(true)
						return
					}
					setFilterInvalid(false)
					manager.setProvider(value)
				}}
			>
				<div className='min-w-0 flex-1 basis-44'>
					<label htmlFor='byok-filter' className='sr-only'>
						{t('cinatoken.account.byok.providerFilter')}
					</label>
					<Input
						id='byok-filter'
						value={filter}
						maxLength={128}
						placeholder={t('cinatoken.account.byok.providerFilter')}
						aria-invalid={filterInvalid}
						onChange={(event) => setFilter(event.target.value)}
						disabled={pending}
					/>
					{filterInvalid && (
						<p role='alert' className='text-destructive mt-2 text-xs'>
							{t('cinatoken.account.byok.providerInvalid')}
						</p>
					)}
				</div>
				<Button type='submit' variant='outline' disabled={pending}>
					{t('cinatoken.account.byok.filter')}
				</Button>
				<Button
					type='button'
					variant='outline'
					disabled={pending || query.isFetching}
					onClick={manager.retryAccess}
				>
					<RefreshCw
						aria-hidden='true'
						className={query.isFetching ? 'animate-spin' : ''}
					/>
					{t('cinatoken.account.refresh')}
				</Button>
			</form>
			{manager.notice && (
				<p
					role='status'
					className='bg-muted/40 rounded-lg border px-4 py-3 text-sm'
				>
					{t(manager.notice)}
				</p>
			)}
			{manager.mutation.isError &&
				!hasDialog &&
				!manager.removeKey &&
				!manager.accessDenied && (
					<Alert variant='destructive'>
						<AlertDescription>
							{t(byokErrorKey(manager.mutation.error))}
						</AlertDescription>
					</Alert>
				)}
			{query.isPending && (
				<div
					role='status'
					aria-label={t('cinatoken.account.byok.loading')}
					className='space-y-3'
				>
					<Skeleton className='h-44' />
					<Skeleton className='h-44' />
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
									: 'cinatoken.account.byok.access'
						)}
					</AlertDescription>
					<Button
						className='mt-3 w-fit'
						variant='outline'
						disabled={query.isFetching}
						onClick={manager.retryAccess}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{query.isError && !manager.accessDenied && (
				<Alert variant='destructive'>
					<AlertTitle>{t('cinatoken.account.byok.loadFailed')}</AlertTitle>
					<AlertDescription>
						{t('cinatoken.account.retryHint')}
					</AlertDescription>
					<Button
						className='mt-3 w-fit'
						variant='outline'
						disabled={query.isFetching}
						onClick={manager.retryAccess}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{query.data && !manager.accessDenied && query.data.data.length > 0 && (
				<ByokCredentialList
					rows={query.data.data}
					disabled={disabled}
					onDetails={(row) => manager.openDetails(row, 'details')}
					onEdit={(row) => manager.openDetails(row, 'edit')}
					onRemove={manager.openRemove}
					onToggle={manager.toggle}
					onOrder={manager.openOrder}
				/>
			)}
			{query.isSuccess &&
				!manager.accessDenied &&
				query.data.data.length === 0 && (
					<Card>
						<CardContent className='flex flex-col items-center px-4 py-12 text-center'>
							<KeyRound
								aria-hidden='true'
								className='text-muted-foreground mb-4 size-7'
							/>
							<h2 className='font-semibold'>
								{t(
									manager.provider
										? 'cinatoken.account.byok.noMatches'
										: 'cinatoken.account.byok.empty'
								)}
							</h2>
							<p className='text-muted-foreground mt-2 max-w-md text-sm'>
								{t('cinatoken.account.byok.emptyHint')}
							</p>
							<Button
								className='mt-5'
								disabled={pending}
								onClick={manager.openCreate}
							>
								{t('cinatoken.account.byok.add')}
							</Button>
						</CardContent>
					</Card>
				)}
			{query.data && !manager.accessDenied && total > 0 && (
				<div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
					<p className='text-muted-foreground'>
						{t('cinatoken.account.byok.pagination', {
							page: manager.page + 1,
							pages,
							total,
						})}
					</p>
					<div className='flex gap-2'>
						<Button
							variant='outline'
							size='sm'
							disabled={manager.page === 0 || pending || query.isFetching}
							onClick={() => manager.setPage(Math.max(0, manager.page - 1))}
						>
							{t('cinatoken.account.byok.previous')}
						</Button>
						<Button
							variant='outline'
							size='sm'
							disabled={
								manager.page + 1 >= pages || pending || query.isFetching
							}
							onClick={() => manager.setPage(manager.page + 1)}
						>
							{t('cinatoken.account.byok.next')}
						</Button>
					</div>
				</div>
			)}
			{hasDialog && !manager.accessDenied && (
				<ByokCredentialDialog
					scope={props.scope}
					selected={manager.selected}
					defaultProvider={manager.provider}
					isPending={pending}
					error={manager.mutation.error}
					onSubmit={manager.save}
					onEdit={() => {
						if (manager.selected)
							manager.setSelected({ ...manager.selected, mode: 'edit' })
					}}
					onClose={() => {
						manager.setCreateOpen(false)
						manager.setSelected(null)
					}}
				/>
			)}
			{manager.removeKey && !manager.accessDenied && (
				<ByokRemoveDialog
					row={manager.removeKey}
					isPending={pending}
					error={manager.mutation.error}
					onClose={() => manager.setRemoveKey(null)}
					onConfirm={() => {
						if (manager.removeKey) manager.remove(manager.removeKey)
					}}
				/>
			)}
			{manager.orderProvider && !manager.accessDenied && (
				<ByokOrderDialog
					scope={props.scope}
					provider={manager.orderProvider}
					onAccessLost={manager.denyAccess}
					onClose={() => manager.setOrderProvider(null)}
					onSaved={() => {
						manager.setOrderProvider(null)
						void manager.refresh()
					}}
				/>
			)}
		</div>
	)
}

export function AccountByok() {
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
	let restriction: string | null = null
	if (!session.user.capabilities.includes('account.read'))
		restriction = 'cinatoken.account.byok.noCapability'
	else if (
		workspace.scopeType === 'personal' &&
		(workspace.personalOwnerUserId !== session.user.userId ||
			workspace.role !== 'owner')
	)
		restriction = 'cinatoken.account.byok.ownerRequired'
	else if (workspace.scopeType === 'organization' && !workspace.organizationId)
		restriction = 'cinatoken.account.byok.access'
	return (
		<section className='space-y-6' aria-labelledby='byok-title'>
			<header className='space-y-2'>
				<h1 id='byok-title' className='text-2xl font-semibold tracking-tight'>
					{t('cinatoken.account.byok.title')}
				</h1>
				<p className='text-muted-foreground max-w-2xl text-sm leading-6'>
					{t('cinatoken.account.byok.subtitle')}
				</p>
			</header>
			{restriction ? (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>{t(restriction)}</AlertDescription>
				</Alert>
			) : (
				<ScopedByok
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						scopeVersion: session.scopeVersion,
						account: managementAccount(workspace),
					}}
					workspaceName={workspace.name}
				/>
			)}
		</section>
	)
}
