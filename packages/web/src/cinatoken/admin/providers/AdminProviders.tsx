import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { ProviderChangeDialog } from './ProviderChangeDialog'
import { ProviderDetailDialog } from './ProviderDetailDialog'
import { ProviderEditorDialog } from './ProviderEditorDialog'
import { ProviderImportDialog } from './ProviderImportDialog'
import { ProviderList } from './ProviderList'
import { providerErrorKey } from './provider-errors'
import {
	filterProviders,
	PROVIDER_LIST_FILTERS,
	providerMatchesFilter,
	type ProviderFilters,
	type ProviderListFilter,
} from './provider-form'
import {
	useProvidersManager,
	type ProviderManagerProps,
} from './use-providers-manager'

export type AdminProvidersProps = ProviderManagerProps & {
	initialFilters?: Partial<ProviderFilters>
	onFiltersChange?: (filters: ProviderFilters) => void
}
const prefix = 'cinatoken.adminProviders.'
export function AdminProviders(props: AdminProvidersProps) {
	return (
		<ScopedProviders
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
			])}
			{...props}
		/>
	)
}
function ScopedProviders(props: AdminProvidersProps) {
	const { t } = useTranslation()
	const manager = useProvidersManager(props)
	const [localFilters, setLocalFilters] = useState<ProviderFilters>({
		q: props.initialFilters?.q ?? '',
		filter: props.initialFilters?.filter ?? 'all',
	})
	const [page, setPage] = useState(0)
	let filters = localFilters
	if (props.onFiltersChange && props.initialFilters)
		filters = {
			q: props.initialFilters.q ?? '',
			filter: props.initialFilters.filter ?? 'all',
		}
	function changeFilters(next: ProviderFilters): void {
		setLocalFilters(next)
		setPage(0)
		props.onFiltersChange?.(next)
	}
	const rows = useMemo(
		() =>
			filterProviders(manager.rows, { q: filters.q, filter: filters.filter }),
		[manager.rows, filters.q, filters.filter]
	)
	const searchedRows = useMemo(
		() => filterProviders(manager.rows, { q: filters.q, filter: 'all' }),
		[manager.rows, filters.q]
	)
	const counts = useMemo(
		() =>
			Object.fromEntries(
				PROVIDER_LIST_FILTERS.map((filter) => [
					filter,
					searchedRows.filter((row) => providerMatchesFilter(row, filter))
						.length,
				])
			),
		[searchedRows]
	)
	const pages = Math.max(1, Math.ceil(rows.length / 20))
	const currentPage = Math.min(page, pages - 1)
	const visible = rows.slice(currentPage * 20, (currentPage + 1) * 20)
	const modal = manager.modal
	return (
		<section className='space-y-6'>
			<div className='flex flex-wrap items-start justify-between gap-4'>
				<div className='space-y-2'>
					<h1 className='text-3xl font-semibold tracking-tight'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						variant='outline'
						disabled={manager.query.isFetching || manager.mutation.isPending}
						onClick={() => void manager.retry().catch(() => undefined)}
					>
						{t(prefix + 'refresh')}
					</Button>
					<Button
						variant='outline'
						disabled={manager.disabled}
						onClick={() => manager.open({ kind: 'import' })}
					>
						{t(prefix + 'import')}
					</Button>
					<Button
						disabled={manager.disabled}
						onClick={() => manager.open({ kind: 'editor', mode: 'create' })}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground rounded-xl border p-4 text-sm'>
				{t(prefix + 'consoleHint')}
			</p>
			{!props.canWrite && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'readonly')}
				</p>
			)}
			{manager.query.error && (
				<div
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(providerErrorKey(manager.query.error))}
				</div>
			)}
			{manager.hidden && props.canWrite && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'accessDenied')}
				</p>
			)}
			{manager.notice && !manager.hidden && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'saved')}
				</p>
			)}
			{manager.writeUnconfirmed && !manager.hidden && (
				<p
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'writeUnknown')}
				</p>
			)}
			<div className='grid gap-3 md:grid-cols-[minmax(0,1fr)_15rem]'>
				<Input
					value={filters.q}
					onChange={(event) =>
						changeFilters({ ...filters, q: event.target.value })
					}
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
				/>
				<select
					value={filters.filter}
					onChange={(event) =>
						changeFilters({
							...filters,
							filter: event.target.value as ProviderListFilter,
						})
					}
					aria-label={t(prefix + 'filter')}
					className='bg-background h-10 min-w-40 rounded-md border px-3 text-sm'
				>
					{PROVIDER_LIST_FILTERS.map((value) => (
						<option key={value} value={value}>
							{t(prefix + value, { defaultValue: value })} ({counts[value] ?? 0}
							)
						</option>
					))}
				</select>
			</div>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'count', {
					count: rows.length,
					total: manager.rows.length,
				})}
			</p>
			{manager.query.isPending && props.canWrite && (
				<p role='status'>{t(prefix + 'loading')}</p>
			)}
			{!manager.hidden && !manager.query.isPending && !rows.length && (
				<div className='space-y-3 rounded-xl border border-dashed p-8 text-center'>
					<p>{t(prefix + (manager.rows.length ? 'noMatches' : 'empty'))}</p>
					{(filters.q || filters.filter !== 'all') && (
						<Button
							variant='outline'
							onClick={() => changeFilters({ q: '', filter: 'all' })}
						>
							{t(prefix + 'clearFilters')}
						</Button>
					)}
				</div>
			)}
			<ProviderList
				rows={visible}
				disabled={manager.disabled}
				onDetail={(row) => manager.open({ kind: 'detail', row })}
				onEdit={(row) => manager.open({ kind: 'editor', mode: 'edit', row })}
				onClone={(row) => manager.open({ kind: 'editor', mode: 'clone', row })}
				onChange={(row, action) =>
					manager.open({ kind: 'change', row, action })
				}
			/>
			{pages > 1 && (
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'page', { page: currentPage + 1, total: pages })}
					</p>
					<div className='flex gap-2'>
						<Button
							variant='outline'
							disabled={currentPage === 0}
							onClick={() => setPage(currentPage - 1)}
						>
							{t(prefix + 'previous')}
						</Button>
						<Button
							variant='outline'
							disabled={currentPage >= pages - 1}
							onClick={() => setPage(currentPage + 1)}
						>
							{t(prefix + 'next')}
						</Button>
					</div>
				</div>
			)}
			{modal?.kind === 'editor' && (
				<ProviderEditorDialog
					mode={modal.mode}
					row={modal.row}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onSave={manager.save}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'change' && (
				<ProviderChangeDialog
					row={modal.row}
					action={modal.action}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onConfirm={manager.confirm}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'import' && (
				<ProviderImportDialog
					api={props.api}
					readOptions={manager.readOptions}
					queryPrefix={manager.prefix}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					result={manager.importResult}
					onImport={manager.importProviders}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'detail' && (
				<ProviderDetailDialog
					api={props.api}
					readOptions={manager.readOptions}
					writeOptions={manager.writeOptions}
					row={modal.row}
					queryPrefix={manager.prefix}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					queue={manager.queue}
					onEdit={(row) => manager.open({ kind: 'editor', mode: 'edit', row })}
					onClone={(row) =>
						manager.open({ kind: 'editor', mode: 'clone', row })
					}
					onClose={manager.close}
				/>
			)}
			<AdminDomainRecoveryDialog
				recovery={manager.manualRecovery}
				busy={manager.mutation.isPending}
			/>
		</section>
	)
}
