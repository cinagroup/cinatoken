/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenAdminApi, type CinaTokenAdminApi } from '../api'
import { validateEndpointSearch } from '../endpoint-search'
import { AdminEndpoints } from '../endpoints/AdminEndpoints'
import { validateModelSearch } from '../model-search'
import { AdminModels } from '../models/AdminModels'
import { validateProviderSearch } from '../provider-search'
import { AdminProviders } from '../providers/AdminProviders'
import { AdminRoutes } from '../routes/AdminRoutes'
import { validateRouteFilters } from '../routes/route-domain'
import type {
	RoutingWorkbenchFeature,
	RoutingWorkbenchSearch,
} from './routing-workbench-search'

export type RoutingWorkbenchSession = {
	scopeKey: string
	reconciliationKey: string
	subject: string
	userId: string
	canWrite: boolean
	revalidate: () => Promise<void>
}

/** Both browser entries render the full domain UI with the same verified identity. */
export function AdminRoutingWorkbench(props: {
	feature: RoutingWorkbenchFeature
	session: RoutingWorkbenchSession
	api?: CinaTokenAdminApi
	search: unknown
	onSearchChange?: (value: RoutingWorkbenchSearch) => void
	onModelEditConsumed?: () => void
}) {
	const shared = { ...props.session, api: props.api ?? cinatokenAdminApi }
	switch (props.feature) {
		case 'providers':
			return (
				<AdminProviders
					{...shared}
					initialFilters={validateProviderSearch(props.search)}
					onFiltersChange={props.onSearchChange}
				/>
			)
		case 'models':
			return (
				<AdminModels
					{...shared}
					initialFilters={validateModelSearch(props.search)}
					onFiltersChange={props.onSearchChange}
					onEditConsumed={props.onModelEditConsumed}
				/>
			)
		case 'endpoints':
			return (
				<AdminEndpoints
					{...shared}
					initialFilters={validateEndpointSearch(props.search)}
					onFiltersChange={props.onSearchChange}
				/>
			)
		case 'routes':
			return (
				<AdminRoutes
					{...shared}
					recheckIdentityKey={JSON.stringify([shared.userId, shared.subject])}
					initialFilters={validateRouteFilters(props.search)}
					onFiltersChange={props.onSearchChange}
				/>
			)
	}
}
