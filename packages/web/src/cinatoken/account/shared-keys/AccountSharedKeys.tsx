import { useState } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useCinaTokenSession } from '../../session-context'
import { SharedKeyDeleteDialog } from './SharedKeyDeleteDialog'
import { SharedKeyFormDialog } from './SharedKeyFormDialog'
import { SharedKeyList } from './SharedKeyList'
import { canManageSharedKeys, sharedKeyPage } from './shared-key-form'
import {
	sharedKeyErrorKey,
	useSharedKeys,
	type SharedKeyScope,
} from './use-shared-keys'

const prefix = 'cinatoken.account.sharedKeys.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-lg border px-3 text-sm sm:w-auto sm:flex-1'
function ScopedSharedKeys(props: { scope: SharedKeyScope }) {
	const { t } = useTranslation()
	const manager = useSharedKeys(props.scope)
	const [filters, setFilters] = useState({
		channel: '',
		status: '',
		search: '',
	})
	const [page, setPage] = useState(0)
	const listing = sharedKeyPage(manager.query.data?.keys ?? [], filters, page)
	const busy = manager.mutation.isPending
	const fetching = manager.query.isFetching || manager.catalog.isFetching
	const disabled =
		manager.blocked ||
		busy ||
		fetching ||
		!manager.query.isSuccess ||
		!manager.catalog.isSuccess
	const catalog = manager.catalog.data
	const ready = !manager.blocked && catalog && manager.query.data
	const updateFilter = (field: keyof typeof filters, value: string) => {
		setPage(0)
		setFilters((current) => ({ ...current, [field]: value }))
	}
	return (
		<div className='space-y-4'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<Badge variant='outline'>{t(prefix + 'scope')}</Badge>
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={fetching || busy}
						onClick={manager.retry}
					>
						<RefreshCw
							aria-hidden='true'
							className={fetching ? 'animate-spin' : ''}
						/>
						{t('cinatoken.account.refresh')}
					</Button>
					<Button
						disabled={disabled || !catalog?.channels.length}
						onClick={manager.openCreate}
					>
						<Plus aria-hidden='true' />
						{t(prefix + 'add')}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground text-xs leading-5'>
				{t(prefix + 'scopeHint')}
			</p>
			{ready && (
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'currencyHint', {
						quote: catalog.billingCurrency,
						earnings: manager.query.data?.earningsCurrency,
					})}
				</p>
			)}
			{manager.notice && !manager.blocked && (
				<p role='status' className='bg-muted/40 rounded-lg border p-3 text-sm'>
					{t(manager.notice)}
				</p>
			)}
			{(manager.query.isPending || manager.catalog.isPending) && (
				<div
					role='status'
					aria-label={t(prefix + 'loading')}
					className='space-y-3'
				>
					<Skeleton className='h-44' />
					<Skeleton className='h-44' />
				</div>
			)}
			{manager.blocked && (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>
						{t(
							manager.userMismatch
								? 'cinatoken.account.sessionChanged'
								: manager.contextMismatch
									? 'cinatoken.shell.workspaceChanged'
									: prefix + 'access'
						)}
					</AlertDescription>
					<Button
						className='mt-3 w-fit'
						variant='outline'
						disabled={fetching}
						onClick={manager.retry}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{(manager.query.isError || manager.catalog.isError) &&
				!manager.blocked && (
					<Alert variant='destructive'>
						<AlertTitle>{t(prefix + 'loadFailed')}</AlertTitle>
						<AlertDescription>
							{t('cinatoken.account.retryHint')}
						</AlertDescription>
						<Button
							className='mt-3 w-fit'
							variant='outline'
							disabled={fetching}
							onClick={manager.retry}
						>
							{t('cinatoken.account.retry')}
						</Button>
					</Alert>
				)}
			{manager.mutation.isError &&
				!manager.form &&
				!manager.remove &&
				!manager.blocked && (
					<Alert variant='destructive'>
						<AlertDescription>
							{t(sharedKeyErrorKey(manager.mutation.error, manager.action))}
						</AlertDescription>
					</Alert>
				)}
			{ready && (
				<>
					{catalog.channels.length === 0 && (
						<p
							role='status'
							className='text-muted-foreground rounded-lg border p-3 text-sm'
						>
							{t(prefix + 'channelsClosed')}
						</p>
					)}
					<div
						className='bg-card flex flex-wrap gap-2 rounded-lg border p-3'
						role='group'
						aria-label={t(prefix + 'filter')}
					>
						<Input
							className='min-w-0 flex-1 basis-48'
							aria-label={t(prefix + 'search')}
							placeholder={t(prefix + 'search')}
							value={filters.search}
							maxLength={128}
							disabled={busy}
							onChange={(event) => updateFilter('search', event.target.value)}
						/>
						<select
							aria-label={t(prefix + 'allChannels')}
							className={selectClass}
							value={filters.channel}
							disabled={busy}
							onChange={(event) => updateFilter('channel', event.target.value)}
						>
							<option value=''>{t(prefix + 'allChannels')}</option>
							{(['openai', 'anthropic', 'zhipu', 'deepseek'] as const).map(
								(channel) => (
									<option key={channel} value={channel}>
										{channel}
									</option>
								)
							)}
						</select>
						<select
							aria-label={t(prefix + 'allStatuses')}
							className={selectClass}
							value={filters.status}
							disabled={busy}
							onChange={(event) => updateFilter('status', event.target.value)}
						>
							<option value=''>{t(prefix + 'allStatuses')}</option>
							{(
								[
									'active',
									'paused',
									'validating',
									'invalid',
									'disabled',
								] as const
							).map((status) => (
								<option key={status} value={status}>
									{t(prefix + 'status_' + status)}
								</option>
							))}
						</select>
						<Button
							variant='outline'
							disabled={busy}
							onClick={() => {
								setFilters({ channel: '', status: '', search: '' })
								setPage(0)
							}}
						>
							{t(prefix + 'clearFilters')}
						</Button>
					</div>
					{listing.rows.length === 0 ? (
						<Card>
							<CardContent className='px-4 py-10 text-center'>
								<h3 className='font-semibold'>
									{t(
										prefix +
											(manager.query.data?.keys.length ? 'noMatches' : 'empty')
									)}
								</h3>
								<p className='text-muted-foreground mt-2 text-sm'>
									{t(prefix + 'emptyHint')}
								</p>
							</CardContent>
						</Card>
					) : (
						<SharedKeyList
							rows={listing.rows}
							quoteCurrency={catalog.billingCurrency}
							earningsCurrency={manager.query.data?.earningsCurrency ?? ''}
							disabled={disabled}
							onEdit={manager.openEdit}
							onToggle={manager.toggle}
							onValidate={manager.validate}
							onRemove={manager.openRemove}
						/>
					)}
					{listing.total > 0 && (
						<div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
							<p className='text-muted-foreground'>
								{t(prefix + 'pagination', {
									page: listing.page + 1,
									pages: listing.pages,
									count: listing.total,
								})}
							</p>
							<div className='flex gap-2'>
								<Button
									variant='outline'
									size='sm'
									disabled={disabled || listing.page === 0}
									onClick={() => setPage(listing.page - 1)}
								>
									{t(prefix + 'previous')}
								</Button>
								<Button
									variant='outline'
									size='sm'
									disabled={disabled || listing.page + 1 >= listing.pages}
									onClick={() => setPage(listing.page + 1)}
								>
									{t(prefix + 'next')}
								</Button>
							</div>
						</div>
					)}
				</>
			)}
			{manager.form && catalog && !manager.blocked && (
				<SharedKeyFormDialog
					key={manager.form.row?.id ?? 'create'}
					row={manager.form.row}
					catalog={catalog}
					pending={busy}
					error={manager.mutation.error}
					onSave={manager.save}
					onClose={manager.closeForm}
				/>
			)}
			{manager.remove && !manager.blocked && (
				<SharedKeyDeleteDialog
					row={manager.remove}
					pending={busy}
					error={manager.mutation.error}
					onConfirm={manager.delete}
					onPause={manager.pauseInstead}
					onClose={manager.closeRemove}
				/>
			)}
		</div>
	)
}

export function AccountSharedKeys() {
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
	return (
		<section
			className='space-y-5 border-t pt-8'
			aria-labelledby='shared-keys-title'
		>
			<header className='space-y-2'>
				<h2 id='shared-keys-title' className='text-xl font-semibold'>
					{t(prefix + 'title')}
				</h2>
				<p className='text-muted-foreground max-w-2xl text-sm leading-6'>
					{t(prefix + 'subtitle')}
				</p>
			</header>
			{canManageSharedKeys(session.user.capabilities) ? (
				<ScopedSharedKeys
					key={`${session.user.userId}:${session.workspaceContext.currentWorkspace.id}:${session.scopeVersion}`}
					scope={{
						userId: session.user.userId,
						workspaceId: session.workspaceContext.currentWorkspace.id,
						scopeVersion: session.scopeVersion,
					}}
				/>
			) : (
				<Alert>
					<AlertDescription>{t(prefix + 'noCapability')}</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
