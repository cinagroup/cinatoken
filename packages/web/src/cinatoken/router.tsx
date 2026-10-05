/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	createRootRoute,
	createRoute,
	createRouter,
	lazyRouteComponent,
} from '@tanstack/react-router'
import { validateAuditLogSearch } from './admin/audit-logs/audit-log-domain'
import { validateChainOperationsSearch } from './admin/chain-operations/chain-operations-search'
import { validateDataPolicySearch } from './admin/data-policies/data-policy-search'
import { validateEndpointSearch } from './admin/endpoint-search'
import { validateGatewayKeyRouteSearch } from './admin/gateway-keys/gateway-key-search'
import { validateModelSearch } from './admin/model-search'
import { validatePlaygroundSearch } from './admin/playground/playground-contracts'
import { validateProviderSearch } from './admin/provider-search'
import { validateRequestLogRouteSearch } from './admin/request-logs/request-log-domain'
import { validateRouteFilters } from './admin/routes/route-domain'
import { validateAdminSharedKeyRouteSearch } from './admin/shared-keys/shared-key-search'
import { validateSimulatorSearch } from './admin/simulator/simulator-search'
import { validateToolInvocationSearch } from './admin/tool-invocations/tool-invocation-domain'
import { validateUsersSearch } from './admin/users/users-search'
import { ApplicationShell, AccountLayout, NotFoundPage } from './app-shell'
import { validateChatSearch } from './chat/chat-search'
import { HomePage } from './home-page'
import { PublicAuthStatus } from './public/auth/PublicAuthStatus'
import { PublicAuthProvider } from './public/auth/public-auth-context'
import {
	validateCompareSearch,
	validateModelCatalogSearch,
	validateProvidersSearch,
	validateStatsSearch,
} from './public/catalog-search'
import { validateBenchmarkSearch } from './public/catalog-view-model'

const rootRoute = createRootRoute({
	component: ApplicationShell,
	notFoundComponent: NotFoundPage,
})
const homeRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: () => (
		<PublicAuthProvider>
			<PublicAuthStatus />
			<HomePage />
		</PublicAuthProvider>
	),
})
const chatRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/chat',
	validateSearch: validateChatSearch,
	component: lazyRouteComponent(
		() => import('./chat/PublicChatRoute'),
		'PublicChatRoute'
	),
})
const modelsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/models',
	validateSearch: validateModelCatalogSearch,
	component: lazyRouteComponent(
		() => import('./public-routes/ModelCatalogRoute'),
		'ModelCatalogRoute'
	),
})
const modelDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/models/$vendor/$slug',
	component: lazyRouteComponent(
		() => import('./public-routes/ModelDetailRoute'),
		'ModelDetailRoute'
	),
})
const providersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/providers',
	validateSearch: validateProvidersSearch,
	component: lazyRouteComponent(
		() => import('./public-routes/ProvidersRoute'),
		'ProvidersRoute'
	),
})
const compareRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/compare',
	validateSearch: validateCompareSearch,
	component: lazyRouteComponent(
		() => import('./public-routes/CompareRoute'),
		'CompareRoute'
	),
})
const rankingsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/rankings',
	validateSearch: validateStatsSearch,
	component: lazyRouteComponent(
		() => import('./public-routes/RankingsRoute'),
		'RankingsRoute'
	),
})
const benchmarksRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/benchmarks',
	validateSearch: validateBenchmarkSearch,
	component: lazyRouteComponent(
		() => import('./public-routes/BenchmarksRoute'),
		'BenchmarksRoute'
	),
})
const accountRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/account',
	component: AccountLayout,
})
const accountOverviewRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/',
	component: lazyRouteComponent(
		() => import('./account/AccountOverview'),
		'AccountOverview'
	),
})
const accountKeysRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/keys',
	component: lazyRouteComponent(
		() => import('./account/AccountKeys'),
		'AccountKeys'
	),
})
const accountByokRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/byok',
	component: lazyRouteComponent(
		() => import('./account/byok/AccountByok'),
		'AccountByok'
	),
})
const accountActivityRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/activity',
	component: lazyRouteComponent(
		() => import('./account/activity/AccountActivity'),
		'AccountActivity'
	),
})

const accountEarningsRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/earnings',
	component: lazyRouteComponent(
		() => import('./account/AccountEarningsRoute'),
		'AccountEarningsRoute'
	),
})
const accountNftRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/nft',
	component: lazyRouteComponent(
		() => import('./account/AccountNftRoute'),
		'AccountNftRoute'
	),
})

const accountWithdrawRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/withdraw',
	component: lazyRouteComponent(
		() => import('./account/AccountWithdrawRoute'),
		'AccountWithdrawRoute'
	),
})
const accountPresetsRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/presets',
	component: lazyRouteComponent(
		() => import('./account/AccountPresetsRoute'),
		'AccountPresetsRoute'
	),
})
const accountGuardrailsRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/guardrails',
	component: lazyRouteComponent(
		() => import('./account/AccountGuardrailsRoute'),
		'AccountGuardrailsRoute'
	),
})
const accountSettingsRoute = createRoute({
	getParentRoute: () => accountRoute,
	path: '/settings',
	component: lazyRouteComponent(
		() => import('./account/AccountSettings'),
		'AccountSettings'
	),
})

const adminRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/admin',
	component: lazyRouteComponent(
		() => import('./admin/AdminLayout'),
		'AdminLayout'
	),
})
const adminDashboardRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/',
	component: lazyRouteComponent(
		() => import('./admin/AdminDashboardRoute'),
		'AdminDashboardRoute'
	),
})
const adminReliabilityRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/analytics/reliability',
	component: lazyRouteComponent(
		() => import('./admin/AdminReliabilityRoute'),
		'AdminReliabilityRoute'
	),
})
const adminModelAnalyticsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/analytics/models',
	component: lazyRouteComponent(
		() => import('./admin/AdminModelAnalyticsRoute'),
		'AdminModelAnalyticsRoute'
	),
})
const adminProviderAnalyticsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/analytics/providers',
	component: lazyRouteComponent(
		() => import('./admin/AdminProviderAnalyticsRoute'),
		'AdminProviderAnalyticsRoute'
	),
})
const adminUserAnalyticsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/analytics/users',
	component: lazyRouteComponent(
		() => import('./admin/AdminUserAnalyticsRoute'),
		'AdminUserAnalyticsRoute'
	),
})
const adminRequestLogsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/request-logs',
	validateSearch: validateRequestLogRouteSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminRequestLogsRoute'),
		'AdminRequestLogsRoute'
	),
})
const adminAccessKeysRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/admin-api-keys',
	component: lazyRouteComponent(
		() => import('./admin/AdminAccessKeysRoute'),
		'AdminAccessKeysRoute'
	),
})
const adminGatewayKeysRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/keys',
	validateSearch: validateGatewayKeyRouteSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminGatewayKeysRoute'),
		'AdminGatewayKeysRoute'
	),
})
const adminSharedKeysRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/shared-keys',
	validateSearch: validateAdminSharedKeyRouteSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminSharedKeysRoute'),
		'AdminSharedKeysRoute'
	),
})
const adminToolsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/tools',
	component: lazyRouteComponent(
		() => import('./admin/AdminToolsRoute'),
		'AdminToolsRoute'
	),
})
const adminWithdrawalsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/withdrawals',
	validateSearch: (value: Record<string, unknown>) =>
		validateChainOperationsSearch(value, 'withdrawals'),
	component: lazyRouteComponent(
		() => import('./admin/chain-operations/AdminWithdrawalsRoute'),
		'AdminWithdrawalsRoute'
	),
})
const adminNftMintsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/nft-mints',
	validateSearch: (value: Record<string, unknown>) =>
		validateChainOperationsSearch(value, 'nft-mints'),
	component: lazyRouteComponent(
		() => import('./admin/chain-operations/AdminNftMintsRoute'),
		'AdminNftMintsRoute'
	),
})
const adminPlaygroundRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/playground',
	validateSearch: validatePlaygroundSearch,
	component: lazyRouteComponent(
		() => import('./admin/playground/AdminPlaygroundRoute'),
		'AdminPlaygroundRoute'
	),
})
const adminSimulatorRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/simulator',
	validateSearch: validateSimulatorSearch,
	component: lazyRouteComponent(
		() => import('./admin/simulator/AdminSimulatorRoute'),
		'AdminSimulatorRoute'
	),
})
const adminToolInvocationsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/tools/invocations',
	validateSearch: validateToolInvocationSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminToolInvocationsRoute'),
		'AdminToolInvocationsRoute'
	),
})
const adminAuditLogsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/audit-logs',
	validateSearch: validateAuditLogSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminAuditLogsRoute'),
		'AdminAuditLogsRoute'
	),
})
const adminProvidersRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/providers',
	validateSearch: validateProviderSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminProvidersRoute'),
		'AdminProvidersRoute'
	),
})
const adminUsersRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/users',
	validateSearch: validateUsersSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminUsersRoute'),
		'AdminUsersRoute'
	),
})
const adminUserDetailRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/users/$userId',
	component: lazyRouteComponent(
		() => import('./admin/AdminUserDetailRoute'),
		'AdminUserDetailRoute'
	),
})
const adminModelsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/models',
	validateSearch: validateModelSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminModelsRoute'),
		'AdminModelsRoute'
	),
})
const adminEndpointsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/endpoints',
	validateSearch: validateEndpointSearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminEndpointsRoute'),
		'AdminEndpointsRoute'
	),
})
const adminRoutesRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/routes',
	validateSearch: validateRouteFilters,
	component: lazyRouteComponent(
		() => import('./admin/AdminRoutesRoute'),
		'AdminRoutesRoute'
	),
})
const adminDataPoliciesRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/data-policies',
	validateSearch: validateDataPolicySearch,
	component: lazyRouteComponent(
		() => import('./admin/AdminDataPoliciesRoute'),
		'AdminDataPoliciesRoute'
	),
})
const adminPresetsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/presets',
	component: lazyRouteComponent(
		() => import('./admin/AdminPresetsRoute'),
		'AdminPresetsRoute'
	),
})
const adminGuardrailsRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/guardrails',
	component: lazyRouteComponent(
		() => import('./admin/AdminGuardrailsRoute'),
		'AdminGuardrailsRoute'
	),
})
const adminConfigTimezoneRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/config/timezone',
	component: lazyRouteComponent(
		() => import('./admin/AdminConfigTimezoneRoute'),
		'AdminConfigTimezoneRoute'
	),
})
const adminConfigRoute = createRoute({
	getParentRoute: () => adminRoute,
	path: '/config',
	component: lazyRouteComponent(
		() => import('./admin/AdminConfigFullRoute'),
		'AdminConfigFullRoute'
	),
})

