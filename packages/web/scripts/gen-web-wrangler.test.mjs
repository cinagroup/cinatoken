import assert from 'node:assert/strict'
import test from 'node:test'
import {
	createWebWranglerConfig,
	resolveWebAssets,
} from './gen-web-wrangler.mjs'

test('trusted Proxy origins become a validated canonical Worker variable without enabling rollout', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_PROXY_ORIGINS:
			'https://proxy.example.com:9443, http://localhost:8787,https://proxy.example.com:9443',
	})
	assert.equal(
		config.vars.CINATOKEN_WEB_PROXY_ORIGINS,
		'https://proxy.example.com:9443,http://localhost:8787'
	)
	assert.equal(
		Object.entries(config.vars).filter(
			([name, value]) => name.endsWith('_ENABLED') && value === 'false'
		).length,
		29
	)
	assert.deepEqual(config.routes, [])
	assert.deepEqual(config.services, [
		{ binding: 'CINATOKEN_ADMIN_SERVICE', service: 'cinatoken-admin' },
	])
})

test('invalid Proxy origins abort config generation with a generic non-revealing error', () => {
	for (const origin of [
		'https://user:secret@proxy.example.com',
		'http://proxy.example.com',
		'https://proxy.example.com/v1',
		'https://proxy.example.com; connect-src *',
	]) {
		assert.throws(
			() => createWebWranglerConfig({ CINATOKEN_WEB_PROXY_ORIGINS: origin }),
			(error) =>
				error.message ===
				'CINATOKEN_WEB_PROXY_ORIGINS must contain at most 16 trusted HTTP(S) origins'
		)
	}
})

test('CLI requires an explicit verified release or development mode', () => {
	assert.equal(resolveWebAssets(['--development']), './dist')
	for (const args of [
		[],
		['--release'],
		['--development', '--release', 'x'],
		['--release', '../escape'],
	]) {
		assert.throws(() => resolveWebAssets(args), /Use --release|Release id/)
	}
	assert.equal(
		createWebWranglerConfig({}, '../../.release/web/v1/assets').assets
			.directory,
		'../../.release/web/v1/assets'
	)
})

test('Web config defaults to disabled rollout and has no public route assignment', () => {
	const config = createWebWranglerConfig({})
	const flags = Object.entries(config.vars).filter(([name]) =>
		name.endsWith('_ENABLED')
	)
	assert.equal(flags.length, 29)
	assert.ok(flags.every(([, value]) => value === 'false'))
	assert.equal(config.vars.CINATOKEN_WEB_PROXY_ORIGINS, '')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_MODELS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PRESETS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED, 'false')
	assert.equal(
		config.vars.CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED,
		'false'
	)
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED, 'false')
	assert.equal(
		config.vars.CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED,
		'false'
	)
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_CONFIG_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_KEYS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_TOOLS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED, 'false')
	assert.equal(config.workers_dev, false)
	assert.deepEqual(config.routes, [])
	assert.equal(config.assets.run_worker_first, true)
	assert.equal(config.assets.html_handling, 'none')
	assert.equal(config.assets.not_found_handling, 'none')
	assert.equal(config.assets.directory, './dist')
})

test('configured names use the root deployment ADMIN_WORKER_NAME convention', () => {
	const config = createWebWranglerConfig({
		ADMIN_WORKER_NAME: 'gateway-admin-fixture',
		WEB_WORKER_NAME: 'gateway-web-fixture',
		WEB_CUSTOM_DOMAIN: 'gateway.example.com',
		CINATOKEN_WEB_ACCOUNT_ENABLED: 'true',
	})
	assert.equal(config.name, 'gateway-web-fixture')
	assert.deepEqual(config.services, [
		{ binding: 'CINATOKEN_ADMIN_SERVICE', service: 'gateway-admin-fixture' },
	])
	assert.deepEqual(config.routes, [
		{ pattern: 'gateway.example.com', custom_domain: true },
	])
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'true')
	assert.equal(
		config.services.some((service) => 'remote' in service),
		false
	)
})

