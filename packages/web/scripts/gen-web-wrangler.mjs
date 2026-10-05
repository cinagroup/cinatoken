#!/usr/bin/env node
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyRelease } from './package-release.mjs'
import { parseWebProxyOrigins } from './proxy-origin-policy.mjs'
import { publicSiteOrigin } from './public-origin-policy.mjs'

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function booleanEnv(env, name) {
	const value = (env[name] ?? '').trim().toLowerCase()
	if (!value || value === 'false') return false
	if (value === 'true') return true
	throw new Error(`${name} must be true or false`)
}

function workerName(env, name, fallback) {
	const value = (env[name] ?? '').trim() || fallback
	if (!/^[a-zA-Z0-9-]+$/.test(value)) {
		throw new Error(`${name} must be a Worker name, not a URL`)
	}
	return value
}

/** ADMIN_WORKER_NAME follows scripts/deploy/gen-wrangler.mjs. */
export function createWebWranglerConfig(
	env = process.env,
	assetsDirectory = './dist',
	serverEntry = null
) {
	const name = workerName(env, 'WEB_WORKER_NAME', 'cinatoken-web')
	const adminName = workerName(env, 'ADMIN_WORKER_NAME', 'cinatoken-admin')
	if (name === adminName) {
		throw new Error('WEB_WORKER_NAME must differ from ADMIN_WORKER_NAME')
	}
	const domain = (env.WEB_CUSTOM_DOMAIN ?? '').trim()
	const publicEnabled = booleanEnv(env, 'CINATOKEN_WEB_PUBLIC_ENABLED')
	const publicOrigin = env.CINATOKEN_WEB_PUBLIC_ORIGIN
		? publicSiteOrigin(env.CINATOKEN_WEB_PUBLIC_ORIGIN)
		: ''
	if (publicEnabled && (!serverEntry || !publicOrigin))
		throw new Error(
			'Public SSR requires a verified server artifact and trusted HTTPS origin'
		)
	if (
		domain &&
		!/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/.test(
			domain
		)
	) {
		throw new Error(
			'WEB_CUSTOM_DOMAIN must be a hostname without scheme, port or path'
		)
	}
	return {
		$schema: '../../node_modules/wrangler/config-schema.json',
		name,
		main: serverEntry || 'edge/worker.ts',
		...(serverEntry ? { no_bundle: true } : {}),
		compatibility_date: '2026-09-27',
		compatibility_flags: ['enable_request_signal'],
		workers_dev: false,
		routes: domain ? [{ pattern: domain, custom_domain: true }] : [],
		assets: {
			directory: assetsDirectory,
			binding: 'ASSETS',
			run_worker_first: true,
			html_handling: 'none',
			not_found_handling: 'none',
		},
		services: [
			{
				binding: 'CINATOKEN_ADMIN_SERVICE',
				service: adminName,
			},
		],
		vars: {
			CINATOKEN_WEB_PUBLIC_ENABLED: String(publicEnabled),
			CINATOKEN_WEB_PUBLIC_ORIGIN: publicOrigin,
			CINATOKEN_WEB_PROXY_ORIGINS: parseWebProxyOrigins(
				env.CINATOKEN_WEB_PROXY_ORIGINS
			).join(','),
			CINATOKEN_WEB_ACCOUNT_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ACCOUNT_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_USERS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_USERS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_MODELS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_MODELS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_ROUTES_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_ROUTES_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_PRESETS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_PRESETS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_CONFIG_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_KEYS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_KEYS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_TOOLS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED')
			),
			CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED: String(
				booleanEnv(env, 'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED')
			),
		},
		observability: { enabled: true },
	}
}

// Production accepts only the verified immutable artifact, never a mutable dist.
export function resolveWebAssets(argv, root = resolve(webRoot, '../..')) {
	if (argv.length === 1 && argv[0] === '--development') return './dist'
	if (argv.length === 2 && argv[0] === '--release') {
		const release = verifyRelease(root, argv[1])
		return relative(join(root, 'packages/web'), release.assets)
			.split('\\')
			.join('/')
	}
	throw new Error(
		'Use --release ID for production, or explicit --development for local preview/dry-run'
	)
}

export function resolveWebServer(argv, root = resolve(webRoot, '../..')) {
	if (argv.length === 1 && argv[0] === '--development') {
		return existsSync(join(root, 'packages/web/dist-server/worker/index.mjs'))
			? './dist-server/worker/index.mjs'
			: null
	}
	if (argv.length === 2 && argv[0] === '--release') {
		const release = verifyRelease(root, argv[1])
		return release.server
			? relative(
					join(root, 'packages/web'),
					join(release.server, 'worker/index.mjs')
				)
					.split('\\')
					.join('/')
			: null
	}
	throw new Error('Use an explicit verified release or development mode')
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	try {
		const assets = resolveWebAssets(process.argv.slice(2))
		const server = resolveWebServer(process.argv.slice(2))
		const target = join(webRoot, 'wrangler.web.jsonc')
		writeFileSync(
			target,
			`${JSON.stringify(
				createWebWranglerConfig(process.env, assets, server),
				null,
				2
			)}\n`
		)
		process.stdout.write(
			'Generated packages/web/wrangler.web.jsonc (no deployment performed)\n'
		)
	} catch (error) {
		process.stderr.write(`${error.message}\n`)
		process.exitCode = 1
	}
}
