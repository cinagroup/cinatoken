/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useTranslation } from 'react-i18next'
import { SimulatorRequest } from './SimulatorRequest'
import { SimulatorResponse } from './SimulatorResponse'
import { SimulatorRouting } from './SimulatorRouting'
import { SimulatorSetup } from './SimulatorSetup'
import { simulatorAdminApi, type SimulatorAdminApi } from './simulator-api'
import type { SimulatorSearch } from './simulator-selection'
import type { SimulatorSession } from './types'
import { useSimulator } from './use-simulator'

export type SimulatorScreenProps = {
	session: SimulatorSession
	api?: SimulatorAdminApi
	search?: SimulatorSearch
}
/** Shared by Web Router and the thin legacy Next bridge; this component has no Router dependency. */
export function SimulatorScreen(props: SimulatorScreenProps) {
	const { t } = useTranslation()
	if (props.search?.invalidTarget)
		return (
			<main className='space-y-4'>
				<h1 className='text-2xl font-semibold'>
					{t('cinatoken.adminSimulator.title')}
				</h1>
				<p role='alert' className='rounded-xl border p-4'>
					{t('cinatoken.adminSimulator.invalidTarget')}
				</p>
				<a href='/admin/simulator' className='text-primary underline'>
					{t('cinatoken.adminSimulator.clearTarget')}
				</a>
			</main>
		)
	return (
		<SimulatorContent
			key={JSON.stringify([
				props.session.scopeKey,
				props.session.reconciliationKey,
				props.session.subject,
				props.session.enabled,
				props.search,
			])}
			{...props}
		/>
	)
}
function SimulatorContent(props: SimulatorScreenProps) {
	const { t } = useTranslation()
	const state = useSimulator({
		api: props.api ?? simulatorAdminApi,
		session: props.session,
		search: props.search,
	})
	return (
		<main className='min-w-0 space-y-5'>
			<header className='space-y-2'>
				<h1 className='text-2xl font-semibold'>
					{t('cinatoken.adminSimulator.title')}
				</h1>
				<p className='text-muted-foreground text-sm'>
					{t('cinatoken.adminSimulator.subtitle', { product: 'cinatoken' })}
				</p>
				<p className='text-muted-foreground text-xs'>
					{t('cinatoken.adminSimulator.usageNote')}
				</p>
			</header>
			{state.contextQuery.isPending && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t('cinatoken.adminSimulator.loading')}
				</p>
			)}
			{state.contextQuery.isError && (
				<div
					role='alert'
					className='flex flex-wrap items-center gap-3 rounded-xl border p-4 text-sm'
				>
					<p>{t('cinatoken.adminSimulator.contextError')}</p>
					<button
						type='button'
						className='text-primary underline'
						onClick={state.refreshContext}
					>
						{t('cinatoken.adminSimulator.refreshList')}
					</button>
				</div>
			)}
			<div className='grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]'>
				<div className='min-w-0 space-y-5'>
					<SimulatorSetup state={state} />
					<SimulatorRouting state={state} />
				</div>
				<div className='min-w-0 space-y-5'>
					<SimulatorRequest state={state} />
					<SimulatorResponse
						response={state.response}
						canReadLogs={
							props.session.canReadLogs !== false &&
							!!state.context?.capabilities.can_read_logs
						}
					/>
				</div>
			</div>
		</main>
	)
}
