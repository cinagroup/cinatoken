import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import { ModelEditorDialog } from './ModelEditorDialog'
import { ModelImportDialog } from './ModelImportDialog'
import { ModelPricePreview } from './ModelPricePreview'
import { ModelReadDialog } from './ModelReadDialog'
import { modelErrorKey } from './model-errors'
import {
	DEFAULT_MODEL_FILTERS,
	filterModels,
	type ModelFilters,
} from './model-form'
import { useModelsManager, type ModelManagerProps } from './use-models-manager'

export type AdminModelsProps = ModelManagerProps & {
	initialFilters?: Partial<ModelFilters> & {
		edit?: string
		invalidEdit?: boolean
	}
	onFiltersChange?: (filters: ModelFilters) => void
	onEditConsumed?: () => void
}
const prefix = 'cinatoken.adminModels.'
export function AdminModels(props: AdminModelsProps) {
	return (
		<ScopedModels
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
			])}
			{...props}
		/>
	)
}
function ScopedModels(props: AdminModelsProps) {
	const { t } = useTranslation()
	const manager = useModelsManager(props)
	const consumedEdit = useRef<string | null>(null)
	const requestedEdit = props.initialFilters?.edit
	const requestedMissing = Boolean(
		requestedEdit &&
		manager.query.isSuccess &&
		!manager.query.isFetching &&
		!manager.query.error &&
		!manager.rows.some((row) => row.id === requestedEdit)
	)
	const [editFeedback, setEditFeedback] = useState<{
		id: string
		missing: boolean
	} | null>(null)
	if (
		requestedEdit &&
		manager.query.isSuccess &&
		!manager.query.isFetching &&
		!manager.query.error &&
		(editFeedback?.id !== requestedEdit ||
			editFeedback.missing !== requestedMissing)
	)
		setEditFeedback({ id: requestedEdit, missing: requestedMissing })
	const openModel = manager.open
	const consumeEdit = props.onEditConsumed
	const editReady =
		!manager.disabled && manager.query.isSuccess && !manager.query.isFetching
	useEffect(() => {
		if (!requestedEdit) {
			consumedEdit.current = null
			return
		}
		if (consumedEdit.current === requestedEdit || !editReady) return
		consumedEdit.current = requestedEdit
		if (!requestedMissing) openModel({ kind: 'edit', id: requestedEdit })
		consumeEdit?.()
	}, [requestedEdit, requestedMissing, editReady, openModel, consumeEdit])
	const [local, setLocal] = useState<ModelFilters>({
		...DEFAULT_MODEL_FILTERS,
		...props.initialFilters,
	})
	const [page, setPage] = useState(0)
	const filters =
		props.onFiltersChange && props.initialFilters
			? { ...DEFAULT_MODEL_FILTERS, ...props.initialFilters }
			: local
	const rows = useMemo(
		() =>
			filterModels(manager.rows, {
				q: filters.q,
				vendor: filters.vendor,
				kind: filters.kind,
				availability: filters.availability,
			}),
		[
			manager.rows,
			filters.q,
			filters.vendor,
			filters.kind,
			filters.availability,
		]
	)
	const vendors = [...new Set(manager.rows.map((row) => row.vendor))].sort()
	const pages = Math.max(1, Math.ceil(rows.length / 20))
	const current = Math.min(page, pages - 1)
	function change(next: ModelFilters): void {
		setLocal(next)
		setPage(0)
		props.onFiltersChange?.(next)
	}
	const modal = manager.modal
	return (
		<section className='space-y-6'>
			<AdminDomainRecoveryDialog recovery={manager.manualRecovery} />
			{(props.initialFilters?.invalidEdit || editFeedback?.missing) && (
				<p role='alert' className='text-destructive'>
					{t(
						'cinatoken.adminDomain.' +
							(editFeedback?.missing ? 'missingEdit' : 'invalidEdit')
					)}
				</p>
			)}
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
						onClick={() => manager.open({ kind: 'create' })}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground rounded-xl border p-4 text-sm'>
				{t(prefix + 'supplierHint')}
			</p>
			{manager.billingCurrency && (
				<p className='text-muted-foreground rounded-xl border p-4 text-sm'>
					{t(prefix + 'currencyCurrent', {
						currency: manager.billingCurrency,
					})}
				</p>
			)}
			{manager.query.error && (
				<p role='alert' className='text-destructive'>
					{t(modelErrorKey(manager.query.error))}
				</p>
			)}
			{manager.hidden && props.canWrite && (
				<p role='alert' className='text-destructive'>
					{t(modelErrorKey(manager.blockedError ?? manager.query.error))}
				</p>
			)}
			{!props.canWrite && <p role='status'>{t(prefix + 'readonly')}</p>}
			{manager.writeUnknown &&
				!manager.hidden &&
				!manager.mutation.isPending && (
					<p role='alert' className='text-destructive rounded-xl border p-4'>
						{t(prefix + 'writeUnknown')}
					</p>
				)}
			{manager.notice && !manager.hidden && !manager.writeUnknown && (
				<p role='status'>{t(prefix + 'saved')}</p>
			)}
			<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
				<Input
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
					value={filters.q}
					onChange={(event) => change({ ...filters, q: event.target.value })}
				/>
				<select
					aria-label={t(prefix + 'vendor')}
					className='bg-background h-10 rounded-md border px-3'
					value={filters.vendor}
					onChange={(event) =>
						change({ ...filters, vendor: event.target.value })
					}
				>
					<option value='all'>{t(prefix + 'allVendors')}</option>
					{vendors.map((vendor) => (
						<option key={vendor} value={vendor}>
							{vendor}
						</option>
					))}
				</select>
				<select
					aria-label={t(prefix + 'kind')}
					className='bg-background h-10 rounded-md border px-3'
					value={filters.kind}
					onChange={(event) =>
						change({
							...filters,
							kind: event.target.value as ModelFilters['kind'],
						})
					}
				>
					{['all', 'llm', 'image', 'audio', 'rerank'].map((value) => (
						<option key={value} value={value}>
							{t(prefix + value)}
						</option>
					))}
				</select>
				<select
					aria-label={t(prefix + 'availability')}
					className='bg-background h-10 rounded-md border px-3'
					value={filters.availability}
					onChange={(event) =>
						change({
							...filters,
							availability: event.target.value as ModelFilters['availability'],
						})
					}
				>
					{['all', 'callable', 'unrouted'].map((value) => (
						<option key={value} value={value}>
							{t(prefix + value)}
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
					<Button
						variant='outline'
						onClick={() => change(DEFAULT_MODEL_FILTERS)}
					>
						{t(prefix + 'clearFilters')}
					</Button>
				</div>
			)}
			<div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
				{rows.slice(current * 20, (current + 1) * 20).map((row) => (
					<article
						key={row.id}
						className='min-w-0 space-y-3 rounded-xl border p-4'
					>
						<h2 className='font-semibold break-words'>
							{row.display_name ?? row.id}
						</h2>
						<p className='text-muted-foreground text-xs break-words'>
							{row.id} · {row.vendor}
						</p>
						<div className='flex flex-wrap gap-2 text-xs'>
							<span className='bg-muted rounded-full px-2 py-1'>
								{t(prefix + row.kind)}
							</span>
							{row.tags.map((tag) => (
								<span key={tag} className='bg-muted rounded-full px-2 py-1'>
									{tag}
								</span>
							))}
						</div>
						<ModelPricePreview row={row} />
						<p className='text-muted-foreground text-sm'>
							{t(prefix + 'routeCounts', {
								active: row.active_routes_count,
								total: row.routes_count,
							})}
						</p>
						<p className='text-xs'>
							{t(prefix + 'input_modalities')}:{' '}
							{row.inputModalities
								?.map((value) => t(prefix + 'modality_' + value))
								.join(' · ') ?? '—'}
						</p>
						<p className='text-xs'>
							{t(prefix + 'output_modalities')}:{' '}
							{row.outputModalities
								?.map((value) => t(prefix + 'modality_' + value))
								.join(' · ') ?? '—'}
						</p>
						<div className='flex flex-wrap gap-2'>
							<Button
								variant='outline'
								disabled={manager.disabled}
								onClick={() => manager.open({ kind: 'detail', id: row.id })}
							>
								{t(prefix + 'detail')}
							</Button>
							<Button
								variant='outline'
								disabled={manager.disabled}
								onClick={() => manager.open({ kind: 'edit', id: row.id })}
							>
								{t(prefix + 'edit')}
							</Button>
							<Button
								variant='outline'
								disabled={manager.disabled}
								onClick={() => manager.open({ kind: 'delete', id: row.id })}
							>
								{t(prefix + 'delete')}
							</Button>
						</div>
					</article>
				))}
			</div>
			{pages > 1 && (
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<p>{t(prefix + 'page', { page: current + 1, total: pages })}</p>
					<div className='flex gap-2'>
						<Button
							variant='outline'
							disabled={current === 0}
							onClick={() => setPage(current - 1)}
						>
							{t(prefix + 'previous')}
						</Button>
						<Button
							variant='outline'
							disabled={current >= pages - 1}
							onClick={() => setPage(current + 1)}
						>
							{t(prefix + 'next')}
						</Button>
					</div>
				</div>
			)}
			{modal?.kind === 'create' && (
				<ModelEditorDialog
					billingCurrency={manager.billingCurrency}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onSave={manager.save}
					onClose={manager.close}
				/>
			)}
			{modal && 'id' in modal && (
				<ModelReadDialog
					key={modal.kind + modal.id}
					api={props.api}
					readOptions={manager.readOptions}
					prefix={manager.prefix}
					id={modal.id}
					mode={modal.kind}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onSave={manager.save}
					onDelete={manager.remove}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'import' && (
				<ModelImportDialog
					api={props.api}
					readOptions={manager.readOptions}
					installedIds={manager.rows.map((row) => row.id)}
					prefix={manager.prefix}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					result={manager.importResult}
					onImport={manager.importModels}
					onClose={manager.close}
				/>
			)}
		</section>
	)
}
