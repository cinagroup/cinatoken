/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import type { AdminModel } from '../model-contracts'
import type { AdminProvider } from '../provider-contracts'
import {
	routeModelVendor,
	routeModelVendorLabel,
	type RouteFilters,
} from './route-domain'

const prefix = 'cinatoken.adminRoutes.'
const selectClass =
	'bg-background h-10 w-full min-w-0 rounded-md border px-3 text-sm'
export function RouteFiltersPanel(props: {
	filters: RouteFilters
	models: AdminModel[]
	providers: AdminProvider[]
	groups: string[]
	onChange: (patch: Partial<RouteFilters>) => void
	onClear: () => void
}) {
	const { t } = useTranslation()
	const select = (
		name: keyof RouteFilters,
		label: string,
		values: { value: string; label: string }[]
	) => (
		<label className='min-w-0 space-y-1 text-xs'>
			<span>{t(prefix + label)}</span>
			<select
				className={selectClass}
				value={String(props.filters[name] ?? '')}
				onChange={(event) => props.onChange({ [name]: event.target.value })}
			>
				{values.map((item) => (
					<option key={item.value} value={item.value}>
						{item.label}
					</option>
				))}
			</select>
		</label>
	)
	return (
		<div className='space-y-3 rounded-xl border p-4'>
			{props.filters.invalid && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'invalidFilters')}
				</p>
			)}
			<div className='grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4'>
				<label className='space-y-1 text-xs'>
					<span>{t(prefix + 'search')}</span>
					<Input
						value={props.filters.q}
						onChange={(event) => props.onChange({ q: event.target.value })}
					/>
				</label>
				{select('model', 'modelFilter', [
					{ value: '', label: t(prefix + 'allModels') },
					...props.models.map((model) => ({
						value: model.id,
						label: model.display_name || model.id,
					})),
				])}
				{select('provider_id', 'providerFilter', [
					{ value: '', label: t(prefix + 'allProviders') },
					...props.providers.map((provider) => ({
						value: provider.id,
						label: provider.name,
					})),
				])}
				{select(
					'status',
					'statusFilter',
					['all', 'active', 'inactive'].map((status) => ({
						value: status,
						label: t(prefix + (status === 'all' ? 'allStatuses' : status)),
					}))
				)}
				{select('route_group', 'groupFilter', [
					{ value: '', label: t(prefix + 'allGroups') },
					...props.groups.map((group) => ({ value: group, label: group })),
				])}
				{select(
					'kind',
					'kindFilter',
					['all', 'llm', 'image', 'audio', 'rerank'].map((kind) => ({
						value: kind,
						label: t(prefix + (kind === 'all' ? 'allKinds' : 'kind' + kind)),
					}))
				)}
				{select('vendor', 'vendorFilter', [
					{ value: '', label: t(prefix + 'allVendors') },
					...[
						...new Set(
							props.models.map((model) => routeModelVendor(model.vendor))
						),
					]
						.sort()
						.map((vendor) => ({
							value: vendor,
							label: routeModelVendorLabel(vendor),
						})),
				])}
				<Button
					type='button'
					variant='outline'
					className='self-end'
					onClick={props.onClear}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</div>
			<div
				className='flex flex-wrap gap-2'
				role='group'
				aria-label={t(prefix + 'overview')}
			>
				{(['byModel', 'overview'] as const).map((workspace) => (
					<Button
						key={workspace}
						size='sm'
						type='button'
						variant={
							props.filters.workspace === workspace ? 'default' : 'outline'
						}
						aria-pressed={props.filters.workspace === workspace}
						onClick={() => props.onChange({ workspace })}
					>
						{t(prefix + workspace)}
					</Button>
				))}
				{(['topology', 'summary'] as const).map((view) => (
					<Button
						key={view}
						size='sm'
						type='button'
						variant={props.filters.view === view ? 'default' : 'outline'}
						aria-pressed={props.filters.view === view}
						onClick={() => props.onChange({ view })}
					>
						{t(prefix + view)}
					</Button>
				))}
			</div>
		</div>
	)
}
