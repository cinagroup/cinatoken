/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminDashboard } from './dashboard/AdminDashboard'
import {
	dashboardRangeFromSearch,
	dashboardSearchFromRange,
} from './dashboard/dashboard-search'

const route = getRouteApi('/admin/')

export function AdminDashboardRoute() {
	const search = route.useSearch()
	const navigate = route.useNavigate()
	const console = useCinaTokenConsole()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminDashboard
			range={dashboardRangeFromSearch(search)}
			onRangeChange={(range) => {
				void navigate({
					search: dashboardSearchFromRange(range),
					replace: true,
				})
			}}
			key={console.scopeKey}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			revalidate={console.revalidate}
		/>
	)
}
