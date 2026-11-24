/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { UserAnalyticsView } from './user-analytics-view'

const prefix = 'cinatoken.adminUserAnalytics.'
export function UserAnalyticsControls(props: {
	view: UserAnalyticsView
	onView: (view: UserAnalyticsView) => void
	search: string
	onSearch: (search: string) => void
	count: number
	total: number
}) {
	const { t } = useTranslation()
	const id = useId()
	const views = [
		['overview', 'viewOverview'],
		['cost', 'viewCost'],
		['budget', 'viewBudget'],
		['all', 'viewAll'],
	] as const
	return (
		<section className='bg-card min-w-0 space-y-4 rounded-xl border p-4'>
			<div
				role='group'
				aria-label={t(prefix + 'viewLabel')}
				className='flex flex-wrap gap-2'
			>
				{views.map(([view, label]) => (
					<Button
						key={view}
						type='button'
						variant={props.view === view ? 'default' : 'outline'}
						aria-pressed={props.view === view}
						onClick={() => props.onView(view)}
					>
						{t(prefix + label)}
					</Button>
				))}
			</div>
			<div className='space-y-2'>
				<label htmlFor={id} className='text-sm font-medium'>
					{t(prefix + 'viewSearchUsers')}
				</label>
				<div className='flex min-w-0 flex-wrap gap-2'>
					<Input
						id={id}
						type='search'
						value={props.search}
						onChange={(event) => props.onSearch(event.target.value)}
						aria-describedby={`${id}-hint`}
						className='min-w-0 flex-1 basis-48 sm:max-w-md'
					/>
					<Button
						type='button'
						variant='outline'
						disabled={!props.search.length}
						onClick={() => props.onSearch('')}
					>
						{t(prefix + 'viewClearSearch')}
					</Button>
				</div>
				<p id={`${id}-hint`} className='text-muted-foreground text-xs'>
					{t(prefix + 'viewSearchUsersHint')}
				</p>
			</div>
			<p role='status' className='text-muted-foreground text-sm'>
				{t(prefix + 'viewMatching', {
					matched: props.count,
					total: props.total,
				})}
			</p>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'viewCsvHint')}
			</p>
		</section>
	)
}
