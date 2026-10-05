/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { SharedKeysFilters } from './SharedKeysFilters'
import { SharedKeysManager } from './SharedKeysManager'
import type { AdminSharedKeySearch } from './shared-key-search'
import {
	useAdminSharedKeys,
	type AdminSharedKeysProps,
} from './use-admin-shared-keys'

const prefix = 'cinatoken.adminSharedKeys.'
type Props = AdminSharedKeysProps & {
	onSearchChange: (search: AdminSharedKeySearch) => void
}
export function AdminSharedKeys(props: Props) {
	return (
		<SharedKeysSession
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.canWrite,
				props.consoleSubject,
				props.search,
			])}
			{...props}
		/>
	)
}
function SharedKeysSession(props: Props) {
	const { t } = useTranslation()
	const manager = useAdminSharedKeys(props)
	let content: JSX.Element
	if (manager.blocked)
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(prefix + 'accessDenied')}
			</p>
		)
	else if (manager.query.error)
		content = (
			<p role='alert' className='rounded-xl border p-5'>
				{t(
					prefix +
						(manager.query.error instanceof CinaTokenApiError &&
						manager.query.error.code === 'invalid-response'
							? 'invalidResponse'
							: 'readFailed')
				)}
			</p>
		)
	else if (manager.query.data)
		content = (
			<SharedKeysManager
				key={JSON.stringify([
					props.scopeKey,
					props.reconciliationKey,
					props.canWrite,
					manager.deniedWrite,
					manager.query.data.capabilities,
				])}
				context={props}
				manager={manager}
				page={manager.query.data}
				onPage={(page) => props.onSearchChange({ ...props.search, page })}
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
					disabled={manager.blocked || manager.query.isFetching || manager.busy}
					onClick={() => void manager.query.refetch()}
				>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			<SharedKeysFilters
				key={JSON.stringify(props.search)}
				search={props.search}
				disabled={manager.busy}
				onChange={props.onSearchChange}
			/>
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
