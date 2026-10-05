import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

function loadNextHeaders(origins) {
	const configUrl = new URL('../../admin/next.config.mjs', import.meta.url).href
	return spawnSync(
		process.execPath,
		[
			'--input-type=module',
			'-e',
			`const config = (await import(${JSON.stringify(configUrl)})).default; console.log(JSON.stringify(await config.headers()))`,
		],
		{
			env: {
				...process.env,
				NODE_ENV: 'production',
				CINATOKEN_WEB_PROXY_ORIGINS: origins,
			},
			encoding: 'utf8',
		}
	)
}

test('actual Next headers preserve existing security and precise diagnostic microphone rules', () => {
	const result = loadNextHeaders('https://proxy.example.com:9443')
	assert.equal(result.status, 0, result.stderr)
	const routes = JSON.parse(result.stdout)
	for (const source of ['/api/:path*', '/:path*']) {
		const route = routes.find((item) => item.source === source)
		assert.ok(route)
		const csp = route.headers.find(
			(header) => header.key === 'Content-Security-Policy'
		).value
		assert.ok(
			csp.includes(
				"connect-src 'self' wss: https://proxy.example.com:9443 wss://proxy.example.com:9443 https://auth.cinaseek.si https://accounts.cinaseek.si;"
			)
		)
		assert.ok(csp.includes("media-src 'self' blob:"))
		assert.ok(csp.includes('upgrade-insecure-requests'))
		assert.ok(csp.includes("frame-ancestors 'none'"))
		assert.equal(
			route.headers.find((header) => header.key === 'Permissions-Policy').value,
			'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
		)
	}
	const diagnostics = routes.filter((route) =>
		[
			'/gateway/playground',
			'/gateway/simulator',
			'/admin/playground',
			'/admin/simulator',
		].includes(route.source)
	)
	assert.equal(diagnostics.length, 4)
	for (const route of diagnostics) {
		assert.deepEqual(route.headers, [
			{
				key: 'Permissions-Policy',
				value:
					'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
			},
		])
	}
})

test('Next default adds no HTTP allowance and rejects unsafe build configuration', () => {
	const empty = loadNextHeaders('')
	assert.equal(empty.status, 0, empty.stderr)
	const csp = JSON.parse(empty.stdout)[0].headers.find(
		(header) => header.key === 'Content-Security-Policy'
	).value
	assert.ok(
		csp.includes(
			"connect-src 'self' wss: https://auth.cinaseek.si https://accounts.cinaseek.si;"
		)
	)
	const invalid = loadNextHeaders('https://user:do-not-echo@proxy.example.com')
	assert.notEqual(invalid.status, 0)
	assert.match(invalid.stderr, /CINATOKEN_WEB_PROXY_ORIGINS/)
	assert.doesNotMatch(invalid.stderr, /do-not-echo/)
})
