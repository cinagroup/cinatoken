/** Each migrated Console resource opts into the Web shell independently. */
export const ADMIN_DASHBOARD_PAGE_PATHS = new Set(['/admin', '/admin/'])

export const ADMIN_USERS_PAGE_PATHS = new Set(['/admin/users', '/admin/users/'])

const ADMIN_USER_DETAIL_UUID =
	/^\/admin\/users\/[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89AaBb][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}\/?$/u
const ADMIN_USER_DETAIL_SIMPLE_EXTERNAL =
	/^\/admin\/users\/ext%3A[A-Za-z0-9._~-]{1,600}%2F[A-Za-z0-9._~-]{1,600}\/?$/u

/** Conservative rollout: complex encoded external IDs remain on Admin. */
export function isAdminUserDetailPagePath(pathname: string): boolean {
	return (
		ADMIN_USER_DETAIL_UUID.test(pathname) ||
		ADMIN_USER_DETAIL_SIMPLE_EXTERNAL.test(pathname)
	)
}

export const ADMIN_PROVIDERS_PAGE_PATHS = new Set([
	'/admin/providers',
	'/admin/providers/',
])

export const ADMIN_MODELS_PAGE_PATHS = new Set([
	'/admin/models',
	'/admin/models/',
])

export const ADMIN_ENDPOINTS_PAGE_PATHS = new Set([
	'/admin/endpoints',
	'/admin/endpoints/',
])

export const ADMIN_ROUTES_PAGE_PATHS = new Set([
	'/admin/routes',
	'/admin/routes/',
])

export const ADMIN_DATA_POLICIES_PAGE_PATHS = new Set([
	'/admin/data-policies',
	'/admin/data-policies/',
])

export const ADMIN_PRESETS_PAGE_PATHS = new Set([
	'/admin/presets',
	'/admin/presets/',
])

export const ADMIN_GUARDRAILS_PAGE_PATHS = new Set([
	'/admin/guardrails',
	'/admin/guardrails/',
])

export const ADMIN_RELIABILITY_PAGE_PATHS = new Set([
	'/admin/analytics/reliability',
	'/admin/analytics/reliability/',
])

export const ADMIN_MODEL_ANALYTICS_PAGE_PATHS = new Set([
	'/admin/analytics/models',
	'/admin/analytics/models/',
])

export const ADMIN_PROVIDER_ANALYTICS_PAGE_PATHS = new Set([
	'/admin/analytics/providers',
	'/admin/analytics/providers/',
])

export const ADMIN_USER_ANALYTICS_PAGE_PATHS = new Set([
	'/admin/analytics/users',
	'/admin/analytics/users/',
])

export const ADMIN_REQUEST_LOGS_PAGE_PATHS = new Set([
	'/admin/request-logs',
	'/admin/request-logs/',
])

export const ADMIN_BUDGET_AUDIT_PAGE_PATHS = new Set([
	'/admin/audit-logs',
	'/admin/audit-logs/',
])

export const ADMIN_TOOL_INVOCATIONS_PAGE_PATHS = new Set([
	'/admin/tools/invocations',
	'/admin/tools/invocations/',
])

export const ADMIN_TOOLS_PAGE_PATHS = new Set(['/admin/tools', '/admin/tools/'])

export const ADMIN_PLAYGROUND_PAGE_PATHS = new Set([
	'/admin/playground',
	'/admin/playground/',
])
export const ADMIN_SIMULATOR_PAGE_PATHS = new Set([
	'/admin/simulator',
	'/admin/simulator/',
])

export const ADMIN_CONFIG_TIMEZONE_PAGE_PATHS = new Set([
	'/admin/config/timezone',
	'/admin/config/timezone/',
])

export const ADMIN_CONFIG_PAGE_PATHS = new Set([
	'/admin/config',
	'/admin/config/',
])

export const ADMIN_ACCESS_KEYS_PAGE_PATHS = new Set([
	'/admin/admin-api-keys',
	'/admin/admin-api-keys/',
])

export const ADMIN_KEYS_PAGE_PATHS = new Set(['/admin/keys', '/admin/keys/'])

export const ADMIN_SHARED_KEYS_PAGE_PATHS = new Set([
	'/admin/shared-keys',
	'/admin/shared-keys/',
])

export const ADMIN_WITHDRAWALS_PAGE_PATHS = new Set([
	'/admin/withdrawals',
	'/admin/withdrawals/',
])

export const ADMIN_NFT_MINTS_PAGE_PATHS = new Set([
	'/admin/nft-mints',
	'/admin/nft-mints/',
])
