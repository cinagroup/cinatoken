/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import { AdminDomainRecoveryDialog } from '../AdminDomainRecoveryDialog'
import type { AdminEndpoint, EndpointChoices } from '../endpoint-contracts'
import {
	ENDPOINT_LIST_FILTERS,
	validateEndpointSearch,
	type EndpointFilters,
	type EndpointListFilter,
} from '../endpoint-search'
import { EndpointActionDialog } from './EndpointActionDialog'
import { EndpointBootstrapDialog } from './EndpointBootstrapDialog'
import { EndpointDetailDialog } from './EndpointDetailDialog'
import { EndpointEditorDialog } from './EndpointEditorDialog'
import { endpointErrorKey } from './endpoint-errors'
import { endpointIsExpired } from './endpoint-form'
import { filterEndpoints } from './endpoint-list'
import {
	useEndpointsManager,
	type EndpointManagerProps,
} from './use-endpoints-manager'

const prefix = 'cinatoken.adminEndpoints.'
const selectClass = 'bg-background h-10 min-w-0 rounded-md border px-3 text-sm'
const emptyChoices: EndpointChoices = { models: [], providers: [], routes: [] }

export type AdminEndpointsProps = EndpointManagerProps & {
	initialFilters?: Partial<EndpointFilters>
	onFiltersChange?: (filters: EndpointFilters) => void
}

export function AdminEndpoints(props: AdminEndpointsProps) {
	return (
		<ScopedEndpoints
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
			])}
			{...props}
		/>
	)
}

function EndpointRow(props: {
	row: AdminEndpoint
	disabled: boolean
	onOpen: (id: string) => void
}) {
	const { t } = useTranslation()
	const expired = endpointIsExpired(props.row)
	return (
		<article className='flex min-w-0 flex-col gap-4 rounded-xl border p-4 sm:flex-row sm:items-center sm:justify-between'>
			<div className='min-w-0 space-y-1'>
				<div className='flex flex-wrap items-center gap-2'>
					<p className='font-medium break-all'>{props.row.tag}</p>
					<span className='bg-muted rounded-full px-2 py-0.5 text-xs'>
						{t(prefix + (expired ? 'expired' : props.row.status))}
					</span>
				</div>
				<p className='text-muted-foreground font-mono text-xs break-all'>
					{props.row.id}
				</p>
				<p className='text-muted-foreground text-xs break-all'>
					{props.row.model_id} · {props.row.provider_slug} ·{' '}
					{props.row.provider_id}
				</p>
				<p className='text-muted-foreground text-xs'>
					{t(prefix + 'linkedRoutes', {
						count: props.row.route_target_ids.length,
					})}
				</p>
			</div>
			<Button
				type='button'
				variant='outline'
				className='w-full shrink-0 sm:w-auto'
				disabled={props.disabled}
				onClick={() => props.onOpen(props.row.id)}
			>
				{t(prefix + 'details')}
			</Button>
		</article>
	)
}

