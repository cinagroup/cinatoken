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
import type { ProvidersApi, ProviderRequestOptions } from '../provider-api'
import type { ProviderImportResult } from '../provider-contracts'
import { ProviderEndpointPreview } from './ProviderEndpointPreview'
import { providerEndpointSearchTerms } from './provider-endpoint-summary'
import { providerErrorKey } from './provider-errors'

const prefix = 'cinatoken.adminProviders.'
export function ProviderImportDialog(props: {
	api: ProvidersApi
	readOptions: (signal?: AbortSignal) => ProviderRequestOptions
	queryPrefix: readonly unknown[]
	pending: boolean
	disabled: boolean
	error: unknown
	result: ProviderImportResult | null
	onImport: (ids: string[]) => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const [search, setSearch] = useState('')
	const [selected, setSelected] = useState<string[]>([])
	const query = useQuery({
		queryKey: [...props.queryPrefix, 'catalog'],
		queryFn: ({ signal }) =>
			props.api.providerCatalog(props.readOptions(signal)),
		retry: false,
		staleTime: 0,
	})
	const rows = (query.data ?? []).filter((row) =>
		[
			row.id,
			row.name,
			row.description ?? '',
			row.vendor_label,
			row.vendor_key,
			...row.protocols,
			...providerEndpointSearchTerms(row),
		].some((value) => value.toLowerCase().includes(search.trim().toLowerCase()))
	)
	const disabled =
		props.disabled ||
		Boolean(query.error) ||
		query.isFetching ||
		props.result !== null
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'import')}</DialogTitle>
					<DialogDescription>{t(prefix + 'importHint')}</DialogDescription>
				</DialogHeader>
				<Input
					aria-label={t(prefix + 'search')}
					placeholder={t(prefix + 'search')}
					value={search}
					onChange={(event) => setSearch(event.target.value)}
				/>
				{query.isPending && <p role='status'>{t(prefix + 'loading')}</p>}
				{query.error && (
					<div role='alert' className='space-y-2'>
						<p className='text-destructive'>
							{t(providerErrorKey(query.error))}
						</p>
						<Button variant='outline' onClick={() => void query.refetch()}>
							{t(prefix + 'refresh')}
						</Button>
					</div>
				)}
				<div className='flex flex-wrap items-center gap-2'>
					<Button
						variant='outline'
						disabled={disabled}
						onClick={() =>
							setSelected((old) => [
								...new Set([...old, ...rows.map((row) => row.id)]),
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
					<p className='text-muted-foreground text-sm'>
						{t(prefix + 'selected', { count: selected.length })}
					</p>
				</div>
				<div className='grid gap-3 sm:grid-cols-2'>
					{rows.map((row) => (
						<label
							key={row.id}
							className='flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-4'
						>
							<input
								type='checkbox'
								checked={selected.includes(row.id)}
								disabled={disabled}
								onChange={(event) =>
									setSelected((old) =>
										event.target.checked
											? [...old, row.id]
											: old.filter((id) => id !== row.id)
									)
								}
								className='mt-1'
							/>
							<span className='min-w-0 space-y-1'>
								<span className='block font-medium break-words'>
									{row.name}
								</span>
								<span className='text-muted-foreground block text-xs break-words'>
									{row.description}
								</span>
								<span className='text-muted-foreground block text-xs'>
									{row.protocols.join(' · ')}
								</span>
								<ProviderEndpointPreview source={row} />
							</span>
						</label>
					))}
				</div>
				{!query.isPending && !query.error && rows.length === 0 && (
					<p>{t(prefix + 'noMatches')}</p>
				)}
				{props.result && (
					<div role='status' className='rounded-xl border p-4'>
						<p>
							{t(prefix + 'importResult', {
								created: props.result.created,
								skipped: props.result.skipped_existing.length,
								failed: props.result.failed.length,
							})}
						</p>
						{props.result.skipped_existing.map((id) => (
							<p key={id} className='mt-2 text-sm break-words'>
								{t(prefix + 'importSkippedItem', { id })}
							</p>
						))}
						{props.result.failed.map((row) => (
							<p key={row.id} className='text-destructive mt-2 text-sm'>
								{t(prefix + 'importFailedItem', { id: row.id })}
							</p>
						))}
					</div>
				)}
				{props.error != null && (
					<div role='alert' className='text-destructive space-y-2 text-sm'>
						<p>{t(providerErrorKey(props.error))}</p>
						<p>{t(prefix + 'writeUnknown')}</p>
					</div>
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
						disabled={disabled || !selected.length || props.error != null}
						onClick={() => props.onImport(selected)}
					>
						{t(prefix + (props.pending ? 'saving' : 'import'))}
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
