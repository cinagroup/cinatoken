/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { userAnalyticsPath } from './user-analytics-api'

const prefix = 'cinatoken.adminUserAnalytics.'

export function UserAnalyticsFilters(props: {
	email: string
	rangeParams: { startUtc: string; endUtc: string } | null
	onApply: (email: string) => void
}) {
	const { t } = useTranslation()
	const [draft, setDraft] = useState(props.email)
	const [invalid, setInvalid] = useState(false)
	function apply(next: string): void {
		if (!props.rangeParams) return
		try {
			userAnalyticsPath(
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
		<form
			className='bg-card space-y-3 rounded-xl border p-4 sm:p-5'
			aria-label={t(prefix + 'filters')}
			onSubmit={(event) => {
				event.preventDefault()
				apply(draft)
			}}
		>
			<label className='grid max-w-sm gap-1 text-sm font-medium'>
				{t(prefix + 'emailSearch')}
				<Input
					type='search'
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					maxLength={320}
					autoComplete='off'
				/>
			</label>
			<p className='text-muted-foreground text-xs'>
				{t(prefix + 'emailSearchHelp')}
			</p>
			<div className='flex flex-wrap gap-2'>
				<Button type='submit' size='sm' disabled={!props.rangeParams}>
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
		</form>
	)
}
