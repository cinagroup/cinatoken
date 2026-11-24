/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { AnalyticsView } from './analytics-view'

const prefix = 'cinatoken.adminModelAnalytics.'

export function AnalyticsViewControls(props: {
	view: AnalyticsView
	onView: (view: AnalyticsView) => void
	search: string
	onSearch: (search: string) => void
	count: number
	total: number
	scope: 'models' | 'providers'
}) {
	const { t } = useTranslation()
	const id = useId()
	const views = [
		{
			value: 'overview',
			label: t('cinatoken.adminModelAnalytics.viewOverview'),
		},
		{ value: 'cost', label: t('cinatoken.adminModelAnalytics.viewCost') },
		{
			value: 'performance',
			label: t('cinatoken.adminModelAnalytics.viewPerformance'),
		},
		{ value: 'all', label: t('cinatoken.adminModelAnalytics.viewAll') },
	] as const
	return (
		<div className='bg-card min-w-0 space-y-4 rounded-xl border p-4'>
			<div className='space-y-2'>
				<p id={`${id}-view`} className='text-sm font-medium'>
					{t(prefix + 'viewLabel')}
				</p>
				<div
					role='group'
					aria-labelledby={`${id}-view`}
					className='flex flex-wrap gap-2'
				>
					{views.map((view) => (
						<Button
							key={view.value}
							type='button'
							variant={props.view === view.value ? 'default' : 'outline'}
							aria-pressed={props.view === view.value}
							onClick={() => props.onView(view.value)}
						>
							{view.label}
						</Button>
					))}
				</div>
			</div>
			<div className='space-y-2'>
				<label htmlFor={`${id}-search`} className='text-sm font-medium'>
					{props.scope === 'models'
						? t('cinatoken.adminModelAnalytics.viewSearchModels')
						: t('cinatoken.adminModelAnalytics.viewSearchProviders')}
				</label>
				<div className='flex min-w-0 flex-wrap gap-2'>
					<Input
						id={`${id}-search`}
						type='search'
						className='min-w-0 flex-1 basis-48 sm:max-w-md'
						value={props.search}
						aria-describedby={`${id}-search-hint`}
						onChange={(event) => props.onSearch(event.target.value)}
					/>
					<Button
						type='button'
						variant='outline'
						disabled={props.search.length === 0}
						onClick={() => props.onSearch('')}
					>
						{t(prefix + 'viewClearSearch')}
					</Button>
				</div>
				<p id={`${id}-search-hint`} className='text-muted-foreground text-xs'>
					{t(prefix + 'viewSearchHint')}
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
		</div>
	)
}
