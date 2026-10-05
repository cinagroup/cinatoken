import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Input } from '../../../components/ui/input'
import type { AdminDomainRequestOptions } from '../domain-transport'
import type { ModelsApi } from '../model-api'
import type { ModelImportResult } from '../model-contracts'
import { modelErrorKey } from './model-errors'

const prefix = 'cinatoken.adminModels.'
export function ModelImportDialog(props: {
	api: ModelsApi
	readOptions?: (signal?: AbortSignal) => AdminDomainRequestOptions
	installedIds: readonly string[]
	prefix: readonly unknown[]
	pending: boolean
	disabled: boolean
	error: unknown
	result: ModelImportResult | null
	onImport: (ids: string[]) => void
	onClose: () => void
}) {
	const { t, i18n } = useTranslation()
	const [search, setSearch] = useState('')
	const [kind, setKind] = useState<'all' | 'llm' | 'image' | 'audio'>('all')
	const [selected, setSelected] = useState<string[]>([])
	const query = useQuery({
		queryKey: [...props.prefix, 'catalog'],
		queryFn: ({ signal }) =>
			props.api.modelCatalog(props.readOptions?.(signal) ?? { signal }),
		retry: false,
		staleTime: 0,
	})
	const rows = (query.error ? [] : (query.data?.items ?? [])).filter(
		(row) =>
			(kind === 'all' || row.kind === kind) &&
			[
				row.id,
				row.display_name ?? '',
				row.vendor,
				row.description ?? '',
				row.i18n?.en ?? '',
				row.i18n?.zh ?? '',
			].some((value) =>
				value.toLowerCase().includes(search.trim().toLowerCase())
			)
	)
	const disabled =
		props.disabled ||
		props.pending ||
		query.isFetching ||
		Boolean(query.error) ||
		props.result !== null
	const installed = new Set(props.installedIds)
	const importable = rows.filter((row) => !installed.has(row.id))
	const selectedImportable = selected.filter((id) => !installed.has(id))
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-4xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'import')}</DialogTitle>
					<DialogDescription>{t(prefix + 'importHint')}</DialogDescription>
				</DialogHeader>
				<div className='grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]'>
					<Input
						aria-label={t(prefix + 'search')}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
						placeholder={t(prefix + 'search')}
					/>
					<select
						aria-label={t(prefix + 'kind')}
						className='bg-background h-10 rounded-md border px-3'
						value={kind}
						onChange={(event) => setKind(event.target.value as typeof kind)}
					>
						{['all', 'llm', 'image', 'audio'].map((value) => (
							<option key={value} value={value}>
								{t(prefix + value)}
							</option>
						))}
					</select>
				</div>
				{query.isFetching && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.error && (
					<div role='alert' className='space-y-2'>
						<p className='text-destructive'>{t(modelErrorKey(query.error))}</p>
						<Button
							variant='outline'
							disabled={query.isFetching}
							onClick={() => void query.refetch()}
						>
							{t(prefix + 'refresh')}
						</Button>
					</div>
				)}
				{query.data && !query.error && (
					<p className='rounded-lg border p-3 text-sm'>
						{t(prefix + 'catalogCurrency', {
							currency: query.data.billingCurrency,
						})}
					</p>
				)}
				<div className='flex flex-wrap items-center gap-2'>
					<Button
						variant='outline'
						disabled={disabled}
						onClick={() =>
							setSelected((old) => [
								...new Set([...old, ...importable.map((row) => row.id)]),
							])
						}
					>
						{t(prefix + 'selectAll')}
					</Button>
					<Button
						variant='outline'
						disabled={disabled}
						onClick={() => setSelected([])}
					>
						{t(prefix + 'clearSelection')}
					</Button>
					<p>{t(prefix + 'selected', { count: selectedImportable.length })}</p>
					<p>
						{t('cinatoken.adminDomain.importable', {
							count: importable.length,
						})}
					</p>
				</div>
				<div className='grid gap-3 sm:grid-cols-2'>
					{rows.map((row) => (
						<label
							key={row.id}
							className='flex min-w-0 items-start gap-3 rounded-xl border p-4'
						>
							<input
								className='mt-1'
								type='checkbox'
								disabled={disabled || installed.has(row.id)}
								checked={selectedImportable.includes(row.id)}
								onChange={(event) =>
									setSelected((old) =>
										event.target.checked
											? [...old, row.id]
											: old.filter((id) => id !== row.id)
									)
								}
							/>
							<span className='min-w-0 space-y-2'>
								<span className='block font-medium break-words'>
									{row.display_name ?? row.id}
								</span>
								<span className='text-muted-foreground block text-xs break-words'>
									{row.id} · {row.vendor} · {t(prefix + row.kind)}
								</span>
								{installed.has(row.id) && (
									<span className='block text-xs'>
										{t('cinatoken.adminDomain.installed')}
									</span>
								)}
								<span className='block text-xs'>
									{t(prefix + 'context_window')}: {row.context_window ?? '—'} ·{' '}
									{t(prefix + 'max_tokens')}: {row.max_tokens ?? '—'}
								</span>
								<span className='block text-xs'>
									{t('cinatoken.adminDomain.tiers', { count: row.tier_count })}
								</span>
								<span className='block text-sm'>
									{row.pricing_label ?? '—'}
								</span>
								<span className='text-muted-foreground block text-xs whitespace-pre-wrap'>
									{row.pricing_preview}
								</span>
								<span className='text-muted-foreground block text-xs'>
									{(i18n.resolvedLanguage ?? '').startsWith('zh')
										? (row.i18n?.zh ?? row.description)
										: (row.i18n?.en ?? row.description)}
								</span>
							</span>
						</label>
					))}
				</div>
				{!query.isFetching && !query.error && !rows.length && (
					<p>{t(prefix + 'noMatches')}</p>
				)}
				{props.result && (
					<div role='status' className='space-y-2 rounded-xl border p-4'>
						<p>
							{t(prefix + 'importResult', {
								created: props.result.created,
								skipped: props.result.skipped_existing.length,
								failed: props.result.failed.length,
								currency: props.result.billing_currency_used,
							})}
						</p>
						{props.result.skipped_existing.map((id) => (
							<p key={id} className='text-muted-foreground text-xs break-words'>
								{t(prefix + 'skippedItem', { id })}
							</p>
						))}
						{props.result.failed.map((row) => (
							<p key={row.id} className='text-destructive text-sm break-words'>
								{t(prefix + 'failedItem', { id: row.id })}
							</p>
						))}
					</div>
				)}
				{props.error !== null && (
					<p role='alert' className='text-destructive'>
						{t(modelErrorKey(props.error))}
					</p>
				)}
				<div className='flex flex-wrap justify-end gap-2'>
					<Button
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
					<Button
						disabled={
							disabled || !selectedImportable.length || props.error !== null
						}
						onClick={() => props.onImport(selectedImportable)}
					>
						{t(prefix + 'importSelected')}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
