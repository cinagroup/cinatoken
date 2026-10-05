/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { validateEndpointSearch } from './endpoint-search'
import { AdminRoutingWorkbench } from './routing-workbench/AdminRoutingWorkbench'
import { useRoutingWorkbenchSession } from './routing-workbench/use-routing-workbench-session'

const route = getRouteApi('/admin/endpoints')

export function AdminEndpointsRoute() {
	const session = useRoutingWorkbenchSession()
	const filters = route.useSearch()
	const navigate = route.useNavigate()
	if (!session) return null
	return (
		<AdminRoutingWorkbench
			key={session.scopeKey}
			feature='endpoints'
			session={session}
			search={filters}
			onSearchChange={(next) =>
				void navigate({ search: validateEndpointSearch(next), replace: true })
			}
		/>
	)
}
