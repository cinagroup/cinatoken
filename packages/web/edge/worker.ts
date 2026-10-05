import { assetCacheControl } from '../scripts/asset-policy.mjs'
import { webProxyConnectSources } from '../scripts/proxy-origin-policy.mjs'
import {
	ADMIN_ACCESS_KEYS_PAGE_PATHS,
	ADMIN_KEYS_PAGE_PATHS,
	ADMIN_SHARED_KEYS_PAGE_PATHS,
	ADMIN_DATA_POLICIES_PAGE_PATHS,
	ADMIN_DASHBOARD_PAGE_PATHS,
	ADMIN_CONFIG_PAGE_PATHS,
	ADMIN_CONFIG_TIMEZONE_PAGE_PATHS,
	ADMIN_ENDPOINTS_PAGE_PATHS,
	ADMIN_GUARDRAILS_PAGE_PATHS,
	ADMIN_MODELS_PAGE_PATHS,
	ADMIN_MODEL_ANALYTICS_PAGE_PATHS,
	ADMIN_PROVIDER_ANALYTICS_PAGE_PATHS,
	ADMIN_USER_ANALYTICS_PAGE_PATHS,
	ADMIN_REQUEST_LOGS_PAGE_PATHS,
	ADMIN_BUDGET_AUDIT_PAGE_PATHS,
	ADMIN_TOOL_INVOCATIONS_PAGE_PATHS,
	ADMIN_TOOLS_PAGE_PATHS,
	ADMIN_PLAYGROUND_PAGE_PATHS,
	ADMIN_SIMULATOR_PAGE_PATHS,
	ADMIN_WITHDRAWALS_PAGE_PATHS,
	ADMIN_NFT_MINTS_PAGE_PATHS,
	ADMIN_PRESETS_PAGE_PATHS,
	ADMIN_PROVIDERS_PAGE_PATHS,
	ADMIN_RELIABILITY_PAGE_PATHS,
	ADMIN_ROUTES_PAGE_PATHS,
	ADMIN_USERS_PAGE_PATHS,
	isAdminUserDetailPagePath,
} from './page-paths.ts'

/** Same-origin entry for the first account migration slice. */
export type FetchBinding = {
	fetch(request: Request): Promise<Response>
}

export type WebEntryEnv = {
	CINATOKEN_WEB_PUBLIC_ENABLED?: string
	CINATOKEN_WEB_PUBLIC_ORIGIN?: string
	CINATOKEN_WEB_PROXY_ORIGINS?: string
	ASSETS: FetchBinding
	CINATOKEN_ADMIN_SERVICE: FetchBinding
	CINATOKEN_WEB_ACCOUNT_ENABLED?: string
	CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED?: string
	CINATOKEN_WEB_ADMIN_USERS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED?: string
	CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_MODELS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_ROUTES_ENABLED?: string
	CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED?: string
	CINATOKEN_WEB_ADMIN_PRESETS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED?: string
	CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED?: string
	CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_TOOLS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED?: string
	CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED?: string
	CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED?: string
	CINATOKEN_WEB_ADMIN_CONFIG_ENABLED?: string
	CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_KEYS_ENABLED?: string
	CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED?: string
}

export const ACCOUNT_PAGE_PATHS = new Set([
	'/account',
	'/account/',
	'/account/keys',
	'/account/keys/',
	'/account/byok',
	'/account/byok/',
	'/account/activity',
	'/account/activity/',
	'/account/earnings',
	'/account/earnings/',
	'/account/nft',
	'/account/nft/',
	'/account/withdraw',
	'/account/withdraw/',
	'/account/presets',
	'/account/presets/',
	'/account/guardrails',
	'/account/guardrails/',
	'/account/settings',
	'/account/settings/',
])

const ASSET_PREFIX = '/web-assets/'
const READ_METHODS = new Set(['GET', 'HEAD'])

function shellHeaders(proxyOrigins?: string): Record<string, string> {
	return {
		'cache-control': 'no-store',
		'content-security-policy': [
			"default-src 'self'",
			"script-src 'self' 'unsafe-inline'",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob: https:",
			"media-src 'self' blob:",
			"font-src 'self' data:",
			`connect-src ${webProxyConnectSources(proxyOrigins)}`,
			"worker-src 'self' blob:",
			"object-src 'none'",
			"base-uri 'self'",
			"frame-ancestors 'none'",
			"frame-src 'none'",
			"form-action 'self'",
		].join('; '),
		'cross-origin-opener-policy': 'same-origin',
		'cross-origin-resource-policy': 'same-origin',
		'referrer-policy': 'strict-origin-when-cross-origin',
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
	}
}

