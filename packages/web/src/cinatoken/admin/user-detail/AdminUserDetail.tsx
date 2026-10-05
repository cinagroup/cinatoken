/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { JSX } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { CinaTokenApiError } from '../../api'
import { userAccessDenied } from '../users/users-errors'
import { UserDetailSections } from './UserDetailSections'
import {
	useAdminUserDetail,
	type UserDetailManagerProps,
} from './use-user-detail'
import { UserDetailInputError } from './user-detail-domain'

const prefix = 'cinatoken.adminUserDetail.'
function errorKey(error: unknown): string {
	if (error instanceof UserDetailInputError) return 'invalidInput'
	if (userAccessDenied(error)) return 'writeDenied'
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'keyConflict'
	return 'writeFailed'
}
export function AdminUserDetail(props: UserDetailManagerProps) {
	return (
		<UserDetailSession
			key={JSON.stringify([
				props.scopeKey,
				props.reconciliationKey,
				props.routeId,
				props.canWrite,
			])}
			{...props}
		/>
	)
}
function UserDetailSession(props: UserDetailManagerProps) {
	const { t } = useTranslation()
	const manager = useAdminUserDetail(props)
	const user = manager.user
	const noUser = manager.blocked.user || Boolean(manager.userQuery.error)
	let content: JSX.Element
	if (noUser)
		content = (
			<section
				role='alert'
				className='border-destructive/40 rounded-xl border p-5 text-sm'
			>
				{t(
					prefix +
						(manager.blocked.user || userAccessDenied(manager.userQuery.error)
							? 'readDenied'
							: 'readFailed')
				)}
			</section>
		)
	else if (!user)
		content = (
			<p
				role='status'
				className='text-muted-foreground rounded-xl border p-8 text-center'
			>
				{t(prefix + 'loading')}
			</p>
		)
	else
		content = (
			<UserDetailSections manager={manager} user={user} api={props.api} />
		)
	return (
		<main className='min-w-0 space-y-5 pb-12'>
			<header className='flex flex-wrap items-start justify-between gap-3'>
				<div>
					<a className='text-primary text-sm underline' href='/admin/users'>
						{t(prefix + 'back')}
					</a>
					<h1 className='mt-2 text-2xl font-semibold tracking-tight sm:text-3xl'>
						{t(prefix + 'title')}
					</h1>
					{user && (
						<p className='text-muted-foreground mt-1 text-sm break-all'>
							{user.email}
						</p>
					)}
				</div>
				<Button type='button' variant='outline' onClick={manager.retry}>
					{t(prefix + 'refresh')}
				</Button>
			</header>
			{manager.unknownWrite && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'unknownWrite')}
				</p>
			)}
			{manager.blocked.userWrite && (
				<p role='status' className='rounded-xl border p-3 text-sm'>
					{t(prefix + 'writeDenied')}
				</p>
			)}
			{manager.blocked.keyWrite && (
				<p role='status' className='rounded-xl border p-3 text-sm'>
					{t(prefix + 'keyWriteDenied')}
				</p>
			)}
			{manager.keyCreateUnknown && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'keyUnknown')}
				</p>
			)}
			{manager.transitionUnknown && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + 'transitionUnknown')}
				</p>
			)}
			{Boolean(manager.writeError) && !manager.unknownWrite && (
				<p
					role='alert'
					className='border-destructive/40 bg-destructive/5 rounded-xl border p-4 text-sm'
				>
					{t(prefix + errorKey(manager.writeError))}
				</p>
			)}
			{manager.writeNote && (
				<p role='status' className='rounded-xl border p-4 text-sm'>
					{t(prefix + manager.writeNote)}
				</p>
			)}
			{content}
		</main>
	)
}
