/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
	modelAnalyticsPath,
	type ModelAnalyticsFilters,
} from './model-analytics-api'

const prefix = 'cinatoken.adminModelAnalytics.'

export function ModelAnalyticsFilterControls(props: {
	filters: ModelAnalyticsFilters
	tags: string[]
	rangeParams: { startUtc: string; endUtc: string } | null
	onApply: (filters: ModelAnalyticsFilters) => void
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState(props.filters)
	const [invalid, setInvalid] = useState(false)
	function apply(next: ModelAnalyticsFilters): void {
		if (!props.rangeParams) return
		try {
			modelAnalyticsPath(
				props.rangeParams.startUtc,
				props.rangeParams.endUtc,
				next
			)
			setInvalid(false)
			props.onApply(next)
		} catch {
			setInvalid(true)
		}
	}
	return (
		<section
			className='bg-card space-y-3 rounded-xl border p-4 sm:p-5'
			aria-label={t(prefix + 'filters')}
		>
			<div className='grid gap-3 sm:max-w-sm'>
				<label className='grid gap-1 text-sm font-medium'>
					{t(prefix + 'tag')}
					<select
						className='border-input bg-background h-9 min-w-0 rounded-md border px-3 text-sm'
						value={draft.tag}
						onChange={(event) =>
							setDraft({ ...draft, tag: event.target.value })
						}
					>
						<option value=''>{t(prefix + 'allTags')}</option>
						{props.tags.map((tag) => (
							<option key={tag} value={tag}>
								{tag}
							</option>
						))}
					</select>
				</label>
			</div>
			<div className='flex flex-wrap gap-2'>
				<Button
					type='button'
					size='sm'
					onClick={() => apply(draft)}
					disabled={!props.rangeParams}
				>
					{t(prefix + 'applyFilters')}
				</Button>
				<Button
					type='button'
					size='sm'
					variant='outline'
					onClick={() => {
						const empty = { tag: '', providerId: '', userEmail: '' }
						setDraft(empty)
						apply(empty)
					}}
					disabled={!props.rangeParams}
				>
					{t(prefix + 'clearFilters')}
				</Button>
			</div>
			{invalid && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'invalidFilter')}
				</p>
			)}
		</section>
	)
}
