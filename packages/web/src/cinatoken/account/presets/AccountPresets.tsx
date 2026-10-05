import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import type { PresetsApi } from '../../preset-api'
import { useCinaTokenSession } from '../../session-context'
import { AccountLoading } from '../AccountLoading'
import { PresetChangeDialog } from './PresetChangeDialog'
import { PresetEditorDialog } from './PresetEditorDialog'
import { PresetList } from './PresetList'
import { PresetMetadataDialog } from './PresetMetadataDialog'
import { PresetVersionsDialog } from './PresetVersionsDialog'
import { presetPage } from './preset-form'
import { usePresetsManager, type PresetScope } from './use-presets-manager'

const prefix = 'cinatoken.presets.'
function ScopedPresets(props: {
	api: PresetsApi
	scope: PresetScope
	workspaceName: string
}) {
	const { t } = useTranslation()
	const manager = usePresetsManager(props.api, props.scope)
	const [filter, setFilter] = useState({
		search: '',
		status: '',
		visibility: '',
	})
	const [page, setPage] = useState(0)
	const result = useMemo(
		() => presetPage(manager.query.data?.presets ?? [], filter, page),
		[manager.query.data, filter, page]
	)
	const disabled =
		manager.blocked ||
		manager.query.isError ||
		manager.query.isFetching ||
		manager.mutation.isPending
	function changeFilter(key: keyof typeof filter, value: string) {
		setFilter((current) => ({ ...current, [key]: value }))
		setPage(0)
	}
	return (
		<div className='space-y-6'>
			<header className='flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'>
				<div className='space-y-2'>
					<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground max-w-2xl text-sm leading-6'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={manager.query.isFetching || manager.mutation.isPending}
						onClick={manager.retry}
					>
						{t(prefix + 'refresh')}
					</Button>
					<Button
						disabled={disabled || !manager.query.data}
						onClick={() => manager.openEditor()}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</header>
			<div className='bg-muted/40 space-y-2 rounded-xl border p-4'>
				<h2 className='text-sm font-medium'>
					{t(prefix + 'scope', { workspace: props.workspaceName })}
				</h2>
				<p className='text-muted-foreground text-xs leading-5'>
					{t(prefix + 'scopeHint')}
				</p>
			</div>
			{manager.notice && !manager.blocked && (
				<Alert role='status'>
					<AlertDescription>
						{t(manager.notice.key, { version: manager.notice.version })}
					</AlertDescription>
				</Alert>
			)}
			{manager.query.isPending && (
				<div role='status' className='space-y-3'>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'loading')}
					</p>
					<Skeleton className='h-52 w-full' />
				</div>
			)}
			{(manager.query.isError || manager.blocked) && (
				<Alert variant='destructive'>
					<AlertTitle>
						{t(prefix + (manager.blocked ? 'access' : 'loadFailed'))}
					</AlertTitle>
					<AlertDescription>{t(manager.contextErrorKey)}</AlertDescription>
					<Button
						variant='outline'
						className='mt-3 w-fit'
						disabled={manager.query.isFetching}
						onClick={manager.retry}
					>
						{t(prefix + 'retry')}
					</Button>
				</Alert>
			)}
			{manager.query.data && !manager.blocked && (
				<>
					<div className='flex flex-col gap-3 sm:flex-row sm:flex-wrap'>
						<Input
							className='sm:min-w-64 sm:flex-1'
							aria-label={t(prefix + 'search')}
							placeholder={t(prefix + 'search')}
							value={filter.search}
							onChange={(event) => changeFilter('search', event.target.value)}
						/>
						<select
							aria-label={t(prefix + 'allStatuses')}
							className='bg-background h-10 w-full rounded-lg border px-3 text-sm sm:w-auto'
							value={filter.status}
							onChange={(event) => changeFilter('status', event.target.value)}
						>
							<option value=''>{t(prefix + 'allStatuses')}</option>
							<option value='active'>{t(prefix + 'active')}</option>
							<option value='archived'>{t(prefix + 'archived')}</option>
						</select>
						<select
							aria-label={t(prefix + 'allVisibilities')}
							className='bg-background h-10 w-full rounded-lg border px-3 text-sm sm:w-auto'
							value={filter.visibility}
							onChange={(event) =>
								changeFilter('visibility', event.target.value)
							}
						>
							<option value=''>{t(prefix + 'allVisibilities')}</option>
							<option value='private'>{t(prefix + 'private')}</option>
							<option value='public'>{t(prefix + 'public')}</option>
						</select>
					</div>
					{manager.query.data.presets.length === 0 ? (
						<div className='space-y-2 rounded-xl border border-dashed p-8 text-center'>
							<h2 className='font-medium'>{t(prefix + 'empty')}</h2>
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'emptyHint')}
							</p>
						</div>
					) : (
						<PresetList
							rows={result.rows}
							disabled={disabled}
							onEdit={manager.openEditor}
							onMetadata={manager.openMetadata}
							onHistory={manager.openHistory}
							onChange={manager.openChange}
						/>
					)}
					{result.total === 0 && manager.query.data.presets.length > 0 && (
						<div className='space-y-3 rounded-xl border p-6 text-center'>
							<p className='text-muted-foreground text-sm'>
								{t(prefix + 'noMatches')}
							</p>
							<Button
								variant='outline'
								onClick={() => {
									setFilter({ search: '', status: '', visibility: '' })
									setPage(0)
								}}
							>
								{t(prefix + 'clearFilters')}
							</Button>
						</div>
					)}
					<div className='flex flex-wrap items-center justify-between gap-3'>
						<p className='text-muted-foreground text-xs' role='status'>
							{t(prefix + 'pagination', {
								page: result.page + 1,
								pages: result.pages,
								count: result.total,
							})}
						</p>
						<div className='flex gap-2'>
							<Button
								variant='outline'
								disabled={result.page === 0}
								onClick={() => setPage(result.page - 1)}
							>
								{t(prefix + 'previous')}
							</Button>
							<Button
								variant='outline'
								disabled={result.page + 1 >= result.pages}
								onClick={() => setPage(result.page + 1)}
							>
								{t(prefix + 'next')}
							</Button>
						</div>
					</div>
				</>
			)}
			{manager.editor && !manager.blocked && (
				<PresetEditorDialog
					{...manager.editor}
					pending={manager.mutation.isPending}
					disabled={disabled}
					error={manager.mutation.error}
					onSave={manager.save}
					onClose={manager.closeEditor}
				/>
			)}
			{manager.metadata && !manager.blocked && (
				<PresetMetadataDialog
					row={manager.metadata}
					pending={manager.mutation.isPending}
					disabled={disabled}
					error={manager.mutation.error}
					onSave={manager.saveMetadata}
					onClose={manager.closeMetadata}
				/>
			)}
			{manager.change && !manager.blocked && (
				<PresetChangeDialog
					change={manager.change}
					pending={manager.mutation.isPending}
					disabled={disabled}
					error={manager.mutation.error}
					onConfirm={manager.confirm}
					onClose={manager.closeChange}
				/>
			)}
			{manager.history && !manager.blocked && (
				<PresetVersionsDialog
					api={props.api}
					row={manager.history}
					options={manager.options}
					queryKey={manager.key}
					disabled={disabled}
					onCopy={(version) => manager.openEditor(manager.history!, version)}
					onDesignate={(version) =>
						manager.openChange({
							row: manager.history!,
							kind: 'designate',
							version: version.version,
						})
					}
					onRetry={manager.retry}
					onClose={manager.closeHistory}
				/>
			)}
		</div>
	)
}

export function AccountPresets(props: { api: PresetsApi }) {
	const { t } = useTranslation()
	const session = useCinaTokenSession()
	if (
		session.status === 'loading' ||
		session.isLoggingOut ||
		session.isSwitchingWorkspace
	)
		return <AccountLoading />
	if (
		session.status !== 'authenticated' ||
		!session.user ||
		!session.workspaceContext
	)
		return null
	if (!session.user.capabilities.includes('account.read'))
		return (
			<Alert>
				<AlertDescription>{t(prefix + 'noAccess')}</AlertDescription>
			</Alert>
		)
	const workspace = session.workspaceContext.currentWorkspace
	return (
		<ScopedPresets
			key={`${session.user.userId}:${workspace.id}:${session.scopeVersion}`}
			api={props.api}
			scope={{
				userId: session.user.userId,
				workspaceId: workspace.id,
				scopeVersion: session.scopeVersion,
			}}
			workspaceName={workspace.name}
		/>
	)
}
