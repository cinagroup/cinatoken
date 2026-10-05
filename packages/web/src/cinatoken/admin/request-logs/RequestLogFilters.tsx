/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ReliabilityRangeControls } from '../reliability/ReliabilityRangeControls'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'
import type {
	LogModelCatalog,
	LogProviderCatalog,
	LogRouteCatalog,
} from './request-log-contracts'
import {
	emptyRequestLogFilters,
	normalizeRouteGroup,
	type RequestLogSearch,
} from './request-log-domain'

const prefix = 'cinatoken.adminRequestLogs.'
const protocols = ['openai', 'anthropic', 'gemini', 'dashscope'] as const
const statuses = ['success', 'error', 'incomplete', 'cancelled'] as const
function rangeFor(
	search: RequestLogSearch,
	timezone: string | null
): ReliabilityRange {
	if (search.start_date === undefined && search.end_date === undefined)
		return timezone
			? { kind: 'calendar', preset: 'today' }
			: { kind: 'rolling', preset: '1d' }
	return {
		kind: 'custom',
		startUtc: search.start_date ?? '',
		endUtc: search.end_date ?? '',
	}
}
export function RequestLogFilters(props: {
	search: RequestLogSearch
	effectiveSearch: RequestLogSearch | null
	timezone: string | null
	models: LogModelCatalog | null
	providers: LogProviderCatalog | null
	routes: LogRouteCatalog | null
	catalogSettled: boolean
	onSearch: (next: RequestLogSearch) => void
}) {
	const { t } = useTranslation()
	const range = rangeFor(props.search, props.timezone)
	const currentRange =
		props.effectiveSearch?.start_date && props.effectiveSearch.end_date
			? {
					startUtc: props.effectiveSearch.start_date,
					endUtc: props.effectiveSearch.end_date,
				}
			: null
	function update(key: keyof RequestLogSearch, value: string): void {
		props.onSearch({ ...props.search, [key]: value, page: 1 })
	}
	function selectRange(next: ReliabilityRange): void {
		const resolved = resolveReliabilityRange(next, props.timezone, new Date())
		if (resolved)
			props.onSearch({
				...props.search,
				start_date: resolved.startUtc,
				end_date: resolved.endUtc,
				page: 1,
			})
	}
	const groups = [
		...new Set(
			(props.routes ?? []).map((route) =>
				normalizeRouteGroup(route.route_group)
			)
		),
	].sort()
	return (
		<section aria-label={t(prefix + 'filtersTitle')} className='space-y-4'>
			<ReliabilityRangeControls
				key={JSON.stringify([
					props.timezone,
					props.search.start_date,
					props.search.end_date,
				])}
				range={range}
				rangeParams={currentRange}
				timezone={props.timezone}
				onChange={selectRange}
			/>
			{(props.search.start_date || props.search.end_date) && (
				<p className='text-muted-foreground text-xs break-all'>
					{t(prefix + 'timeRange')}: {props.search.start_date || '—'} →{' '}
					{props.search.end_date || '—'} UTC
				</p>
			)}
			<div className='bg-card grid gap-3 rounded-xl border p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'requestStatus')}
					<select
						className='bg-background h-9 rounded-md border px-2'
						value={props.search.status}
						onChange={(event) => update('status', event.target.value)}
					>
						<option value=''>{t(prefix + 'all')}</option>
						{statuses.map((status) => (
							<option key={status} value={status}>
								{t(prefix + `status.${status}`)}
							</option>
						))}
						{props.search.status &&
							!statuses.includes(
								props.search.status as (typeof statuses)[number]
							) && (
								<option value={props.search.status}>
									{props.search.status}
								</option>
							)}
					</select>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'filters.protocol')}
					<select
						className='bg-background h-9 rounded-md border px-2'
						value={props.search.protocol}
						onChange={(event) => update('protocol', event.target.value)}
					>
						<option value=''>{t(prefix + 'all')}</option>
						{protocols.map((protocol) => (
							<option key={protocol} value={protocol}>
								{protocol}
							</option>
						))}
						{props.search.protocol &&
							!protocols.includes(
								props.search.protocol as (typeof protocols)[number]
							) && (
								<option value={props.search.protocol}>
									{props.search.protocol}
								</option>
							)}
					</select>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'modelId')}
					<Input
						list='request-log-models'
						maxLength={600}
						value={props.search.model_id}
						onChange={(event) => update('model_id', event.target.value)}
						placeholder={t(prefix + 'exactId')}
					/>
					<datalist id='request-log-models'>
						{props.models?.map((model) => (
							<option
								key={model.id}
								value={model.id}
								label={model.display_name || model.id}
							/>
						))}
					</datalist>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'providerId')}
					<Input
						list='request-log-providers'
						maxLength={600}
						value={props.search.provider_id}
						onChange={(event) => update('provider_id', event.target.value)}
						placeholder={t(prefix + 'exactId')}
					/>
					<datalist id='request-log-providers'>
						{props.providers?.map((provider) => (
							<option
								key={provider.id}
								value={provider.id}
								label={provider.name}
							/>
						))}
					</datalist>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'routeGroup')}
					<Input
						list='request-log-groups'
						maxLength={600}
						value={props.search.route_group}
						onChange={(event) => update('route_group', event.target.value)}
						placeholder={t(prefix + 'exactId')}
					/>
					<datalist id='request-log-groups'>
						{groups.map((group) => (
							<option key={group} value={group} />
						))}
					</datalist>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'filters.userId')}
					<Input
						maxLength={600}
						value={props.search.user_id}
						onChange={(event) => update('user_id', event.target.value)}
						placeholder={t(prefix + 'exactId')}
						autoComplete='off'
					/>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'filters.userEmail')}
					<Input
						maxLength={320}
						value={props.search.user_email}
						onChange={(event) => update('user_email', event.target.value)}
						placeholder={t(prefix + 'filters.emailPlaceholder')}
						autoComplete='off'
					/>
				</label>
				<label className='grid gap-1 text-sm'>
					{t(prefix + 'filters.apiKeyId')}
					<Input
						maxLength={600}
						value={props.search.api_key_id}
						onChange={(event) => update('api_key_id', event.target.value)}
						placeholder={t(prefix + 'filters.apiKeyPlaceholder')}
						autoComplete='off'
					/>
				</label>
				<div className='flex flex-wrap items-end gap-2'>
					<Button
						type='button'
						variant='outline'
						onClick={() => props.onSearch(emptyRequestLogFilters)}
					>
						{t(prefix + 'clearFilters')}
					</Button>
					<Button
						type='button'
						variant='ghost'
						onClick={() =>
							props.onSearch({
								...props.search,
								start_date: '',
								end_date: '',
								page: 1,
							})
						}
					>
						{t(prefix + 'resetRange')}
					</Button>
				</div>
			</div>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'searchHint')}
			</p>
			{props.catalogSettled &&
				(!props.models || !props.providers || !props.routes) && (
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'catalogUnavailable')}
					</p>
				)}
		</section>
	)
}
