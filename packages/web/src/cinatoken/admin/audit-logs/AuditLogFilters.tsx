/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ReliabilityRangeControls } from '../reliability/ReliabilityRangeControls'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'
import {
	auditActorKinds,
	auditActorTypes,
	auditEventTypes,
	auditSources,
	defaultAuditEvents,
	type AuditLogSearch,
} from './audit-log-domain'

const prefix = 'cinatoken.adminAuditLogs.'
type MultiKey =
	'event_type' | 'actor_type' | 'actor_kind' | 'reason_code' | 'source'
function rangeFor(
	search: AuditLogSearch,
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
function MultiChoice(props: {
	label: string
	options: readonly string[]
	selected: string[]
	onChange: (values: string[]) => void
	defaultValues?: readonly string[]
	labelValue?: (value: string) => string
}) {
	const { t } = useTranslation()
	const options = [...new Set([...props.options, ...props.selected])]
	function toggle(value: string, checked: boolean): void {
		if (props.selected.length === 0) {
			props.onChange(
				checked ? [value] : options.filter((option) => option !== value)
			)
			return
		}
		props.onChange(
			checked
				? [...props.selected, value]
				: props.selected.filter((part) => part !== value)
		)
	}
	return (
		<fieldset className='min-w-0 space-y-2'>
			<legend className='text-sm font-medium'>{props.label}</legend>
			<div className='flex flex-wrap items-center gap-2 text-xs'>
				<Button
					type='button'
					size='sm'
					variant={props.selected.length === 0 ? 'default' : 'outline'}
					onClick={() => props.onChange([])}
				>
					{t(prefix + 'all')}
				</Button>
				{props.defaultValues && (
					<Button
						type='button'
						size='sm'
						variant='outline'
						onClick={() => props.onChange([...props.defaultValues!])}
					>
						{t(prefix + 'filters.defaultEventTypes')}
					</Button>
				)}
				<span className='text-muted-foreground'>
					{props.selected.length === 0
						? t(prefix + 'all')
						: t(prefix + 'selected', { count: props.selected.length })}
				</span>
			</div>
			<div className='bg-muted/30 flex max-h-28 min-h-10 flex-wrap gap-2 overflow-y-auto rounded-md border p-2'>
				{options.length ? (
					options.map((option) => (
						<label
							key={option}
							className='bg-background inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1 text-xs'
						>
							<input
								type='checkbox'
								checked={
									props.selected.length === 0 || props.selected.includes(option)
								}
								onChange={(event) => toggle(option, event.target.checked)}
							/>
							<span className='font-mono break-all'>
								{props.labelValue?.(option) ?? option}
							</span>
						</label>
					))
				) : (
					<span className='text-muted-foreground text-xs'>
						{t(prefix + 'filters.noReasonCodes')}
					</span>
				)}
			</div>
		</fieldset>
	)
}
export function AuditLogFilters(props: {
	search: AuditLogSearch
	effectiveSearch: AuditLogSearch | null
	timezone: string | null
	reasonCodes: string[]
	onSearch: (next: AuditLogSearch) => void
}) {
	const { t } = useTranslation()
	const range = rangeFor(props.search, props.timezone)
	const effective = props.effectiveSearch
	const rangeParams =
		effective?.start_date && effective.end_date
			? { startUtc: effective.start_date, endUtc: effective.end_date }
			: null
	function updateText(
		key:
			'actor_id' | 'user_email' | 'correlation_id' | 'user_id' | 'api_key_id',
		value: string
	): void {
		props.onSearch({ ...props.search, [key]: value, page: 1 })
	}
	function updateMulti(key: MultiKey, values: string[]): void {
		props.onSearch({ ...props.search, [key]: values, page: 1 })
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
	const textFilters = [
		['actor_id', 'actorId', 'actorIdPlaceholder'],
		['user_email', 'userEmail', 'exactMatch'],
		['correlation_id', 'correlationId', 'correlationPlaceholder'],
		['user_id', 'userId', 'userIdPlaceholder'],
		['api_key_id', 'apiKeyId', 'apiKeyPlaceholder'],
	] as const
	return (
		<section aria-label={t(prefix + 'filtersTitle')} className='space-y-4'>
			<ReliabilityRangeControls
				key={JSON.stringify([
					props.timezone,
					props.search.start_date,
					props.search.end_date,
				])}
				range={range}
				rangeParams={rangeParams}
				timezone={props.timezone}
				onChange={selectRange}
			/>
			<div className='flex flex-wrap items-center gap-3 text-xs'>
				<Button
					type='button'
					variant='outline'
					size='sm'
					onClick={() =>
						props.onSearch({
							...props.search,
							start_date: '',
							end_date: '',
							page: 1,
						})
					}
				>
					{t(prefix + 'all')} · {t(prefix + 'table.time')}
				</Button>
				<span className='text-muted-foreground break-all'>
					{effective?.start_date || '—'} → {effective?.end_date || '—'} UTC
				</span>
			</div>
			<div className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'>
				<MultiChoice
					label={t(prefix + 'filters.eventType')}
					options={auditEventTypes}
					selected={props.search.event_type}
					onChange={(values) => updateMulti('event_type', values)}
					defaultValues={defaultAuditEvents}
				/>
				<MultiChoice
					label={t(prefix + 'filters.source')}
					options={auditSources}
					selected={props.search.source}
					onChange={(values) => updateMulti('source', values)}
				/>
				<MultiChoice
					label={t(prefix + 'filters.reasonCode')}
					options={props.reasonCodes}
					selected={props.search.reason_code}
					onChange={(values) => updateMulti('reason_code', values)}
				/>
				<div className='grid gap-4 lg:grid-cols-2'>
					<MultiChoice
						label={t(prefix + 'filters.actor')}
						options={auditActorTypes}
						selected={props.search.actor_type}
						onChange={(values) => updateMulti('actor_type', values)}
					/>
					<MultiChoice
						label={t(prefix + 'filters.actorKind')}
						options={auditActorKinds}
						selected={props.search.actor_kind}
						onChange={(values) => updateMulti('actor_kind', values)}
						labelValue={(kind) =>
							t(prefix + `actorKinds.${kind}`, { defaultValue: kind })
						}
					/>
				</div>
				<div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-3'>
					{textFilters.map(([key, label, placeholder]) => (
						<label key={key} className='grid min-w-0 gap-1 text-sm'>
							{t(prefix + `filters.${label}`)}
							<Input
								value={props.search[key]}
								onChange={(event) => updateText(key, event.target.value)}
								placeholder={t(prefix + `filters.${placeholder}`)}
								className={key === 'user_email' ? '' : 'font-mono text-xs'}
							/>
						</label>
					))}
				</div>
				<Button
					type='button'
					variant='outline'
					onClick={() =>
						props.onSearch({
							page: 1,
							user_id: '',
							api_key_id: '',
							user_email: '',
							event_type: [],
							actor_type: [],
							actor_kind: [],
							actor_id: '',
							reason_code: [],
							source: [],
							correlation_id: '',
							start_date: '',
							end_date: '',
						})
					}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</div>
		</section>
	)
}
