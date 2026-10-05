/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	defaultDashboardCustomInputs,
	parseDashboardCustomRange,
	type DashboardPreset,
	type DashboardRange,
} from './dashboard-range'

const prefix = 'cinatoken.adminDashboard.'
const presets: DashboardPreset[] = ['1h', '1d', '7d', '14d', '30d']

export function DashboardRangeControls(props: {
	range: DashboardRange
	onChange: (range: DashboardRange) => void
}) {
	const { t } = useTranslation()
	const [custom, setCustom] = useState(defaultDashboardCustomInputs)
	const [rangeError, setRangeError] = useState(false)
	const rangeLabel =
		props.range.kind === 'preset'
			? t(prefix + `range${props.range.value}`)
			: t(prefix + 'customRange', {
					start: props.range.startUtc,
					end: props.range.endUtc,
				})

	function applyCustom(): void {
		const parsed = parseDashboardCustomRange(custom.startUtc, custom.endUtc)
		if (!parsed) {
			setRangeError(true)
			return
		}
		setRangeError(false)
		props.onChange(parsed)
	}

	return (
		<section
			className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
			aria-label={t(prefix + 'range')}
		>
			<div
				className='flex flex-wrap gap-2'
				role='group'
				aria-label={t(prefix + 'range')}
			>
				{presets.map((preset) => (
					<Button
						key={preset}
						type='button'
						size='sm'
						variant={
							props.range.kind === 'preset' && props.range.value === preset
								? 'default'
								: 'outline'
						}
						aria-pressed={
							props.range.kind === 'preset' && props.range.value === preset
						}
						onClick={() => {
							props.onChange({ kind: 'preset', value: preset })
							setRangeError(false)
						}}
					>
						{t(prefix + `range${preset}`)}
					</Button>
				))}
			</div>
			<fieldset className='space-y-3'>
				<legend className='text-sm font-medium'>
					{t(prefix + 'customTitle')}
				</legend>
				<div className='flex flex-wrap items-end gap-3'>
					<label className='min-w-48 flex-1 text-sm'>
						{t(prefix + 'startUtc')}
						<Input
							className='mt-1 dark:[color-scheme:dark]'
							type='datetime-local'
							step={60}
							value={custom.startUtc}
							onChange={(event) =>
								setCustom((previous) => ({
									...previous,
									startUtc: event.target.value,
								}))
							}
						/>
					</label>
					<label className='min-w-48 flex-1 text-sm'>
						{t(prefix + 'endUtc')}
						<Input
							className='mt-1 dark:[color-scheme:dark]'
							type='datetime-local'
							step={60}
							value={custom.endUtc}
							onChange={(event) =>
								setCustom((previous) => ({
									...previous,
									endUtc: event.target.value,
								}))
							}
						/>
					</label>
					<Button type='button' variant='secondary' onClick={applyCustom}>
						{t(prefix + 'applyRange')}
					</Button>
				</div>
				{rangeError ? (
					<p role='alert' className='text-destructive text-sm'>
						{t(prefix + 'invalidRange')}
					</p>
				) : null}
			</fieldset>
			<p className='text-muted-foreground text-xs' aria-live='polite'>
				{t(prefix + 'activeRange', { range: rangeLabel })}
			</p>
		</section>
	)
}
