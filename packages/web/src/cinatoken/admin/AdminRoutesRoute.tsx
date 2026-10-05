/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { validateRouteFilters } from './routes/route-domain'
import { AdminRoutingWorkbench } from './routing-workbench/AdminRoutingWorkbench'
import { useRoutingWorkbenchSession } from './routing-workbench/use-routing-workbench-session'

const route = getRouteApi('/admin/routes')

export function AdminRoutesRoute() {
	const session = useRoutingWorkbenchSession()
	const filters = route.useSearch()
	const navigate = route.useNavigate()
	if (!session) return null
	return (
		<AdminRoutingWorkbench
			key={session.scopeKey}
			feature='routes'
			session={session}
			search={filters}
			onSearchChange={(next) =>
				void navigate({ search: validateRouteFilters(next), replace: true })
			}
		/>
	)
}
