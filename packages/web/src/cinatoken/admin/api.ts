/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../api'
import { createAdminAccessKeysApi } from './access-keys/access-key-api'
import { createAdminModelAnalyticsApi } from './analytics/models/model-analytics-api'
import { createAdminProviderAnalyticsApi } from './analytics/providers/provider-analytics-api'
import { createAdminUserAnalyticsApi } from './analytics/users/user-analytics-api'
import { createAdminAuditLogsApi } from './audit-logs/audit-log-api'
import { createChainOperationsApi } from './chain-operations/chain-operations-api'
import { createAdminConfigApi } from './config/config-api'
import { createAdminDashboardApi } from './dashboard/dashboard-api'
import { createDataPoliciesApi } from './data-policies/data-policy-api'
import { AdminDomainWriteError } from './domain-write-recovery'
import { createEndpointsApi } from './endpoint-api'
import { createAdminGatewayKeysApi } from './gateway-keys/gateway-key-api'
import { createAdminGuardrailsApi } from './guardrails/guardrails-api'
import { createModelsApi } from './model-api'
import { createAdminPresetsApi } from './presets/presets-api'
import { createProvidersApi } from './provider-api'
import { createAdminReliabilityApi } from './reliability/reliability-api'
import { createAdminRequestLogsApi } from './request-logs/request-log-api'
import { createRoutesApi } from './routes/routes-api'
import { createAdminSharedKeysApi } from './shared-keys/shared-key-api'
import { createAdminToolInvocationsApi } from './tool-invocations/tool-invocation-api'
import { createAdminToolsApi } from './tools/tools-api'
import { createAdminUserDetailApi } from './user-detail/user-detail-api'
import { createAdminUsersApi } from './users/users-api'

/** Console resources have no portal workspace context or embedded integration credential. */
export function createCinaTokenAdminApi(request: typeof fetch = fetch) {
	const transport = createCinaTokenCookieTransport(request)
	const resourceTransport = {
		send(
			path,
			schema,
			init,
			options,
			reader?: (response: Response) => Promise<unknown>
		) {
			return transport.send(
				path,
				schema,
				init,
				{
					signal: options.signal,
					timeoutMs: options.timeoutMs,
				},
				reader
			)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Console response is invalid',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof AdminDomainWriteError) return error
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Console operation could not be confirmed',
					error.status,
					error.code
				)
			return new Error('Console operation could not be confirmed')
		},
	} satisfies Parameters<typeof createProvidersApi>[0]
	return {
		...createChainOperationsApi(request),
		...createAdminToolsApi(request),
		...createAdminSharedKeysApi(request),
		...createAdminAccessKeysApi(resourceTransport),
		...createAdminGatewayKeysApi(resourceTransport),
		...createProvidersApi(resourceTransport),
		...createModelsApi(resourceTransport),
		...createEndpointsApi(resourceTransport),
		...createRoutesApi(resourceTransport),
		...createDataPoliciesApi(resourceTransport),
		...createAdminPresetsApi(resourceTransport),
		...createAdminGuardrailsApi(resourceTransport),
		...createAdminConfigApi(resourceTransport),
		...createAdminDashboardApi(resourceTransport),
		...createAdminReliabilityApi(resourceTransport),
		...createAdminModelAnalyticsApi(resourceTransport),
		...createAdminProviderAnalyticsApi(resourceTransport),
		...createAdminUserAnalyticsApi(resourceTransport),
		...createAdminRequestLogsApi(resourceTransport),
		...createAdminToolInvocationsApi(resourceTransport),
		...createAdminAuditLogsApi(resourceTransport),
		...createAdminUsersApi(resourceTransport),
		...createAdminUserDetailApi(resourceTransport),
	}
}

export const cinatokenAdminApi = createCinaTokenAdminApi()
export type CinaTokenAdminApi = ReturnType<typeof createCinaTokenAdminApi>
