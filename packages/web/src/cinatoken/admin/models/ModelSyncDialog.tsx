/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Alert, AlertDescription } from '../../../components/ui/alert'
import { Button } from '../../../components/ui/button'
import { Checkbox } from '../../../components/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '../../../components/ui/dialog'
import { Field, FieldGroup, FieldLabel } from '../../../components/ui/field'
import { Input } from '../../../components/ui/input'
import {
	NativeSelect,
	NativeSelectOption,
} from '../../../components/ui/native-select'
import type { AdminDomainRequestOptions } from '../domain-transport'
import type { ModelsApi } from '../model-api'
import type {
	ModelSyncItem,
	ModelSyncReport,
	ModelSyncResult,
} from '../model-contracts'
import { ModelSyncDiff } from './ModelSyncDiff'
import { modelErrorKey } from './model-errors'
import {
	filterModelSyncGroups,
	selectedModelSyncItems,
	selectModelSyncMetadata,
} from './model-sync-domain'

const prefix = 'cinatoken.adminModels.'
type ReviewProps = {
	report: ModelSyncReport
	disabled: boolean
	onApply: (items: ModelSyncItem[]) => void
}
export function ModelSyncReview(props: ReviewProps) {
	const { t } = useTranslation()
	const id = useId()
	const [filters, setFilters] = useState({
		search: '',
		vendor: 'all',
		kind: 'all',
	})
	const [selection, setSelection] = useState<string[]>([])
	const [confirmed, setConfirmed] = useState(false)
	const [page, setPage] = useState(0)
	const groups = filterModelSyncGroups(props.report, filters)
	const visible = groups.flatMap((group) => group.models)
	const pages = Math.max(1, Math.ceil(visible.length / 20))
	const current = Math.min(page, pages - 1)
	const pageIds = new Set(
		visible
			.slice(current * 20, (current + 1) * 20)
			.map((model) => model.model_id)
	)
	const pageGroups = groups
		.map((group) => ({
			...group,
			models: group.models.filter((model) => pageIds.has(model.model_id)),
		}))
		.filter((group) => group.models.length)
	const items = selectedModelSyncItems(props.report, selection)
	const prices = items.some((item) => item.fields.includes('pricing_profile'))
	function choose(next: string[]): void {
		setSelection(next)
		setConfirmed(false)
	}
	function change(next: typeof filters): void {
		setFilters(next)
		setPage(0)
	}
	return (
		<div className='flex min-w-0 flex-col gap-4'>
			<p className='text-muted-foreground text-sm'>
				{t(prefix + 'syncCurrency', {
					currency: props.report.billing_currency,
					count: props.report.models_with_diff,
				})}
			</p>
			<FieldGroup className='grid gap-3 sm:grid-cols-3'>
				<Field>
					<FieldLabel htmlFor={id + '-search'}>
						{t(prefix + 'search')}
					</FieldLabel>
					<Input
						id={id + '-search'}
						value={filters.search}
						onChange={(event) =>
							change({ ...filters, search: event.target.value })
						}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor={id + '-vendor'}>
						{t(prefix + 'vendor')}
					</FieldLabel>
					<NativeSelect
						className='w-full min-w-0'
						id={id + '-vendor'}
						value={filters.vendor}
						onChange={(event) =>
							change({ ...filters, vendor: event.target.value })
						}
					>
						<NativeSelectOption value='all'>
							{t(prefix + 'allVendors')}
						</NativeSelectOption>
						{props.report.groups.map((group) => (
							<NativeSelectOption key={group.vendor} value={group.vendor}>
								{group.vendor_label}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
				<Field>
					<FieldLabel htmlFor={id + '-kind'}>{t(prefix + 'kind')}</FieldLabel>
					<NativeSelect
						className='w-full min-w-0'
						id={id + '-kind'}
						value={filters.kind}
						onChange={(event) =>
							change({ ...filters, kind: event.target.value })
						}
					>
						{['all', 'llm', 'image', 'audio', 'rerank'].map((kind) => (
							<NativeSelectOption key={kind} value={kind}>
								{t(prefix + kind)}
							</NativeSelectOption>
						))}
					</NativeSelect>
				</Field>
			</FieldGroup>
			<div className='flex flex-wrap items-center gap-2'>
				<Button
					variant='outline'
					disabled={props.disabled || !visible.length}
					onClick={() => choose(selectModelSyncMetadata(groups, selection))}
				>
					{t(prefix + 'syncSelectMetadata')}
				</Button>
				<Button
					variant='outline'
					disabled={props.disabled || !selection.length}
					onClick={() => choose([])}
				>
					{t(prefix + 'clearSelection')}
				</Button>
				<p role='status' className='text-sm'>
					{t(prefix + 'syncSelected', {
						fields: selection.length,
						models: items.length,
					})}
				</p>
			</div>
			{!visible.length && (
				<p role='status'>
					{t(
						prefix +
							(props.report.models_with_diff ? 'noMatches' : 'syncNoDiff')
					)}
				</p>
			)}
			<ModelSyncDiff
				groups={pageGroups}
				selection={selection}
				disabled={props.disabled}
				onToggle={(key, checked) =>
					choose(
						checked
							? [...selection, key]
							: selection.filter((value) => value !== key)
					)
				}
			/>
			{pages > 1 && (
				<div className='flex flex-wrap items-center gap-2'>
					<Button
						variant='outline'
						disabled={current === 0}
						onClick={() => setPage(current - 1)}
					>
						{t(prefix + 'previous')}
					</Button>
					<p>{t(prefix + 'page', { page: current + 1, total: pages })}</p>
					<Button
						variant='outline'
						disabled={current >= pages - 1}
						onClick={() => setPage(current + 1)}
					>
						{t(prefix + 'next')}
					</Button>
				</div>
			)}
			{prices && (
				<Field orientation='horizontal' data-disabled={props.disabled}>
					<Checkbox
						id={id + '-confirm'}
						checked={confirmed}
						disabled={props.disabled}
						onCheckedChange={setConfirmed}
					/>
					<FieldLabel htmlFor={id + '-confirm'}>
						{t(prefix + 'syncPricingConfirm')}
					</FieldLabel>
				</Field>
			)}
			<Button
				disabled={props.disabled || !items.length || (prices && !confirmed)}
				onClick={() => props.onApply(items)}
			>
				{t(prefix + 'syncApply')}
			</Button>
		</div>
	)
}

export function ModelSyncOutcome(props: { result: ModelSyncResult }) {
	const { t } = useTranslation()
	return (
		<Alert role={props.result.failed.length ? 'alert' : 'status'}>
			<AlertDescription>
				<p>
					{t(prefix + 'syncResult', {
						updated: props.result.updated,
						skipped: props.result.skipped,
						failed: props.result.failed.length,
					})}
				</p>
				{props.result.failed.length > 0 && (
					<ul className='list-inside list-disc'>
						{props.result.failed.map((item) => (
							<li key={item.model_id} className='break-all'>
								{item.model_id}: {t(prefix + 'syncFailed')}
							</li>
						))}
					</ul>
				)}
				<p>{t(prefix + 'syncRecheckHint')}</p>
			</AlertDescription>
		</Alert>
	)
}

export function ModelSyncDialog(props: {
	api: ModelsApi
	readOptions: (signal?: AbortSignal) => AdminDomainRequestOptions
	prefix: readonly unknown[]
	pending: boolean
	disabled: boolean
	error: unknown
	result: ModelSyncResult | null
	onApply: (items: ModelSyncItem[]) => void
	onRecheck: () => void
	onClose: () => void
}) {
	const { t } = useTranslation()
	const query = useQuery({
		queryKey: [...props.prefix, 'sync-diff'],
		queryFn: ({ signal }) =>
			props.api.modelSyncReport(props.readOptions(signal)),
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !props.pending) props.onClose()
			}}
		>
			<DialogContent
				className='max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl'
				showCloseButton={false}
			>
				<DialogHeader>
					<DialogTitle>{t(prefix + 'syncTitle')}</DialogTitle>
					<DialogDescription>{t(prefix + 'syncHint')}</DialogDescription>
				</DialogHeader>
				<div className='flex flex-wrap justify-between gap-2'>
					<Button
						variant='outline'
						disabled={props.pending || query.isFetching}
						onClick={() => {
							props.onRecheck()
							void query.refetch()
						}}
					>
						{t(prefix + 'syncCheck')}
					</Button>
					<Button
						variant='outline'
						disabled={props.pending}
						onClick={props.onClose}
					>
						{t(prefix + 'close')}
					</Button>
				</div>
				{query.isFetching && <p role='status'>{t(prefix + 'syncLoading')}</p>}
				{(query.error || props.error) != null && (
					<Alert variant='destructive'>
						<AlertDescription>
							{t(modelErrorKey(query.error ?? props.error))}
						</AlertDescription>
					</Alert>
				)}
				{props.result && <ModelSyncOutcome result={props.result} />}
				{query.data && !query.error && !query.isFetching && (
					<ModelSyncReview
						key={query.dataUpdatedAt}
						report={query.data}
						disabled={props.disabled || props.result !== null}
						onApply={props.onApply}
					/>
				)}
			</DialogContent>
		</Dialog>
	)
}