function assetRequest(request: Request, pathname: string): Request {
	const url = new URL(request.url)
	url.pathname = pathname
	url.search = ''
	return new Request(url, request)
}

async function accountShell(
	request: Request,
	env: WebEntryEnv
): Promise<Response> {
	let securityHeaders: Record<string, string>
	try {
		securityHeaders = shellHeaders(env.CINATOKEN_WEB_PROXY_ORIGINS)
	} catch {
		return new Response('Web entry is unavailable', {
			status: 503,
			headers: { 'cache-control': 'no-store' },
		})
	}
	const response = await env.ASSETS.fetch(assetRequest(request, '/index.html'))
	if (!response.ok) {
		return new Response('Web entry is unavailable', {
			status: 503,
			headers: { 'cache-control': 'no-store' },
		})
	}
	const headers = new Headers(response.headers)
	for (const [name, value] of Object.entries(securityHeaders)) {
		headers.set(name, value)
	}
	return new Response(request.method === 'HEAD' ? null : response.body, {
		status: response.status,
		headers,
	})
}

export async function routeWebRequest(
	request: Request,
	env: WebEntryEnv
): Promise<Response> {
	const url = new URL(request.url)
	const isRead = READ_METHODS.has(request.method)

	// Keep assets available after rollback for tabs that still have the Web HTML.
	// Missing assets remain asset 404s, with no SPA or backend fallback.
	if (isRead && url.pathname.startsWith(ASSET_PREFIX)) {
		const path = url.pathname.slice(ASSET_PREFIX.length)
		const response = await env.ASSETS.fetch(assetRequest(request, `/${path}`))
		const headers = new Headers(response.headers)
		headers.set('cache-control', assetCacheControl(path, response.status))
		headers.set('x-content-type-options', 'nosniff')
		return new Response(request.method === 'HEAD' ? null : response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		})
	}

	if (isRead && env.CINATOKEN_WEB_PUBLIC_ENABLED === 'true') {
		const { publicHttpRoute } =
			await import('../src/cinatoken/public-server/http-policy')
		if (publicHttpRoute(url)) {
			const { renderPublicResponse, anonymousCatalogFetch } =
				await import('../src/cinatoken/public-server/public-response')
			return renderPublicResponse(request, {
				publicOrigin: env.CINATOKEN_WEB_PUBLIC_ORIGIN,
				proxyOrigins: env.CINATOKEN_WEB_PROXY_ORIGINS,
				anonymousFetch: anonymousCatalogFetch(
					request.url,
					env.CINATOKEN_ADMIN_SERVICE
				),
				readBrowserShell: (shellRequest) => env.ASSETS.fetch(shellRequest),
			})
		}
	}

	const accountEnabled =
		env.CINATOKEN_WEB_ACCOUNT_ENABLED === 'true' &&
		ACCOUNT_PAGE_PATHS.has(url.pathname)
	const dashboardEnabled =
		env.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED === 'true' &&
		ADMIN_DASHBOARD_PAGE_PATHS.has(url.pathname)
	const usersEnabled =
		env.CINATOKEN_WEB_ADMIN_USERS_ENABLED === 'true' &&
		ADMIN_USERS_PAGE_PATHS.has(url.pathname)
	const userDetailEnabled =
		env.CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED === 'true' &&
		isAdminUserDetailPagePath(url.pathname)
	const providersEnabled =
		env.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED === 'true' &&
		ADMIN_PROVIDERS_PAGE_PATHS.has(url.pathname)
	const modelsEnabled =
		env.CINATOKEN_WEB_ADMIN_MODELS_ENABLED === 'true' &&
		ADMIN_MODELS_PAGE_PATHS.has(url.pathname)
	const endpointsEnabled =
		env.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED === 'true' &&
		ADMIN_ENDPOINTS_PAGE_PATHS.has(url.pathname)
	const routesEnabled =
		env.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED === 'true' &&
		ADMIN_ROUTES_PAGE_PATHS.has(url.pathname)
	const dataPoliciesEnabled =
		env.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED === 'true' &&
		ADMIN_DATA_POLICIES_PAGE_PATHS.has(url.pathname)
	const presetsEnabled =
		env.CINATOKEN_WEB_ADMIN_PRESETS_ENABLED === 'true' &&
		ADMIN_PRESETS_PAGE_PATHS.has(url.pathname)
	const guardrailsEnabled =
		env.CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED === 'true' &&
		ADMIN_GUARDRAILS_PAGE_PATHS.has(url.pathname)
	const reliabilityEnabled =
		env.CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED === 'true' &&
		ADMIN_RELIABILITY_PAGE_PATHS.has(url.pathname)
	const modelAnalyticsEnabled =
		env.CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED === 'true' &&
		ADMIN_MODEL_ANALYTICS_PAGE_PATHS.has(url.pathname)
	const providerAnalyticsEnabled =
		env.CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED === 'true' &&
		ADMIN_PROVIDER_ANALYTICS_PAGE_PATHS.has(url.pathname)
	const userAnalyticsEnabled =
		env.CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED === 'true' &&
		ADMIN_USER_ANALYTICS_PAGE_PATHS.has(url.pathname)
	const requestLogsEnabled =
		env.CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED === 'true' &&
		ADMIN_REQUEST_LOGS_PAGE_PATHS.has(url.pathname)
	const budgetAuditEnabled =
		env.CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED === 'true' &&
		ADMIN_BUDGET_AUDIT_PAGE_PATHS.has(url.pathname)
	const toolInvocationsEnabled =
		env.CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED === 'true' &&
		ADMIN_TOOL_INVOCATIONS_PAGE_PATHS.has(url.pathname)
	const toolsEnabled =
		env.CINATOKEN_WEB_ADMIN_TOOLS_ENABLED === 'true' &&
		ADMIN_TOOLS_PAGE_PATHS.has(url.pathname)
	const playgroundEnabled =
		env.CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED === 'true' &&
		ADMIN_PLAYGROUND_PAGE_PATHS.has(url.pathname)
	const simulatorEnabled =
		env.CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED === 'true' &&
		ADMIN_SIMULATOR_PAGE_PATHS.has(url.pathname)
	const withdrawalsEnabled =
		env.CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED === 'true' &&
		ADMIN_WITHDRAWALS_PAGE_PATHS.has(url.pathname)
	const nftMintsEnabled =
		env.CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED === 'true' &&
		ADMIN_NFT_MINTS_PAGE_PATHS.has(url.pathname)
	const configTimezoneEnabled =
		env.CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED === 'true' &&
		ADMIN_CONFIG_TIMEZONE_PAGE_PATHS.has(url.pathname)
	const configEnabled =
		env.CINATOKEN_WEB_ADMIN_CONFIG_ENABLED === 'true' &&
		ADMIN_CONFIG_PAGE_PATHS.has(url.pathname)
	const accessKeysEnabled =
		env.CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED === 'true' &&
		ADMIN_ACCESS_KEYS_PAGE_PATHS.has(url.pathname)
	const keysEnabled =
		env.CINATOKEN_WEB_ADMIN_KEYS_ENABLED === 'true' &&
		ADMIN_KEYS_PAGE_PATHS.has(url.pathname)
	const sharedKeysEnabled =
		env.CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED === 'true' &&
		ADMIN_SHARED_KEYS_PAGE_PATHS.has(url.pathname)
	if (
		isRead &&
		(accountEnabled ||
			dashboardEnabled ||
			usersEnabled ||
			userDetailEnabled ||
			providersEnabled ||
			modelsEnabled ||
			endpointsEnabled ||
			routesEnabled ||
			dataPoliciesEnabled ||
			presetsEnabled ||
			guardrailsEnabled ||
			reliabilityEnabled ||
			modelAnalyticsEnabled ||
			providerAnalyticsEnabled ||
			userAnalyticsEnabled ||
			requestLogsEnabled ||
			budgetAuditEnabled ||
			toolInvocationsEnabled ||
			toolsEnabled ||
			playgroundEnabled ||
			simulatorEnabled ||
			withdrawalsEnabled ||
			nftMintsEnabled ||
			configTimezoneEnabled ||
			configEnabled ||
			accessKeysEnabled ||
			keysEnabled ||
			sharedKeysEnabled)
	) {
		return accountShell(request, env)
	}

	// Service bindings accept the public Request. Do not rewrite its origin,
	// consume the body, reconstruct headers, or rebuild the returned Response:
	// Cookie Origin checks, redirects, Set-Cookie, streams and WebSockets belong
	// to the existing Admin service.
	return env.CINATOKEN_ADMIN_SERVICE.fetch(request)
}

export default { fetch: routeWebRequest }
