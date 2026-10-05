/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { providerAnalyticsPath } from './provider-analytics-api'

const prefix = 'cinatoken.adminProviderAnalytics.'

export function ProviderAnalyticsFilters(props: {
	tag: string
	tags: string[]
	rangeParams: { startUtc: string; endUtc: string } | null
	onApply: (tag: string) => void
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState(props.tag)
	const [invalid, setInvalid] = useState(false)
	function apply(next: string): void {
		if (!props.rangeParams) return
		try {
			providerAnalyticsPath(
				props.rangeParams.startUtc,
				props.rangeParams.endUtc,
				next
			)
			setInvalid(false)
			props.onApply(next.trim())
		} catch {
			setInvalid(true)
		}
	}
	return (
		<section
			className='bg-card space-y-3 rounded-xl border p-4 sm:p-5'
			aria-label={t(prefix + 'filters')}
		>
			<label className='grid max-w-sm gap-1 text-sm font-medium'>
				{t(prefix + 'tag')}
				<select
					className='border-input bg-background h-9 min-w-0 rounded-md border px-3 text-sm'
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
				>
					<option value=''>{t(prefix + 'allTags')}</option>
					{props.tags.map((tag) => (
						<option key={tag} value={tag}>
							{tag}
						</option>
					))}
				</select>
			</label>
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
						setDraft('')
						apply('')
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
