/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { validateModelSearch } from './model-search'
import { AdminRoutingWorkbench } from './routing-workbench/AdminRoutingWorkbench'
import { useRoutingWorkbenchSession } from './routing-workbench/use-routing-workbench-session'

const route = getRouteApi('/admin/models')

export function AdminModelsRoute() {
	const session = useRoutingWorkbenchSession()
	const filters = route.useSearch()
	const navigate = route.useNavigate()
	if (!session) return null
	return (
		<AdminRoutingWorkbench
			key={session.scopeKey}
			feature='models'
			session={session}
			search={filters}
			onSearchChange={(next) =>
				void navigate({ search: validateModelSearch(next), replace: true })
			}
			onModelEditConsumed={() => {
				const rest = { ...filters }
				delete rest.edit
				delete rest.invalidEdit
				void navigate({ search: rest, replace: true })
			}}
		/>
	)
}