function ScopedEndpoints(props: AdminEndpointsProps) {
	const { t } = useTranslation()
	const [localFilters, setLocalFilters] = useState<EndpointFilters>(() =>
		validateEndpointSearch(props.initialFilters)
	)
	const [page, setPage] = useState(0)
	const filters = props.onFiltersChange
		? validateEndpointSearch(props.initialFilters)
		: localFilters
	const manager = useEndpointsManager(props, filters)
	const choices = manager.choices.data ?? emptyChoices
	const rows = filterEndpoints(manager.rows, filters)
	const pages = Math.max(1, Math.ceil(rows.length / 20))
	const currentPage = Math.min(page, pages - 1)
	const visible = rows.slice(currentPage * 20, (currentPage + 1) * 20)
	const modal = manager.modal
	function changeFilters(next: EndpointFilters): void {
		setLocalFilters(next)
		setPage(0)
		props.onFiltersChange?.(next)
	}
	function optionLabel(id: string, name: string | null | undefined): string {
		return name ? `${name} · ${id}` : id
	}
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
						type='button'
						variant='outline'
						disabled={
							manager.list.isFetching ||
							manager.choices.isFetching ||
							manager.mutation.isPending
						}
						onClick={() => void manager.retry().catch(() => undefined)}
					>
						{t(prefix + 'refresh')}
					</Button>
					<Button
						type='button'
						variant='outline'
						disabled={manager.disabled}
						onClick={() => manager.open({ kind: 'bootstrap' })}
					>
						{t(prefix + 'bootstrap')}
					</Button>
					<Button
						type='button'
						disabled={manager.disabled}
						onClick={() => manager.open({ kind: 'editor' })}
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
			{manager.list.error != null && (
				<div
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(endpointErrorKey(manager.list.error))}
				</div>
			)}
			{manager.choices.error != null && (
				<div
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(endpointErrorKey(manager.choices.error))}
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
			{manager.writeUnconfirmed &&
				!manager.mutation.isPending &&
				!manager.hidden && (
					<p
						role='alert'
						className='text-destructive rounded-xl border p-4 text-sm'
					>
						{t(prefix + 'writeUnknown')}
					</p>
				)}
			<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
				<Input
					value={filters.q}
					onChange={(event) =>
						changeFilters({ ...filters, q: event.target.value })
					}
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
				/>
				<select
					className={selectClass}
					value={filters.status}
					aria-label={t(prefix + 'statusFilter')}
					onChange={(event) =>
						changeFilters({
							...filters,
							status: event.target.value as EndpointListFilter,
						})
					}
				>
					{ENDPOINT_LIST_FILTERS.map((status) => (
						<option value={status} key={status}>
							{t(prefix + status)}
						</option>
					))}
				</select>
				<select
					className={selectClass}
					value={filters.model}
					aria-label={t(prefix + 'modelFilter')}
					onChange={(event) =>
						changeFilters({ ...filters, model: event.target.value })
					}
				>
					<option value=''>{t(prefix + 'allModels')}</option>
					{filters.model &&
						!choices.models.some((row) => row.id === filters.model) && (
							<option value={filters.model}>{filters.model}</option>
						)}
					{choices.models.map((row) => (
						<option key={row.id} value={row.id}>
							{optionLabel(row.id, row.display_name)}
						</option>
					))}
				</select>
				<select
					className={selectClass}
					value={filters.provider}
					aria-label={t(prefix + 'providerFilter')}
					onChange={(event) =>
						changeFilters({ ...filters, provider: event.target.value })
					}
				>
					<option value=''>{t(prefix + 'allProviders')}</option>
					{filters.provider &&
						!choices.providers.some((row) => row.id === filters.provider) && (
							<option value={filters.provider}>{filters.provider}</option>
						)}
					{choices.providers.map((row) => (
						<option key={row.id} value={row.id}>
							{optionLabel(row.id, row.name)}
						</option>
					))}
				</select>
			</div>
			<div className='flex flex-wrap items-center justify-between gap-2 text-sm'>
				<p className='text-muted-foreground'>
					{t(prefix + 'count', {
						count: rows.length,
						total: manager.rows.length,
					})}
				</p>
				{(filters.q ||
					filters.status !== 'all' ||
					filters.model ||
					filters.provider) && (
					<Button
						type='button'
						variant='outline'
						size='sm'
						onClick={() =>
							changeFilters({ q: '', status: 'all', model: '', provider: '' })
						}
					>
						{t(prefix + 'clearFilters')}
					</Button>
				)}
			</div>
			{manager.rows.length >= 1000 && (
				<p role='status' className='text-sm text-amber-700 dark:text-amber-300'>
					{t(prefix + 'listLimit')}
				</p>
			)}
			{manager.list.isPending && props.canWrite && (
				<p role='status'>{t(prefix + 'loading')}</p>
			)}
			{!manager.hidden && !manager.list.isPending && rows.length === 0 && (
				<div className='rounded-xl border border-dashed p-8 text-center text-sm'>
					{t(prefix + (manager.rows.length ? 'noMatches' : 'empty'))}
				</div>
			)}
			<div className='space-y-3'>
				{visible.map((row) => (
					<EndpointRow
						key={row.id}
						row={row}
						disabled={manager.disabled}
						onOpen={(id) => manager.open({ kind: 'detail', id })}
					/>
				))}
			</div>
			{pages > 1 && (
				<div className='flex flex-wrap items-center justify-between gap-3'>
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'page', { page: currentPage + 1, total: pages })}
					</p>
					<div className='flex gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={currentPage === 0}
							onClick={() => setPage(currentPage - 1)}
						>
							{t(prefix + 'previous')}
						</Button>
						<Button
							type='button'
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
				<EndpointEditorDialog
					key={modal.row?.id ?? 'new'}
					row={modal.row}
					choices={choices}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onSave={manager.save}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'detail' && (
				<EndpointDetailDialog
					api={props.api}
					id={modal.id}
					choices={choices}
					queryPrefix={manager.prefix}
					readOptions={manager.readOptions}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onEdit={(row) => manager.open({ kind: 'editor', row })}
					onChange={(row, action) =>
						manager.open({ kind: 'confirm', row, action })
					}
					onToggleRoute={manager.toggleRoute}
					onClose={manager.close}
				/>
			)}
			{modal?.kind === 'confirm' && (
				<EndpointActionDialog
					row={modal.row}
					action={modal.action}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onClose={manager.close}
					onConfirm={() => {
						if (modal.action === 'delete') manager.deleteEndpoint(modal.row)
						else
							manager.changeStatus(
								modal.row,
								modal.action === 'publish'
									? 'verified'
									: modal.action === 'disable'
										? 'disabled'
										: 'draft'
							)
					}}
				/>
			)}
			{modal?.kind === 'bootstrap' && (
				<EndpointBootstrapDialog
					result={manager.bootstrapResult}
					pending={manager.mutation.isPending}
					disabled={manager.disabled}
					error={manager.mutation.error}
					onConfirm={manager.bootstrap}
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
