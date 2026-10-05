import { Download, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useCinaTokenSession } from '../../session-context'
import { WorkspaceBudgetManager } from '../budgets/WorkspaceBudgetManager'
import { ActivityBreakdown } from './ActivityBreakdown'
import { ActivityFilters } from './ActivityFilters'
import { ActivityGenerationDialog } from './ActivityGenerationDialog'
import { ActivityRequestList } from './ActivityRequestList'
import { ActivitySummary } from './ActivitySummary'
import { ActivityTimeline } from './ActivityTimeline'
import {
	activityErrorKey,
	useActivityManager,
	type ActivityScope,
} from './use-activity-manager'

function ScopedActivity(props: {
	scope: ActivityScope
	workspaceName: string
	onRevalidateScope: () => void
}) {
	const { t } = useTranslation()
	const manager = useActivityManager(props.scope)
	const query = manager.query
	const blocked = manager.accessFailure !== null
	const disabled = blocked || query.isFetching || manager.exportCsv.isPending
	const data = blocked ? undefined : query.data
	let accessMessage = 'cinatoken.account.activity.noAccess'
	if (manager.accessFailure === 'user')
		accessMessage = 'cinatoken.account.sessionChanged'
	if (manager.accessFailure === 'workspace')
		accessMessage = 'cinatoken.account.activity.workspaceChanged'
	if (manager.accessFailure === 'metadata')
		accessMessage = 'cinatoken.account.activity.metadataMismatch'
	return (
		<div className='space-y-5'>
			<div className='flex flex-wrap items-center justify-between gap-3'>
				<Badge variant='outline'>
					{t('cinatoken.account.activity.scope', { name: props.workspaceName })}
				</Badge>
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={query.isFetching || manager.exportCsv.isPending}
						onClick={() => {
							if (manager.revalidationRequired) props.onRevalidateScope()
							else manager.retry()
						}}
					>
						<RefreshCw
							aria-hidden='true'
							className={query.isFetching ? 'animate-spin' : ''}
						/>
						{t('cinatoken.account.refresh')}
					</Button>
					<Button
						variant='outline'
						disabled={!query.isSuccess || disabled}
						onClick={() => {
							manager.exportCsv.reset()
							manager.exportCsv.mutate()
						}}
					>
						<Download aria-hidden='true' />
						{t(
							manager.exportCsv.isPending
								? 'cinatoken.account.activity.exporting'
								: 'cinatoken.account.activity.exportCsv'
						)}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t('cinatoken.account.activity.exportHint')}
			</p>
			{blocked && (
				<Alert>
					<AlertTitle>{t('cinatoken.account.accessDenied')}</AlertTitle>
					<AlertDescription>{t(accessMessage)}</AlertDescription>
					{manager.revalidationRequired ? (
						<Button
							className='mt-3 w-fit'
							variant='outline'
							onClick={props.onRevalidateScope}
						>
							{t('cinatoken.account.activity.confirmContext')}
						</Button>
					) : (
						<Button
							className='mt-3 w-fit'
							variant='outline'
							disabled={query.isFetching}
							onClick={manager.retry}
						>
							{t('cinatoken.account.retry')}
						</Button>
					)}
				</Alert>
			)}
			{query.isError && !blocked && (
				<Alert variant='destructive'>
					<AlertDescription>
						{t(activityErrorKey(query.error))}
					</AlertDescription>
					<Button
						className='mt-3 w-fit'
						variant='outline'
						disabled={query.isFetching}
						onClick={manager.retry}
					>
						{t('cinatoken.account.retry')}
					</Button>
				</Alert>
			)}
			{manager.exportCsv.isError && !blocked && (
				<Alert variant='destructive'>
					<AlertDescription>
						{t('cinatoken.account.activity.exportFailed')}
					</AlertDescription>
				</Alert>
			)}
			{manager.exportNotice && !blocked && (
				<p role='status' className='bg-muted/40 rounded-lg border p-3 text-sm'>
					{t(
						manager.exportNotice.truncated
							? 'cinatoken.account.activity.exportTruncated'
							: 'cinatoken.account.activity.exportDone',
						{
							count: manager.exportNotice.rowCount,
							total: manager.exportNotice.total,
						}
					)}
				</p>
			)}
			<ActivityFilters
				values={manager.filters}
				data={data}
				disabled={blocked || manager.exportCsv.isPending}
				onApply={manager.applyFilters}
			/>
			{!blocked && <WorkspaceBudgetManager />}
			{query.isPending && (
				<div
					role='status'
					aria-label={t('cinatoken.account.activity.loading')}
					className='space-y-4'
				>
					<div className='grid gap-3 sm:grid-cols-2'>
						<Skeleton className='h-28' />
						<Skeleton className='h-28' />
					</div>
					<Skeleton className='h-72' />
				</div>
			)}
			{data && (
				<>
					<ActivitySummary data={data} />
					<ActivityTimeline
						points={data.timeline.points}
						granularity={data.timeline.granularity}
						currency={data.billingCurrency}
					/>
					<ActivityBreakdown
						data={data}
						filters={manager.filters}
						disabled={disabled}
						onApply={manager.applyFilters}
					/>
					<ActivityRequestList
						data={data}
						disabled={disabled}
						onDetails={manager.openDetails}
						onPage={manager.setPage}
					/>
				</>
			)}
			{manager.selected && !blocked && (
				<ActivityGenerationDialog
					key={manager.selected.id}
					scope={props.scope}
					selected={manager.selected}
					onClose={() => manager.setSelected(null)}
				/>
			)}
		</div>
	)
}

export function AccountActivity() {
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
		<section aria-labelledby='activity-title' className='space-y-6'>
			<header className='space-y-2'>
				<h1
					id='activity-title'
					className='text-2xl font-semibold tracking-tight'
				>
					{t('cinatoken.account.activity.title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t('cinatoken.account.activity.subtitle')}
				</p>
			</header>
			{session.user.capabilities.includes('account.read') ? (
				<ScopedActivity
					key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
					scope={{
						userId: session.user.userId,
						workspaceId: workspace.id,
						scopeVersion: session.scopeVersion,
					}}
					workspaceName={workspace.name}
					onRevalidateScope={() =>
						void session.revalidateScope().catch(() => undefined)
					}
				/>
			) : (
				<Alert>
					<AlertDescription>
						{t('cinatoken.account.activity.noCapability')}
					</AlertDescription>
				</Alert>
			)}
		</section>
	)
}
