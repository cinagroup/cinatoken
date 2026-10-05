/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { ReliabilityRangeControls } from './ReliabilityRangeControls'
import { ReliabilityRecentErrors } from './ReliabilityRecentErrors'
import { ReliabilityTables } from './ReliabilityTables'
import {
	useAdminReliability,
	type AdminReliabilityProps,
} from './use-admin-reliability'

const prefix = 'cinatoken.adminReliability.'

function analyticsErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.status === 401 || error.status === 403) return 'accessDenied'
		if (error.code === 'invalid-response') return 'invalidResponse'
	}
	return 'readFailed'
}

export function AdminReliability(props: AdminReliabilityProps) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const state = useAdminReliability(props)
	const timezone = state.display?.timezone ?? null
	const currency = state.display?.currency ?? null
	const configFailed = state.displayBlocked || Boolean(state.displayQuery.error)
	const configDenied =
		state.displayBlocked ||
		(state.displayQuery.error instanceof CinaTokenApiError &&
			(state.displayQuery.error.status === 401 ||
				state.displayQuery.error.status === 403))
	const analyticsFailed =
		state.analyticsBlocked || Boolean(state.analyticsQuery.error)
	const loading = !analyticsFailed && !state.snapshot
	const showTimezoneFallback =
		state.display && state.display.timezoneSource !== 'configured'

	return (
		<main className='min-w-0 space-y-6 pb-12'>
			<header className='flex flex-wrap items-start justify-between gap-4'>
				<div>
					<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<Button
					type='button'
					variant='outline'
					onClick={state.retry}
					disabled={
						state.analyticsQuery.isFetching || state.displayQuery.isFetching
					}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<ReliabilityRangeControls
				key={`${state.rangeParams?.startUtc ?? ''}:${state.rangeParams?.endUtc ?? ''}:${timezone ?? ''}`}
				range={state.range}
				rangeParams={state.rangeParams}
				timezone={timezone}
				onChange={state.selectRange}
			/>
			<div className='flex flex-wrap gap-x-5 gap-y-1 text-xs'>
				{state.display && (
					<span className='text-muted-foreground'>
						{t(
							prefix + (showTimezoneFallback ? 'timezoneFallback' : 'timezone'),
							{ timezone: state.display.timezone }
						)}
					</span>
				)}
				{currency && (
					<span className='text-muted-foreground'>
						{t(
							prefix +
								(state.display?.currencySource === 'missing'
									? 'currencyFallback'
									: 'currency'),
							{ currency }
						)}
					</span>
				)}
			</div>
			{configFailed && (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					<p>
						{t(
							prefix +
								(configDenied ? 'displayAccessDenied' : 'displayReadFailed')
						)}
					</p>
					{!timezone && (
						<p className='mt-2'>{t(prefix + 'timezoneUnavailable')}</p>
					)}
				</section>
			)}
			{state.display && !currency && (
				<p
					role='alert'
					className='rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm'
				>
					{t(prefix + 'currencyUnavailable')}
				</p>
			)}
			{analyticsFailed ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5'
				>
					<p>
						{t(
							prefix +
								(state.analyticsBlocked
									? 'accessDenied'
									: analyticsErrorKey(state.analyticsQuery.error))
						)}
					</p>
					<Button
						className='mt-4'
						type='button'
						variant='outline'
						onClick={state.retry}
					>
						{t(prefix + 'retry')}
					</Button>
				</section>
			) : loading ? (
				<p
					role='status'
					className='text-muted-foreground rounded-xl border p-8 text-center'
				>
					{t(prefix + 'loading')}
				</p>
			) : state.snapshot ? (
				<>
					<ReliabilityTables
						providers={state.snapshot.providers}
						modelProviders={state.snapshot.modelProviders}
						currency={currency}
						locale={locale}
					/>
					<ReliabilityRecentErrors
						rows={state.snapshot.recentErrors}
						timezone={timezone}
						locale={locale}
					/>
				</>
			) : null}
		</main>
	)
}
