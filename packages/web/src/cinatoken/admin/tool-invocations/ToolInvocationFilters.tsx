/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ReliabilityRangeControls } from '../reliability/ReliabilityRangeControls'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'
import { tools, type ToolInvocationSearch } from './tool-invocation-domain'

const prefix = 'cinatoken.adminToolInvocations.'
function rangeFor(search: ToolInvocationSearch): ReliabilityRange {
	if (search.start_date === undefined && search.end_date === undefined)
		return { kind: 'calendar', preset: 'today' }
	return {
		kind: 'custom',
		startUtc: search.start_date ?? '',
		endUtc: search.end_date ?? '',
	}
}
export function ToolInvocationFilters(props: {
	search: ToolInvocationSearch
	effectiveSearch: ToolInvocationSearch | null
	timezone: string | null
	onSearch: (search: ToolInvocationSearch) => void
}) {
	const { t } = useTranslation()
	const range = rangeFor(props.search)
	const effective = props.effectiveSearch
	const rangeParams =
		effective && (effective.start_date || effective.end_date)
			? {
					startUtc: effective.start_date ?? '',
					endUtc: effective.end_date ?? '',
				}
			: null
	function selectRange(next: ReliabilityRange): void {
		const resolved = resolveReliabilityRange(
			next,
			props.timezone ?? 'UTC',
			new Date()
		)
		if (resolved)
			props.onSearch({
				...props.search,
				start_date: resolved.startUtc,
				end_date: resolved.endUtc,
				page: 1,
			})
	}
	return (
		<section aria-label={t(prefix + 'invocations.title')} className='space-y-4'>
			<ReliabilityRangeControls
				key={JSON.stringify([
					props.timezone,
					effective?.start_date,
					effective?.end_date,
				])}
				range={range}
				rangeParams={rangeParams}
				timezone={props.timezone ?? 'UTC'}
				onChange={selectRange}
			/>
			<div className='flex flex-wrap items-center gap-2 text-xs'>
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
					{t(prefix + 'allTime')}
				</Button>
				<span className='text-muted-foreground break-all'>
					{effective?.start_date || '—'} → {effective?.end_date || '—'} UTC
				</span>
			</div>
			<div className='bg-card flex flex-wrap items-end gap-4 rounded-xl border p-4'>
				<label className='grid min-w-52 gap-1 text-sm'>
					{t(prefix + 'invocations.toolFilter')}
					<select
						className='bg-background h-9 rounded-md border px-2'
						value={props.search.tool}
						onChange={(event) =>
							props.onSearch({
								...props.search,
								tool: event.target.value as ToolInvocationSearch['tool'],
								page: 1,
							})
						}
					>
						<option value=''>{t(prefix + 'invocations.allTools')}</option>
						{tools.map((tool) => (
							<option key={tool.id} value={tool.id}>
								{t(prefix + `catalog.${tool.label}`)}
							</option>
						))}
					</select>
				</label>
				<label className='grid min-w-40 gap-1 text-sm'>
					{t(prefix + 'invocations.status')}
					<select
						className='bg-background h-9 rounded-md border px-2'
						value={props.search.status}
						onChange={(event) =>
							props.onSearch({
								...props.search,
								status: event.target.value as ToolInvocationSearch['status'],
								page: 1,
							})
						}
					>
						<option value=''>{t(prefix + 'all')}</option>
						<option value='success'>success</option>
						<option value='error'>error</option>
					</select>
				</label>
			</div>
		</section>
	)
}
