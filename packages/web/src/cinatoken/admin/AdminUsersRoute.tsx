/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminUsers } from './users/AdminUsers'

const route = getRouteApi('/admin/users')

export function AdminUsersRoute() {
	const console = useCinaTokenConsole()
	const search = route.useSearch()
	const navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminUsers
			key={console.scopeKey}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			canWrite={console.canWrite}
			revalidate={console.revalidate}
			search={search}
			onSearchChange={(next) => void navigate({ search: next, replace: true })}
		/>
	)
}
