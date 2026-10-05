/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenAdminApi, type CinaTokenAdminApi } from '../api'
import { AdminDataPolicies } from '../data-policies/AdminDataPolicies'
import {
	validateDataPolicySearch,
	type DataPolicyFilters,
} from '../data-policies/data-policy-search'
import { AdminGuardrails } from '../guardrails/AdminGuardrails'
import {
	createAdminGuardrailPreviewApi,
	type AdminGuardrailPreviewApi,
} from '../guardrails/preview-api'
import { AdminPresets } from '../presets/AdminPresets'
import type { RoutingWorkbenchSession } from '../routing-workbench/AdminRoutingWorkbench'
import type { PolicyWorkbenchFeature } from './policy-workbench-search'

const guardrailPreviewApi = createAdminGuardrailPreviewApi()
export type PolicyWorkbenchSession = RoutingWorkbenchSession

/** The legacy and Web entries share every policy operation and identity boundary. */
export function AdminPolicyWorkbench(props: {
	feature: PolicyWorkbenchFeature
	session: PolicyWorkbenchSession
	api?: CinaTokenAdminApi
	previewApi?: AdminGuardrailPreviewApi
	search?: unknown
	onSearchChange?: (filters: DataPolicyFilters) => void
}) {
	const shared = { ...props.session, api: props.api ?? cinatokenAdminApi }
	switch (props.feature) {
		case 'presets':
			return <AdminPresets {...shared} />
		case 'guardrails':
			return (
				<AdminGuardrails
					{...shared}
					previewApi={props.previewApi ?? guardrailPreviewApi}
				/>
			)
		case 'data-policies':
			return (
				<AdminDataPolicies
					{...shared}
					initialFilters={validateDataPolicySearch(props.search)}
					onFiltersChange={props.onSearchChange}
				/>
			)
	}
}
