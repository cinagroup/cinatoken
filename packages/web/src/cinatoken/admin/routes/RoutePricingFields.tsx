/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'
import { Input } from '../../../components/ui/input'
import type { RouteDraft, ScheduleDraft } from './route-domain'

const prefix = 'cinatoken.adminRoutes.'
const days = [1, 2, 3, 4, 5, 6, 7] as const

export function RoutePricingFields(props: {
	draft: RouteDraft
	onChange: (draft: RouteDraft) => void
	currency: string | null
	timezone: string | null
	disabled: boolean
}) {
	const { t } = useTranslation()
	function patchWindow(index: number, patch: Partial<ScheduleDraft>): void {
		const schedule = props.draft.schedule.map((row, at) =>
			at === index ? { ...row, ...patch } : row
		)
		props.onChange({ ...props.draft, schedule })
	}
	const unavailable = !props.currency || !props.timezone
	return (
		<section className='space-y-4 rounded-xl border p-4'>
			<div className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h3 className='font-medium'>{t(prefix + 'pricing')}</h3>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'scheduleHint')}
					</p>
				</div>
				<p className='text-muted-foreground text-xs'>
					{props.currency ?? t(prefix + 'unknown')} ·{' '}
					{props.timezone ?? t(prefix + 'unknown')}
				</p>
			</div>
			{unavailable && (
				<p role='alert' className='text-destructive text-sm'>
					{t(prefix + 'contextUnknown')}
				</p>
			)}
			<div className='grid gap-3 sm:grid-cols-2'>
				<label className='space-y-1 text-sm'>
					{t(prefix + 'chargedFactor')}
					<Input
						type='number'
						min='0'
						step='any'
						value={props.draft.chargedFactor}
						disabled={props.disabled || unavailable}
						onChange={(event) =>
							props.onChange({
								...props.draft,
								chargedFactor: event.target.value,
							})
						}
					/>
				</label>
				<label className='space-y-1 text-sm'>
					{t(prefix + 'meteredFactor')}
					<Input
						type='number'
						min='0'
						step='any'
						value={props.draft.meteredFactor}
						disabled={props.disabled || unavailable}
						onChange={(event) =>
							props.onChange({
								...props.draft,
								meteredFactor: event.target.value,
							})
						}
					/>
				</label>
			</div>
			<div className='flex flex-wrap items-center justify-between gap-2'>
				<h4 className='text-sm font-medium'>{t(prefix + 'schedule')}</h4>
				<Button
					type='button'
					size='sm'
					variant='outline'
					disabled={props.disabled || unavailable}
					onClick={() =>
						props.onChange({
							...props.draft,
							schedule: [
								...props.draft.schedule,
								{
									start: '09:00',
									end: '17:00',
									days: [],
									chargedFactor: '1',
									meteredFactor: '1',
								},
							],
						})
					}
				>
					{t(prefix + 'addWindow')}
				</Button>
			</div>
			{props.draft.schedule.map((row, index) => (
				<div key={index} className='space-y-3 rounded-lg border p-3'>
					<div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
						<label className='space-y-1 text-xs'>
							{t(prefix + 'start')}
							<Input
								value={row.start}
								placeholder='HH:mm'
								disabled={props.disabled || unavailable}
								onChange={(event) =>
									patchWindow(index, { start: event.target.value })
								}
							/>
						</label>
						<label className='space-y-1 text-xs'>
							{t(prefix + 'end')}
							<Input
								value={row.end}
								placeholder='HH:mm'
								disabled={props.disabled || unavailable}
								onChange={(event) =>
									patchWindow(index, { end: event.target.value })
								}
							/>
						</label>
						<label className='space-y-1 text-xs'>
							{t(prefix + 'chargedFactor')}
							<Input
								type='number'
								min='0'
								step='any'
								value={row.chargedFactor}
								disabled={props.disabled || unavailable}
								onChange={(event) =>
									patchWindow(index, { chargedFactor: event.target.value })
								}
							/>
						</label>
						<label className='space-y-1 text-xs'>
							{t(prefix + 'meteredFactor')}
							<Input
								type='number'
								min='0'
								step='any'
								value={row.meteredFactor}
								disabled={props.disabled || unavailable}
								onChange={(event) =>
									patchWindow(index, { meteredFactor: event.target.value })
								}
							/>
						</label>
					</div>
					<p className='text-muted-foreground text-xs'>
						{t(prefix + 'weekdays')}
					</p>
					<div className='flex flex-wrap gap-2'>
						{days.map((day) => (
							<label
								key={day}
								className='flex items-center gap-1 rounded-md border px-2 py-1 text-xs'
							>
								<input
									type='checkbox'
									checked={row.days.includes(day)}
									disabled={props.disabled || unavailable}
									onChange={(event) =>
										patchWindow(index, {
											days: event.target.checked
												? [...row.days, day].sort()
												: row.days.filter((value) => value !== day),
										})
									}
								/>
								{t(prefix + `day${day}`)}
							</label>
						))}
					</div>
					<Button
						type='button'
						size='sm'
						variant='outline'
						disabled={props.disabled || unavailable}
						onClick={() =>
							props.onChange({
								...props.draft,
								schedule: props.draft.schedule.filter((_, at) => at !== index),
							})
						}
					>
						{t(prefix + 'removeWindow')}
					</Button>
				</div>
			))}
		</section>
	)
}
