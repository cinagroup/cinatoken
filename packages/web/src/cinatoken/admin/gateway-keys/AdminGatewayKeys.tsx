/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import type { AdminGuardrailPreviewApi } from '../guardrails/preview-api'
import { GatewayKeysFilters } from './GatewayKeysFilters'
import { GatewayKeysManager } from './GatewayKeysManager'
import type { GatewayKeySearch } from './gateway-key-search'
import { useGatewayKeys, type GatewayKeysProps } from './use-gateway-keys'

const prefix = 'cinatoken.adminGatewayKeys.'
type Props = GatewayKeysProps & {
	previewApi: AdminGuardrailPreviewApi
	onSearchChange: (search: GatewayKeySearch) => void
}
export function AdminGatewayKeys(props: Props) {
	return (
		<GatewayKeysSession
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
			])}
			{...props}
		/>
	)
}
function GatewayKeysSession(props: Props) {
	const { t } = useTranslation()
	const manager = useGatewayKeys(props)
	const page = manager.query.data
	let content: JSX.Element
	if (manager.blocked)
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(prefix + 'accessDenied')}
			</p>
		)
	else if (manager.query.error) {
		const error = manager.query.error
		const message =
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
				? 'invalidResponse'
				: 'readFailed'
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(prefix + message)}
			</p>
		)
	} else if (page)
		content = (
			<GatewayKeysManager
				key={JSON.stringify([
					props.scopeKey,
					props.reconciliationKey,
					props.canWrite,
					manager.deniedWrite,
					page.capabilities,
				])}
				context={props}
				manager={manager}
				page={page}
				previewApi={props.previewApi}
				onPage={(next) => props.onSearchChange({ ...props.search, page: next })}
			/>
		)
	else
		content = (
			<p role='status' className='text-muted-foreground py-10 text-center'>
				{t(prefix + 'loading')}
			</p>
		)
	return (
		<main className='min-w-0 space-y-5 pb-10'>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h1 className='text-2xl font-semibold'>{t(prefix + 'title')}</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<Button
					type='button'
					variant='outline'
					disabled={manager.query.isFetching || manager.busy || manager.blocked}
					onClick={() => void manager.query.refetch()}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<GatewayKeysFilters
				key={JSON.stringify(props.search)}
				search={props.search}
				currency={manager.currency}
				onChange={props.onSearchChange}
			/>
			{manager.currency === null && (
				<p role='status' className='text-muted-foreground text-sm'>
					{t(prefix + 'currencyUnavailable')}
				</p>
			)}
			{manager.writeStatus !== 'ready' && (
				<p
					role='alert'
					className='rounded-xl border border-amber-500/50 p-4 text-sm'
				>
					{t(
						prefix +
							(manager.writeStatus === 'pending'
								? 'pendingWrite'
								: 'storageUnavailable')
					)}
				</p>
			)}
			{manager.deniedWrite && (
				<p
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'writeDenied')}
				</p>
			)}
			{manager.writeError && (
				<p
					role='alert'
					className='text-destructive rounded-xl border p-4 text-sm'
				>
					{t(prefix + manager.writeError)}
				</p>
			)}
			{manager.saved && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t(prefix + 'saved')}
				</p>
			)}
			{content}
		</main>
	)
}