test('invalid flags and URL-like binding names fail generation', () => {
	assert.throws(
		() =>
			createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() => createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_USERS_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_MODELS_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_ROUTES_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({
				CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED: 'yes',
			}),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({
				CINATOKEN_WEB_ADMIN_PRESETS_ENABLED: 'yes',
			}),
		/true or false/
	)
	for (const flag of [
		'CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED',
		'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED',
		'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED',
		'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED',
		'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED',
		'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED',
		'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED',
		'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED',
		'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED',
		'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED',
		'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED',
		'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED',
		'CINATOKEN_WEB_ADMIN_KEYS_ENABLED',
		'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED',
		'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED',
		'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED',
		'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED',
		'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED',
		'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED',
	]) {
		assert.throws(
			() => createWebWranglerConfig({ [flag]: 'yes' }),
			/true or false/
		)
	}
	assert.throws(
		() =>
			createWebWranglerConfig({ CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() => createWebWranglerConfig({ CINATOKEN_WEB_ACCOUNT_ENABLED: 'yes' }),
		/true or false/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({
				ADMIN_WORKER_NAME: 'https://internal.example.com',
			}),
		/Worker name/
	)
	assert.throws(
		() =>
			createWebWranglerConfig({
				WEB_CUSTOM_DOMAIN: 'https://gateway.example.com/path',
			}),
		/hostname/
	)
	assert.throws(
		() => createWebWranglerConfig({ WEB_WORKER_NAME: 'web_fixture' }),
		/Worker name/
	)
	assert.throws(
		() => createWebWranglerConfig({ WEB_WORKER_NAME: 'cinatoken-admin' }),
		/must differ/
	)
})

test('Dashboard can opt in independently of other Admin and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_CONFIG_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Users can opt in independently of Dashboard and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_USERS_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USERS_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('User Detail can opt in independently of the Users list', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_USERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Providers can opt in while account pages keep the legacy entry', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Models can opt in independently of Providers and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_MODELS_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_MODELS_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Endpoints can opt in independently of Models, Providers and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_MODELS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Routes can opt in independently of other Console resources and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_ROUTES_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_MODELS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Data Policies can opt in independently of other Console resources and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

test('Presets can opt in independently of other Console resources and account pages', () => {
	const config = createWebWranglerConfig({
		CINATOKEN_WEB_ADMIN_PRESETS_ENABLED: 'true',
	})
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_PRESETS_ENABLED, 'true')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED, 'false')
	assert.equal(config.vars.CINATOKEN_WEB_ACCOUNT_ENABLED, 'false')
	assert.deepEqual(config.routes, [])
})

for (const flag of [
	'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED',
	'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED',
	'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED',
	'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED',
	'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED',
	'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED',
	'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED',
	'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED',
	'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED',
	'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED',
	'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED',
	'CINATOKEN_WEB_ADMIN_KEYS_ENABLED',
	'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED',
	'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED',
	'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED',
	'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED',
	'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED',
	'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED',
]) {
	test(`${flag} opts in independently of other Console resources`, () => {
		const config = createWebWranglerConfig({ [flag]: 'true' })
		assert.equal(config.vars[flag], 'true')
		for (const other of [
			'CINATOKEN_WEB_ACCOUNT_ENABLED',
			'CINATOKEN_WEB_ADMIN_USERS_ENABLED',
			'CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED',
			'CINATOKEN_WEB_ADMIN_PRESETS_ENABLED',
			'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED',
			'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED',
			'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED',
			'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED',
			'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED',
			'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED',
			'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED',
			'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED',
			'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED',
			'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED',
			'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED',
			'CINATOKEN_WEB_ADMIN_KEYS_ENABLED',
			'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED',
			'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED',
			'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED',
			'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED',
			'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED',
			'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED',
		]) {
			if (other !== flag) assert.equal(config.vars[other], 'false')
		}
		assert.deepEqual(config.routes, [])
	})
}
