/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { getRouteApi } from '@tanstack/react-router'
import { cinatokenAdminApi } from './api'
import { useCinaTokenConsole } from './console-context'
import { AdminDataPolicies } from './data-policies/AdminDataPolicies'
import type { DataPolicyFilters } from './data-policies/data-policy-search'

const route = getRouteApi('/admin/data-policies')

export function AdminDataPoliciesRoute() {
	const console = useCinaTokenConsole()
	const filters = route.useSearch()
	const navigate = route.useNavigate()
	if (!console.isVerified || !console.scopeKey || !console.identity) return null
	return (
		<AdminDataPolicies
			key={console.scopeKey}
			api={cinatokenAdminApi}
			scopeKey={console.scopeKey}
			reconciliationKey={JSON.stringify([
				console.identity.userId,
				console.identity.subject,
				console.identity.epoch,
			])}
			canWrite={console.canWrite}
			subject={console.identity.subject}
			userId={console.identity.userId}
			revalidate={console.revalidate}
			initialFilters={filters}
			onFiltersChange={(next: DataPolicyFilters) =>
				void navigate({ search: next, replace: true })
			}
		/>
	)
}
