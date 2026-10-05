/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { UserCreateDialog } from './UserCreateDialog'
import { UserFilters } from './UserFilters'
import { UserList } from './UserList'
import { useAdminUsers } from './use-admin-users'
import type { AdminUsersApi } from './users-api'
import { userReadErrorKey, userWriteErrorKey } from './users-errors'
import type { UsersSearch } from './users-search'

const prefix = 'cinatoken.adminUsers.'

export function AdminUsers(props: {
	api: AdminUsersApi
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
	search: UsersSearch
	onSearchChange: (next: UsersSearch) => void
}) {
	const { t, i18n } = useTranslation()
	const locale = i18n.resolvedLanguage ?? 'en'
	const manager = useAdminUsers(props)
	const [showCreate, setShowCreate] = useState(false)
	const page = manager.query.data
	const rows =
		!manager.readBlocked && !manager.query.isFetching && !manager.query.error
			? (page?.data ?? [])
			: []
	const totalPages = page ? Math.max(1, Math.ceil(page.total / 20)) : 1
	let writeLockMessage = 'unknownWrite'
	if (manager.writeSafetyUnavailable)
		writeLockMessage = 'writeSafetyUnavailable'
	else if (manager.confirmedButLocked) writeLockMessage = 'confirmedButLocked'
	function changePage(next: number): void {
		props.onSearchChange({ ...props.search, page: next })
	}
	return (
		<main className='min-w-0 space-y-5 pb-12'>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<h1 className='text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + 'title')}
					</h1>
					<p className='text-muted-foreground mt-1 text-sm'>
						{t(prefix + 'subtitle')}
					</p>
				</div>
				<div className='flex flex-wrap gap-2'>
					<Button
						type='button'
						variant='outline'
						onClick={manager.retry}
						disabled={manager.query.isFetching}
					>
						{t(prefix + 'refresh')}
					</Button>
					<Button
						type='button'
						onClick={() => setShowCreate(true)}
						disabled={!manager.canCreate}
					>
						{t(prefix + 'create')}
					</Button>
				</div>
			</header>
			<UserFilters
				key={JSON.stringify([
					props.search.email,
					props.search.external_system,
					props.search.external_user_id,
					props.search.status,
					props.search.max_budget,
				])}
				search={props.search}
				currency={manager.currency}
				currencySource={manager.currencySource}
				onChange={props.onSearchChange}
			/>
			{manager.writeBlocked && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'writeDenied')}
				</p>
			)}
			{manager.writeUnknown && (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 space-y-3 rounded-xl border p-4 text-sm'
				>
					<p>{t(prefix + writeLockMessage)}</p>
					{!manager.writeSafetyUnavailable && (
						<p>{t(prefix + 'unknownHelp')}</p>
					)}
				</section>
			)}
			{Boolean(manager.createError) &&
				!showCreate &&
				!manager.writeBlocked &&
				!manager.writeUnknown && (
					<p
						role='alert'
						className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
					>
						{t(prefix + userWriteErrorKey(manager.createError))}
					</p>
				)}
			{manager.created && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t(
						prefix +
							(manager.createdRefreshFailed
								? 'createdRefreshFailed'
								: 'created')
					)}
				</p>
			)}
			{manager.readBlocked ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5 text-sm'
				>
					{t(prefix + 'accessDenied')}
				</section>
			) : manager.query.isFetching ? (
				<p
					role='status'
					className='text-muted-foreground rounded-xl border p-8 text-center'
				>
					{t(prefix + 'loading')}
				</p>
			) : manager.query.error ? (
				<section
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-5 text-sm'
				>
					{t(prefix + userReadErrorKey(manager.query.error))}
				</section>
			) : rows.length === 0 ? (
				<p className='text-muted-foreground rounded-xl border p-8 text-center'>
					{t(prefix + 'empty')}
				</p>
			) : (
				<UserList rows={rows} currency={manager.currency} locale={locale} />
			)}
			{page && !manager.query.error && !manager.readBlocked && (
				<footer className='flex flex-wrap items-center justify-between gap-3 text-sm'>
					<p className='text-muted-foreground'>
						{t(prefix + 'count', { count: page.total })}
					</p>
					<div className='flex items-center gap-2'>
						<Button
							type='button'
							variant='outline'
							disabled={props.search.page <= 1}
							onClick={() => changePage(props.search.page - 1)}
						>
							{t(prefix + 'previous')}
						</Button>
						<span>
							{t(prefix + 'page', {
								page: props.search.page,
								total: totalPages,
							})}
						</span>
						<Button
							type='button'
							variant='outline'
							disabled={props.search.page >= totalPages}
							onClick={() => changePage(props.search.page + 1)}
						>
							{t(prefix + 'next')}
						</Button>
					</div>
				</footer>
			)}
			{showCreate && (
				<UserCreateDialog
					currency={manager.currency}
					pending={manager.isCreating}
					disabled={!manager.canCreate}
					error={manager.createError}
					onSubmit={manager.create}
					onClose={() => setShowCreate(false)}
				/>
			)}
		</main>
	)
}