export const router = createRouter({
	routeTree: rootRoute.addChildren([
		homeRoute,
		chatRoute,
		modelsRoute,
		modelDetailRoute,
		providersRoute,
		compareRoute,
		rankingsRoute,
		benchmarksRoute,
		adminRoute.addChildren([
			adminDashboardRoute,
			adminReliabilityRoute,
			adminModelAnalyticsRoute,
			adminProviderAnalyticsRoute,
			adminUserAnalyticsRoute,
			adminRequestLogsRoute,
			adminAccessKeysRoute,
			adminGatewayKeysRoute,
			adminSharedKeysRoute,
			adminWithdrawalsRoute,
			adminNftMintsRoute,
			adminToolInvocationsRoute,
			adminToolsRoute,
			adminPlaygroundRoute,
			adminSimulatorRoute,
			adminAuditLogsRoute,
			adminProvidersRoute,
			adminUsersRoute,
			adminUserDetailRoute,
			adminModelsRoute,
			adminEndpointsRoute,
			adminRoutesRoute,
			adminDataPoliciesRoute,
			adminPresetsRoute,
			adminGuardrailsRoute,
			adminConfigRoute,
			adminConfigTimezoneRoute,
		]),
		accountRoute.addChildren([
			accountOverviewRoute,
			accountKeysRoute,
			accountByokRoute,
			accountActivityRoute,
			accountEarningsRoute,
			accountNftRoute,
			accountWithdrawRoute,
			accountPresetsRoute,
			accountGuardrailsRoute,
			accountSettingsRoute,
		]),
	]),
	defaultPreload: 'intent',
	defaultPendingMs: 150,
	scrollRestoration: true,
})

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof router
	}
}
