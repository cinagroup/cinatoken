/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
	parseReliabilityCustomRange,
	utcToZonedLocal,
	type ReliabilityRange,
} from './reliability-range'

const prefix = 'cinatoken.adminReliability.'
const rolling = ['1h', '1d', '7d', '14d', '30d'] as const
const calendar = ['today', 'this_week', 'this_month'] as const

export function ReliabilityRangeControls(props: {
	range: ReliabilityRange
	rangeParams: { startUtc: string; endUtc: string } | null
	timezone: string | null
	onChange: (range: ReliabilityRange) => void
}) {
	const { t } = useTranslation()
	const [startLocal, setStartLocal] = useState(
		() =>
			utcToZonedLocal(props.rangeParams?.startUtc ?? '', props.timezone) ?? ''
	)
	const [endLocal, setEndLocal] = useState(
		() => utcToZonedLocal(props.rangeParams?.endUtc ?? '', props.timezone) ?? ''
	)
	const [invalid, setInvalid] = useState(false)

	function select(range: ReliabilityRange): void {
		setInvalid(false)
		props.onChange(range)
	}

	function applyCustom(): void {
		if (!props.timezone) return
		const parsed = parseReliabilityCustomRange(
			startLocal,
			endLocal,
			props.timezone
		)
		if (!parsed) {
			setInvalid(true)
			return
		}
		select(parsed)
	}

	return (
		<section
			className='bg-card space-y-4 rounded-xl border p-4 sm:p-5'
			aria-label={t(prefix + 'range')}
		>
			<div className='space-y-2'>
				<p className='text-sm font-medium'>{t(prefix + 'rollingRange')}</p>
				<div
					className='flex flex-wrap gap-2'
					role='group'
					aria-label={t(prefix + 'rollingRange')}
				>
					{rolling.map((preset) => (
						<Button
							key={preset}
							type='button'
							size='sm'
							variant={
								props.range.kind === 'rolling' && props.range.preset === preset
									? 'default'
									: 'outline'
							}
							aria-pressed={
								props.range.kind === 'rolling' && props.range.preset === preset
							}
							onClick={() => select({ kind: 'rolling', preset })}
						>
							{t(prefix + `range_${preset}`)}
						</Button>
					))}
				</div>
			</div>
			<div className='space-y-2'>
				<p className='text-sm font-medium'>{t(prefix + 'calendarRange')}</p>
				<div
					className='flex flex-wrap gap-2'
					role='group'
					aria-label={t(prefix + 'calendarRange')}
				>
					{calendar.map((preset) => (
						<Button
							key={preset}
							type='button'
							size='sm'
							variant={
								props.range.kind === 'calendar' && props.range.preset === preset
									? 'default'
									: 'outline'
							}
							aria-pressed={
								props.range.kind === 'calendar' && props.range.preset === preset
							}
							disabled={!props.timezone}
							onClick={() => select({ kind: 'calendar', preset })}
						>
							{t(prefix + `range_${preset}`)}
						</Button>
					))}
				</div>
			</div>
			<fieldset className='space-y-3' disabled={!props.timezone}>
				<legend className='text-sm font-medium'>
					{t(prefix + 'customRange')}
				</legend>
				<div className='flex flex-wrap items-end gap-3'>
					<label className='grid gap-1 text-xs font-medium'>
						{t(prefix + 'startTime')}
						<Input
							type='datetime-local'
							value={startLocal}
							onChange={(event) => setStartLocal(event.target.value)}
							className='w-52 dark:[color-scheme:dark]'
						/>
					</label>
					<label className='grid gap-1 text-xs font-medium'>
						{t(prefix + 'endTime')}
						<Input
							type='datetime-local'
							value={endLocal}
							onChange={(event) => setEndLocal(event.target.value)}
							className='w-52 dark:[color-scheme:dark]'
						/>
					</label>
					<Button type='button' variant='outline' onClick={applyCustom}>
						{t(prefix + 'applyRange')}
					</Button>
				</div>
			</fieldset>
			{invalid && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'invalidRange')}
				</p>
			)}
			{props.rangeParams && (
				<p className='text-muted-foreground text-xs break-all'>
					{t(prefix + 'utcRange', props.rangeParams)}
				</p>
			)}
		</section>
	)
}
