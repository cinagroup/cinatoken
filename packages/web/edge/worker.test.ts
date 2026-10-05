import assert from 'node:assert/strict'
import test from 'node:test'
import { publicCatalogHttpFixture } from '../src/cinatoken/public-server/public-http.fixture'
import { routeWebRequest, type WebEntryEnv } from './worker.ts'

const accountPaths = [
	'/account',
	'/account/keys',
	'/account/byok',
	'/account/activity',
	'/account/earnings',
	'/account/nft',
	'/account/withdraw',
	'/account/presets',
	'/account/guardrails',
	'/account/settings',
].flatMap((path) => [path, `${path}/`])

function fixture(enabled = 'true') {
	const assets: Request[] = []
	const admin: Request[] = []
	const backendResponse = new Response('next response', { status: 200 })
	const env: WebEntryEnv = {
		CINATOKEN_WEB_ACCOUNT_ENABLED: enabled,
		ASSETS: {
			async fetch(request) {
				assets.push(request)
				const pathname = new URL(request.url).pathname
				if (pathname === '/index.html') {
					return new Response('<html>account shell</html>', {
						headers: { 'content-type': 'text/html' },
					})
				}
				return new Response(pathname, {
					status: pathname.includes('missing') ? 404 : 200,
				})
			},
		},
		CINATOKEN_ADMIN_SERVICE: {
			async fetch(request) {
				admin.push(request)
				return backendResponse
			},
		},
	}
	return { env, assets, admin, backendResponse }
}

function publicFixture() {
	const f = fixture()
	f.env.CINATOKEN_WEB_PUBLIC_ENABLED = 'true'
	f.env.CINATOKEN_WEB_PUBLIC_ORIGIN = 'https://canonical.example'
	f.env.ASSETS.fetch = async (request) => {
		f.assets.push(request)
		return new Response(
			'<html><link rel="stylesheet" href="/web-assets/static/css/index.123.css"><script defer src="/web-assets/static/js/index.123.js"></script><div id="root"></div></html>',
			{ headers: { 'content-type': 'text/html' } }
		)
	}
	f.env.CINATOKEN_ADMIN_SERVICE.fetch = async (request) => {
		f.admin.push(request)
		return Response.json(publicCatalogHttpFixture(request.url), {
			headers: { 'set-cookie': 'upstream_private=fixture; HttpOnly' },
		})
	}
	return f
}

test('Web private HTML keeps no-store and its CSP while prohibiting transformations', async () => {
	const f = fixture()
	f.env.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED = 'true'
	f.env.ASSETS.fetch = async () =>
		new Response('<html>private shell</html>', {
			headers: {
				'content-type': 'Text/HTML; charset=utf-8',
				'cache-control': 'public, max-age=31536000',
			},
		})
	for (const path of ['/account', '/admin']) {
		for (const method of ['GET', 'HEAD']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}`, { method }),
				f.env
			)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				response.headers.get('content-security-policy'),
				[
					"default-src 'self'",
					"script-src 'self' 'unsafe-inline'",
					"style-src 'self' 'unsafe-inline'",
					"img-src 'self' data: blob: https:",
					"media-src 'self' blob:",
					"font-src 'self' data:",
					"connect-src 'self' wss:",
					"worker-src 'self' blob:",
					"object-src 'none'",
					"base-uri 'self'",
					"frame-ancestors 'none'",
					"frame-src 'none'",
					"form-action 'self'",
				].join('; ')
			)
			assert.equal(response.headers.get('x-frame-options'), 'DENY')
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>private shell</html>'
			)
		}
	}
	assert.equal(f.admin.length, 0)
})

test('Web public HTML preserves nonce, anonymous catalog and HEAD contracts without caching', async () => {
	const f = publicFixture()
	const nonces = new Set<string>()
	for (const method of ['GET', 'HEAD']) {
		const response = await routeWebRequest(
			new Request('https://gateway.example.com/en/models', {
				method,
				headers: {
					cookie: 'admin_session=private-marker',
					authorization: 'Bearer secret-marker',
				},
			}),
			f.env
		)
		assert.equal(response.status, 200)
		assert.equal(
			response.headers.get('cache-control'),
			'no-store, no-transform'
		)
		assert.equal(response.headers.get('set-cookie'), null)
		assert.equal(response.bodyUsed, false)
		const csp = response.headers.get('content-security-policy') ?? ''
		const nonce = /'nonce-([^']+)'/.exec(csp)?.[1]
		assert.ok(nonce)
		nonces.add(nonce)
		assert.ok(csp.includes("default-src 'self'"))
		assert.ok(csp.includes("object-src 'none'"))
		assert.equal(csp.includes("script-src 'self' 'unsafe-inline'"), false)
		const html = await response.text()
		if (method === 'HEAD') {
			assert.equal(response.body, null)
			assert.equal(html, '')
		} else {
			assert.match(html, /HTTP authority model/)
			const scripts = [...html.matchAll(/<script\b([^>]*)>/g)]
			assert.ok(scripts.length >= 4)
			for (const script of scripts)
				assert.ok(script[1].includes(`nonce="${nonce}"`))
			assert.doesNotMatch(html, /private-marker|secret-marker|upstream_private/)
		}
	}
	assert.equal(nonces.size, 2)
	assert.equal(f.admin.length, 2)
	for (const read of f.admin) {
		assert.equal(read.method, 'GET')
		assert.equal(read.credentials, 'omit')
		assert.equal(read.redirect, 'manual')
		assert.deepEqual([...read.headers], [['accept', 'application/json']])
	}
})

test('Web redirects, robots, XML and plain failures retain their existing cache policy', async () => {
	const f = publicFixture()
	for (const method of ['GET', 'HEAD']) {
		for (const [path, status, contentType] of [
			['/', 308, null],
			['/robots.txt', 200, 'text/plain; charset=utf-8'],
			['/sitemap.xml', 200, 'application/xml; charset=utf-8'],
		] as const) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}`, { method }),
				f.env
			)
			assert.equal(response.status, status)
			assert.equal(response.headers.get('content-type'), contentType)
			assert.equal(response.headers.get('cache-control'), 'no-store')
			if (method === 'HEAD') assert.equal(response.body, null)
			else await response.text()
		}
	}
	f.env.ASSETS.fetch = async () => new Response('missing', { status: 404 })
	const unavailable = await routeWebRequest(
		new Request('https://gateway.example.com/en/models'),
		f.env
	)
	assert.equal(unavailable.status, 503)
	assert.equal(
		unavailable.headers.get('content-type'),
		'text/plain; charset=utf-8'
	)
	assert.equal(unavailable.headers.get('cache-control'), 'no-store')
	assert.equal(unavailable.headers.get('retry-after'), '30')
})

test('HTML policy leaves backend HTML, API, OAuth and asset responses unchanged', async () => {
	const f = fixture()
	f.env.CINATOKEN_WEB_PUBLIC_ENABLED = 'true'
	for (const [path, contentType] of [
		['/dashboard', 'text/html; charset=utf-8'],
		['/api/user/me', 'application/json'],
		['/api/auth/cinaauth/callback', 'text/html'],
	] as const) {
		const headers = new Headers({
			'content-type': contentType,
			'cache-control': 'private, no-store',
			'content-security-policy': "script-src 'nonce-upstream-only'",
		})
		headers.append('set-cookie', 'session=fixture; HttpOnly; Secure')
		headers.append('set-cookie', 'oidc=; Max-Age=0')
		const upstream = new Response('untouched upstream', { headers })
		f.env.CINATOKEN_ADMIN_SERVICE.fetch = async (request) => {
			f.admin.push(request)
			return upstream
		}
		const request = new Request(`https://gateway.example.com${path}`)
		const response = await routeWebRequest(request, f.env)
		assert.equal(response, upstream)
		assert.equal(f.admin.at(-1), request)
		assert.equal(response.bodyUsed, false)
		assert.equal(response.headers.get('cache-control'), 'private, no-store')
		assert.deepEqual([...response.headers], [...headers])
		assert.equal(response.headers.getSetCookie().length, 2)
	}
	for (const [path, status, cacheControl] of [
		[
			'/web-assets/static/js/app.12345678.js',
			200,
			'public, max-age=31536000, immutable',
		],
		['/web-assets/index.html', 200, 'no-store'],
		['/web-assets/missing.js', 404, 'no-store'],
	] as const) {
		const response = await routeWebRequest(
			new Request(`https://gateway.example.com${path}`),
			f.env
		)
		assert.equal(response.status, status)
		assert.equal(response.headers.get('cache-control'), cacheControl)
	}
})

test('configured Proxy origins apply to every shell for later SPA diagnostics navigation', async () => {
	const f = fixture()
	f.env.CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED = 'true'
	f.env.CINATOKEN_WEB_PROXY_ORIGINS =
		'https://proxy.example.com:9443,http://localhost:8787'
	for (const path of ['/account', '/admin/simulator']) {
		const response = await routeWebRequest(
			new Request(`https://gateway.example.com${path}`),
			f.env
		)
		const csp = response.headers.get('content-security-policy')
		assert.ok(csp)
		assert.ok(
			csp.includes(
				"connect-src 'self' wss: https://proxy.example.com:9443 http://localhost:8787 wss://proxy.example.com:9443 ws://localhost:8787;"
			)
		)
		assert.ok(csp.includes("media-src 'self' blob:"))
		assert.ok(csp.includes("object-src 'none'"))
		assert.equal(response.headers.get('x-frame-options'), 'DENY')
	}
	assert.equal(f.admin.length, 0)
})

test('empty Proxy configuration keeps the original shell connection policy', async () => {
	const f = fixture()
	const response = await routeWebRequest(
		new Request('https://gateway.example.com/account'),
		f.env
	)
	assert.ok(
		response.headers
			.get('content-security-policy')
			?.includes("connect-src 'self' wss:;")
	)
})

test('invalid Proxy configuration fails only opted-in shells and does not leak or alter API forwarding', async () => {
	const f = fixture()
	f.env.CINATOKEN_WEB_PROXY_ORIGINS =
		'https://user:do-not-echo@proxy.example.com; connect-src *'
	const shell = await routeWebRequest(
		new Request('https://gateway.example.com/account'),
		f.env
	)
	assert.equal(shell.status, 503)
	assert.equal(shell.headers.get('cache-control'), 'no-store')
	assert.equal(await shell.text(), 'Web entry is unavailable')
	assert.equal(f.assets.length, 0)
	const request = new Request('https://gateway.example.com/api/admin/keys', {
		method: 'POST',
		body: '{"unchanged":true}',
	})
	assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	assert.equal(f.admin[0], request)
})

test('Dashboard rollout captures only exact GET/HEAD /admin paths and is independently disabled', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin', '/admin/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?range=7d`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/dashboard',
		'/admin/providers',
		'/admin/config',
		'/admin/detail',
		'/admin//',
		'/ad%6din',
		'/api/admin/stats',
		'/account',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_DASHBOARD_ENABLED = value
		const request = new Request('https://gateway.example.com/admin')
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
})

test('Users rollout captures only exact GET/HEAD list paths and stays independent', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_USERS_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/users', '/admin/users/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?page=2`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin',
		'/admin/users/123',
		'/admin/users//',
		'/admin/%75sers',
		'/api/admin/users',
		'/account',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/users', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_USERS_ENABLED = value
		const request = new Request('https://gateway.example.com/admin/users')
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
})

test('User Detail rollout captures only UUID and simple canonical ext GET/HEAD paths', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED = 'true'
	const id = 'f2b74bc0-32f3-4613-aea7-96f723d08e12'
	for (const method of ['GET', 'HEAD']) {
		for (const path of [
			`/admin/users/${id}`,
			`/admin/users/${id}/`,
			'/admin/users/ext%3Aerp%2F42',
			'/admin/users/ext%3Aerp%2F42/',
		]) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?keep=1`, { method }),
				f.env
			)
			assert.equal(response.status, 200, `${method} ${path}`)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/users',
		'/admin/users/',
		'/admin/users/123',
		`/admin/users/${id}/keys`,
		`/admin/users/${id}//`,
		`/admin/users/${id}%2Fkeys`,
		`/admin/users/${id}%252Fkeys`,
		'/admin/users/ext%3Aerp%2Fabc%252F42',
		'/admin/users/ext%3Aerp%2Fabc%2F42',
		'/admin/users/ext%3Aerp%2Fa%0Ab',
		'/admin/users/ext%3Aerp%1F42',
		'/admin/users/ext%3Aerp%2F',
		'/admin/users/ext%3A%2F42',
		'/admin/users/ext%3Aerp%2F42/keys',
		'/admin/users/ext:erp/42',
		'/admin/users/ext%3aerp%2f42',
		`/admin/%75sers/${id}`,
		`/ADMIN/users/${id}`,
		`/api/admin/users/${id}`,
		'/admin/users-extra',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse, path)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
		const request = new Request(
			`https://gateway.example.com/admin/users/${id}`,
			{
				method,
				body: '{}',
			}
		)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_USER_DETAIL_ENABLED = value
		const request = new Request(`https://gateway.example.com/admin/users/${id}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
})

test('Providers rollout is independent and only captures its exact GET/HEAD paths', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/providers', '/admin/providers/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=alpha`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/account',
		'/admin',
		'/admin/models',
		'/admin/providers/detail',
		'/admin/providers//',
		'/admin/%70roviders',
		'/api/admin/providers',
		'/api/public/catalog/providers',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/providers', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_PROVIDERS_ENABLED = value
		assert.equal(
			await routeWebRequest(
				new Request('https://gateway.example.com/admin/providers'),
				f.env
			),
			f.backendResponse
		)
	}
})

test('all twenty approved account paths serve the Web shell', async () => {
	const f = fixture()
	for (const pathname of accountPaths) {
		const response = await routeWebRequest(
			new Request(`https://gateway.example.com${pathname}?tab=keys`),
			f.env
		)
		assert.equal(await response.text(), '<html>account shell</html>')
		assert.equal(
			response.headers.get('cache-control'),
			'no-store, no-transform'
		)
		assert.equal(
			response.headers.get('cross-origin-opener-policy'),
			'same-origin'
		)
		assert.match(
			response.headers.get('content-security-policy') ?? '',
			/default-src 'self'/
		)
		assert.equal(f.assets.at(-1)?.url, 'https://gateway.example.com/index.html')
	}
	assert.equal(f.admin.length, 0)
})

test('Models rollout only serves its exact GET/HEAD page, with other routes preserved', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_MODELS_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/models', '/admin/models/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=test`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/providers',
		'/account',
		'/models',
		'/chat',
		'/admin/models/detail',
		'/admin/models//',
		'/admin/%6dodels',
		'/api/admin/models',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/models', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_MODELS_ENABLED = value
		assert.equal(
			await routeWebRequest(
				new Request('https://gateway.example.com/admin/models'),
				f.env
			),
			f.backendResponse
		)
	}
})

test('Endpoints rollout only serves its exact GET/HEAD page, with other routes preserved', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/endpoints', '/admin/endpoints/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=test`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/providers',
		'/admin/models',
		'/account',
		'/admin/endpoints/detail',
		'/admin/endpoints//',
		'/admin/%65ndpoints',
		'/api/admin/endpoints',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/endpoints', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_ENDPOINTS_ENABLED = value
		assert.equal(
			await routeWebRequest(
				new Request('https://gateway.example.com/admin/endpoints'),
				f.env
			),
			f.backendResponse
		)
	}
})

test('Routes rollout only captures its exact GET/HEAD page and is independently disabled', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/routes', '/admin/routes/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=alpha`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/providers',
		'/admin/models',
		'/admin/endpoints',
		'/account',
		'/admin/routes/detail',
		'/admin/routes//',
		'/admin/%72outes',
		'/api/admin/routes',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/routes', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_ROUTES_ENABLED = value
		assert.equal(
			await routeWebRequest(
				new Request('https://gateway.example.com/admin/routes'),
				f.env
			),
			f.backendResponse
		)
	}
})

test('Data Policies rollout only captures its exact GET/HEAD page and is independently disabled', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/data-policies', '/admin/data-policies/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=alpha`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/providers',
		'/admin/routes',
		'/account',
		'/admin/data-policies/detail',
		'/admin/data-policies//',
		'/admin/%64ata-policies',
		'/api/admin/data-policies',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request(
			'https://gateway.example.com/admin/data-policies',
			{
				method,
				body: '{}',
			}
		)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_DATA_POLICIES_ENABLED = value
		assert.equal(
			await routeWebRequest(
				new Request('https://gateway.example.com/admin/data-policies'),
				f.env
			),
			f.backendResponse
		)
	}
})

test('Presets rollout only captures its exact GET/HEAD page and is independently disabled', async () => {
	const f = fixture('false')
	f.env.CINATOKEN_WEB_ADMIN_PRESETS_ENABLED = 'true'
	for (const method of ['GET', 'HEAD']) {
		for (const path of ['/admin/presets', '/admin/presets/']) {
			const response = await routeWebRequest(
				new Request(`https://gateway.example.com${path}?q=alpha`, { method }),
				f.env
			)
			assert.equal(response.status, 200)
			assert.equal(
				response.headers.get('cache-control'),
				'no-store, no-transform'
			)
			assert.equal(
				await response.text(),
				method === 'HEAD' ? '' : '<html>account shell</html>'
			)
		}
	}
	for (const path of [
		'/admin/data-policies',
		'/admin/routes',
		'/account',
		'/admin/presets/detail',
		'/admin/presets//',
		'/admin/%70resets',
		'/api/admin/presets',
	]) {
		const request = new Request(`https://gateway.example.com${path}`)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const method of ['POST', 'PATCH', 'DELETE']) {
		const request = new Request('https://gateway.example.com/admin/presets', {
			method,
			body: '{}',
		})
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	for (const value of [undefined, '', 'false', 'TRUE', '1']) {
		f.env.CINATOKEN_WEB_ADMIN_PRESETS_ENABLED = value
		const request = new Request('https://gateway.example.com/admin/presets')
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	const asset = await routeWebRequest(
		new Request(
			'https://gateway.example.com/web-assets/static/js/app.12345678.js'
		),
		f.env
	)
	assert.equal(asset.status, 200)
	assert.equal(await asset.text(), '/static/js/app.12345678.js')
	assert.equal(
		new URL(f.assets.at(-1)!.url).pathname,
		'/static/js/app.12345678.js'
	)
})

for (const rollout of [
	{
		name: 'Withdrawals',
		flag: 'CINATOKEN_WEB_ADMIN_WITHDRAWALS_ENABLED',
		path: '/admin/withdrawals',
		unmigrated: [
			'/gateway/withdrawals',
			'/admin/withdrawals/process',
			'/admin/withdrawals/row-1/reject',
			'/admin/withdrawals-extra',
			'/admin/withdrawals//',
			'/admin/%77ithdrawals',
			'/admin/withdrawals%2f',
			'/admin//withdrawals',
			'/api/admin/withdrawals',
			'/api/admin/withdrawals/process',
			'/admin/nft-mints',
		],
	},
	{
		name: 'NFT Mints',
		flag: 'CINATOKEN_WEB_ADMIN_NFT_MINTS_ENABLED',
		path: '/admin/nft-mints',
		unmigrated: [
			'/gateway/nft-mints',
			'/admin/nft-mints/process',
			'/admin/nft-mints/row-1/reject',
			'/admin/nft-mints-extra',
			'/admin/nft-mints//',
			'/admin/%6eft-mints',
			'/admin/nft-mints%2f',
			'/admin//nft-mints',
			'/api/admin/nft-mints',
			'/api/admin/nft-mints/process',
			'/admin/withdrawals',
		],
	},
	{
		name: 'Playground',
		flag: 'CINATOKEN_WEB_ADMIN_PLAYGROUND_ENABLED',
		path: '/admin/playground',
		unmigrated: [
			'/gateway/playground',
			'/admin/playground/context',
			'/admin/playground/realtime',
			'/admin/playground-extra',
			'/admin/playground//',
			'/admin/%70layground',
			'/admin/playground%2f',
			'/admin//playground',
			'/api/admin/playground',
			'/api/admin/playground/context',
			'/api/admin/playground/preview',
			'/api/admin/playground/realtime',
			'/admin/simulator',
		],
	},
	{
		name: 'Simulator',
		flag: 'CINATOKEN_WEB_ADMIN_SIMULATOR_ENABLED',
		path: '/admin/simulator',
		unmigrated: [
			'/gateway/simulator',
			'/admin/simulator/context',
			'/admin/simulator-extra',
			'/admin/simulator//',
			'/admin/%73imulator',
			'/admin/simulator%2f',
			'/admin//simulator',
			'/api/admin/simulator/context',
			'/api/admin/keys/key-1/verify-secret',
			'/admin/playground',
			'/v1/chat/completions',
			'/v1/dashscope/realtime',
		],
	},
	{
		name: 'Tools Configuration',
		flag: 'CINATOKEN_WEB_ADMIN_TOOLS_ENABLED',
		path: '/admin/tools',
		unmigrated: [
			'/gateway/tools',
			'/admin/tools/invocations',
			'/admin/tools/invocations/',
			'/admin/tools/detail',
			'/admin/tools-extra',
			'/admin/tools//',
			'/admin/%74ools',
			'/admin/tools%2F',
			'/admin//tools',
			'/api/admin/config',
			'/api/admin/config/tools/overview',
			'/api/admin/config/tools/web-search/audit',
			'/admin/playground',
		],
	},
	{
		name: 'Tool Invocations',
		flag: 'CINATOKEN_WEB_ADMIN_TOOL_INVOCATIONS_ENABLED',
		path: '/admin/tools/invocations',
		unmigrated: [
			'/admin/tools',
			'/admin/tools/invocations/detail',
			'/admin/tools/invocations-extra',
			'/admin/tools/invocations//',
			'/admin/tools/%69nvocations',
			'/admin/tools/invocations%2f',
			'/api/admin/request-logs',
			'/api/admin/tools/invocations',
			'/admin/request-logs',
			'/admin/audit-logs',
		],
	},
	{
		name: 'Budget Audit',
		flag: 'CINATOKEN_WEB_ADMIN_BUDGET_AUDIT_ENABLED',
		path: '/admin/audit-logs',
		unmigrated: [
			'/admin/audit-logs/detail',
			'/admin/audit-logs-extra',
			'/admin/audit-logs//',
			'/admin/%61udit-logs',
			'/admin/audit-logs%2f',
			'/api/admin/budget-audit-logs',
			'/api/admin/budget-audit-logs/filters',
			'/api/admin/audit-logs',
			'/admin/request-logs',
			'/admin/users',
		],
	},
	{
		name: 'Request Logs',
		flag: 'CINATOKEN_WEB_ADMIN_REQUEST_LOGS_ENABLED',
		path: '/admin/request-logs',
		unmigrated: [
			'/admin/request-logs/detail',
			'/admin/request-logs-extra',
			'/admin/request-logs//',
			'/admin/%72equest-logs',
			'/api/admin/request-logs',
			'/admin/analytics/users',
			'/admin/users',
			'/account',
		],
	},
	{
		name: 'Users analytics',
		flag: 'CINATOKEN_WEB_ADMIN_USER_ANALYTICS_ENABLED',
		path: '/admin/analytics/users',
		unmigrated: [
			'/admin/analytics',
			'/admin/analytics/models',
			'/admin/analytics/providers',
			'/admin/analytics/reliability',
			'/admin/analytics/users/detail',
			'/admin/analytics/users//',
			'/admin/analytics/%75sers',
			'/api/admin/analytics/users',
			'/admin/users',
		],
	},
	{
		name: 'Providers analytics',
		flag: 'CINATOKEN_WEB_ADMIN_PROVIDER_ANALYTICS_ENABLED',
		path: '/admin/analytics/providers',
		unmigrated: [
			'/admin/analytics',
			'/admin/analytics/models',
			'/admin/analytics/users',
			'/admin/analytics/reliability',
			'/admin/analytics/providers/detail',
			'/admin/analytics/providers//',
			'/admin/analytics/%70roviders',
			'/api/admin/analytics/providers',
			'/admin/providers',
		],
	},
	{
		name: 'Models analytics',
		flag: 'CINATOKEN_WEB_ADMIN_MODEL_ANALYTICS_ENABLED',
		path: '/admin/analytics/models',
		unmigrated: [
			'/admin/analytics',
			'/admin/analytics/providers',
			'/admin/analytics/users',
			'/admin/analytics/reliability',
			'/admin/analytics/models/detail',
			'/admin/analytics/models//',
			'/admin/analytics/%6dodels',
			'/api/admin/analytics/models',
			'/admin/models',
		],
	},
	{
		name: 'Reliability',
		flag: 'CINATOKEN_WEB_ADMIN_RELIABILITY_ENABLED',
		path: '/admin/analytics/reliability',
		unmigrated: [
			'/admin/analytics',
			'/admin/analytics/models',
			'/admin/analytics/providers',
			'/admin/analytics/users',
			'/admin/analytics/reliability/detail',
			'/admin/analytics/reliability//',
			'/admin/analytics/%72eliability',
			'/api/admin/analytics/reliability',
			'/admin/stats',
		],
	},
	{
		name: 'Guardrails',
		flag: 'CINATOKEN_WEB_ADMIN_GUARDRAILS_ENABLED',
		path: '/admin/guardrails',
		unmigrated: [
			'/admin/config/timezone',
			'/admin/guardrails/detail',
			'/admin/guardrails//',
			'/admin/%67uardrails',
			'/api/admin/guardrails',
		],
	},
	{
		name: 'Config timezone',
		flag: 'CINATOKEN_WEB_ADMIN_CONFIG_TIMEZONE_ENABLED',
		path: '/admin/config/timezone',
		unmigrated: [
			'/admin/config',
			'/admin/guardrails',
			'/admin/config/timezone/detail',
			'/admin/config/timezone//',
			'/admin/config/%74imezone',
			'/api/admin/config/timezone',
		],
	},
	{
		name: 'Full config',
		flag: 'CINATOKEN_WEB_ADMIN_CONFIG_ENABLED',
		path: '/admin/config',
		unmigrated: [
			'/admin/config/timezone',
			'/admin/guardrails',
			'/admin/config/detail',
			'/admin/config//',
			'/admin/%63onfig',
			'/api/admin/config',
		],
	},
	{
		name: 'Integration Keys',
		flag: 'CINATOKEN_WEB_ADMIN_ACCESS_KEYS_ENABLED',
		path: '/admin/admin-api-keys',
		unmigrated: [
			'/admin/access-keys',
			'/admin/admin-api-keys/detail',
			'/admin/admin-api-keys-extra',
			'/admin/admin-api-keys//',
			'/admin/%61dmin-api-keys',
			'/admin/admin-api-keys%2F',
			'/api/admin/access-keys',
			'/api/admin/access-keys/key-1/secret',
			'/admin/shared-keys',
			'/account/keys',
		],
	},
	{
		name: 'Gateway Keys',
		flag: 'CINATOKEN_WEB_ADMIN_KEYS_ENABLED',
		path: '/admin/keys',
		unmigrated: [
			'/gateway/keys',
			'/admin/keys/detail',
			'/admin/keys-extra',
			'/admin/keys//',
			'/admin/%6beys',
			'/admin/keys%2F',
			'/admin//keys',
			'/api/admin/keys',
			'/api/admin/keys/key-1',
			'/api/admin/keys/key-1/secret',
			'/admin/admin-api-keys',
			'/account/keys',
		],
	},
	{
		name: 'Shared Keys',
		flag: 'CINATOKEN_WEB_ADMIN_SHARED_KEYS_ENABLED',
		path: '/admin/shared-keys',
		unmigrated: [
			'/gateway/shared-keys',
			'/admin/shared-keys/detail',
			'/admin/shared-keys-extra',
			'/admin/shared-keys//',
			'/admin/%73hared-keys',
			'/admin/shared-keys%2F',
			'/admin//shared-keys',
			'/api/admin/shared-keys',
			'/api/admin/shared-keys/overview',
			'/api/admin/shared-keys/key-1/audit',
			'/api/admin/earnings/rederive',
			'/admin/earnings',
			'/admin/keys',
			'/account/earnings',
		],
	},
] as const) {
	test(`${rollout.name} rollout only captures its exact GET/HEAD page and is independently disabled`, async () => {
		const f = fixture('false')
		f.env[rollout.flag] = 'true'
		for (const method of ['GET', 'HEAD']) {
			for (const path of [rollout.path, `${rollout.path}/`]) {
				const response = await routeWebRequest(
					new Request(`https://gateway.example.com${path}?q=alpha`, { method }),
					f.env
				)
				assert.equal(response.status, 200)
				assert.equal(
					response.headers.get('cache-control'),
					'no-store, no-transform'
				)
				assert.equal(
					await response.text(),
					method === 'HEAD' ? '' : '<html>account shell</html>'
				)
			}
		}
		for (const path of rollout.unmigrated) {
			const request = new Request(`https://gateway.example.com${path}`)
			assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
			assert.equal(f.admin.at(-1), request)
		}
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
			const request = new Request(
				`https://gateway.example.com${rollout.path}`,
				{ method, body: '{}' }
			)
			assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
			assert.equal(f.admin.at(-1), request)
		}
		for (const value of [undefined, '', 'false', 'TRUE', '1']) {
			f.env[rollout.flag] = value
			const request = new Request(`https://gateway.example.com${rollout.path}`)
			assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
			assert.equal(f.admin.at(-1), request)
		}
	})
}

test('Gateway Keys rollback and backend boundaries preserve methods, headers and request bodies', async () => {
	const f = fixture('false')
	for (const flag of [undefined, 'false', 'true']) {
		f.env.CINATOKEN_WEB_ADMIN_KEYS_ENABLED = flag
		for (const path of [
			'/admin/keys',
			'/admin/keys/',
			'/admin/keys?user_id=fixture',
			'/admin/keys/?user_id=fixture',
			'/api/admin/keys',
			'/api/admin/keys/key-1',
			'/admin/keys/detail',
			'/admin/%6beys',
			'/admin/keys%2f',
			'/admin//keys',
			'/admin/keys//',
			'/admin/keys-extra',
		]) {
			for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']) {
				const isPage = /^\/admin\/keys\/?(?:\?.*)?$/u.test(path)
				if (
					flag === 'true' &&
					isPage &&
					(method === 'GET' || method === 'HEAD')
				)
					continue
				const request = new Request(`https://gateway.example.com:9443${path}`, {
					method,
					headers: {
						cookie: 'admin_session=fixture',
						origin: 'https://gateway.example.com:9443',
						'content-type': 'application/json',
					},
					...(method === 'GET' || method === 'HEAD'
						? {}
						: { body: '{"id":"fixture"}' }),
				})
				assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
				assert.equal(f.admin.at(-1), request)
				if (method !== 'GET' && method !== 'HEAD')
					assert.equal(await request.text(), '{"id":"fixture"}')
			}
		}
	}
	assert.equal(f.assets.length, 0)
})

test('all unmigrated public, account, admin and backend routes preserve the original Request', async () => {
	const f = fixture()
	for (const pathname of [
		'/',
		'/models',
		'/models/vendor/model',
		'/providers',
		'/compare',
		'/chat',
		'/rankings',
		'/benchmarks',
		'/account/byok/detail',
		'/account/activity/detail',
		'/account/earnings/detail',
		'/account/nft/detail',
		'/account/%65arnings',
		'/account/nft//',
		'/account/%61ctivity',
		'/account/byok//',
		'/account/%62yok',
		'/account%2fbyok',
		'/account/withdraw/detail',
		'/account/presets/detail',
		'/account/guardrails/detail',
		'/account/settings/profile',
		'/account/%77ithdraw',
		'/account/guardrails//',
		'/account/keys/detail',
		'/accounting',
		'/ACCOUNT',
		'/account//',
		'/admin',
		'/admin/providers',
		'/gateway/routes',
		'/dashboard',
		'/api/user/me',
		'/api/auth/cinaauth/callback',
		'/api/unknown',
		'/catalog/models',
		'/_next/static/app.js',
		'/index.html',
		'/logo.png',
	]) {
		const request = new Request(
			`https://gateway.example.com:9443${pathname}?keep=1`,
			{
				headers: { cookie: 'cinatoken_session=session-fixture' },
			}
		)
		const response = await routeWebRequest(request, f.env)
		assert.equal(response, f.backendResponse)
		assert.equal(f.admin.at(-1), request)
	}
	assert.equal(f.assets.length, 0)
})

test('rollout is opt-in and rollback retains the static asset namespace', async () => {
	for (const enabled of [undefined, '', 'false', 'TRUE', '1']) {
		const f = fixture()
		f.env.CINATOKEN_WEB_ACCOUNT_ENABLED = enabled
		for (const pathname of accountPaths) {
			const request = new Request(`https://gateway.example.com${pathname}`)
			assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		}
		assert.equal(f.assets.length, 0)
		const assetResponse = await routeWebRequest(
			new Request(
				'https://gateway.example.com/web-assets/static/js/index.12345678.js?v=1'
			),
			f.env
		)
		assert.equal(await assetResponse.text(), '/static/js/index.12345678.js')
		assert.equal(
			f.assets.at(-1)?.url,
			'https://gateway.example.com/static/js/index.12345678.js'
		)
	}
})

test('asset prefix stripping does not capture lookalike paths or fall back on missing assets', async () => {
	const f = fixture()
	const response = await routeWebRequest(
		new Request('https://gateway.example.com/web-assets/static/js/missing.js'),
		f.env
	)
	assert.equal(response.status, 404)
	assert.equal(f.admin.length, 0)
	const request = new Request(
		'https://gateway.example.com/web-assets-other/static.js'
	)
	assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
})

test('non-read requests reach Admin with public URL, Origin, cookies and body unchanged', async () => {
	const f = fixture()
	for (const pathname of [
		'/api/user/gateway-keys',
		'/api/user/byok',
		'/api/auth/logout',
		'/account/keys',
		'/account/byok',
		'/account/activity',
		'/web-assets/static/app.js',
		'/account/earnings',
		'/account/nft',
		'/account/withdraw',
		'/account/presets',
		'/account/guardrails',
		'/account/settings',
	]) {
		const request = new Request(
			`https://gateway.example.com:9443${pathname}?keep=1`,
			{
				method: 'POST',
				headers: {
					origin: 'https://gateway.example.com:9443',
					cookie: 'cinatoken_session=fixture; cinaauth_tx=fixture',
					'content-type': 'application/json',
					'sec-fetch-site': 'same-origin',
				},
				body: '{"name":"fixture"}',
			}
		)
		assert.equal(await routeWebRequest(request, f.env), f.backendResponse)
		assert.equal(f.admin.at(-1), request)
		assert.equal(
			request.url,
			`https://gateway.example.com:9443${pathname}?keep=1`
		)
		assert.equal(
			request.headers.get('origin'),
			'https://gateway.example.com:9443'
		)
		assert.equal(
			request.headers.get('cookie'),
			'cinatoken_session=fixture; cinaauth_tx=fixture'
		)
		assert.equal(await request.text(), '{"name":"fixture"}')
	}
	assert.equal(f.assets.length, 0)
})

test('Admin redirects, multiple Set-Cookie and streams are returned without reconstruction', async () => {
	const f = fixture()
	const headers = new Headers({
		location: '/account',
		'cache-control': 'no-store',
	})
	headers.append('set-cookie', 'cinatoken_session=fixture; HttpOnly; Path=/')
	headers.append('set-cookie', 'cinaauth_tx=; Max-Age=0; Secure; Path=/')
	const redirect = new Response(null, { status: 302, headers })
	f.env.CINATOKEN_ADMIN_SERVICE.fetch = async () => redirect
	const response = await routeWebRequest(
		new Request(
			'https://gateway.example.com/api/auth/cinaauth/callback?state=fixture'
		),
		f.env
	)
	assert.equal(response, redirect)
	assert.equal(response.headers.getSetCookie().length, 2)
	assert.equal(response.headers.get('location'), '/account')

	let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			streamController = controller
		},
	})
	const upstream = new Response(stream, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-store, no-transform',
			'retry-after': '2',
		},
	})
	f.env.CINATOKEN_ADMIN_SERVICE.fetch = async () => upstream
	const streamed = await routeWebRequest(
		new Request('https://gateway.example.com/api/public/chat', {
			method: 'POST',
			body: '{}',
		}),
		f.env
	)
	assert.equal(streamed, upstream)
	assert.equal(streamed.body, stream)
	assert.equal(streamed.bodyUsed, false)
	assert.equal(streamed.headers.get('retry-after'), '2')
	streamController?.close()
})

test('HEAD shell has no response body and missing index fails without a backend substitution', async () => {
	const f = fixture()
	for (const pathname of accountPaths) {
		const head = await routeWebRequest(
			new Request(`https://gateway.example.com${pathname}`, { method: 'HEAD' }),
			f.env
		)
		assert.equal(head.body, null)
		assert.equal(f.assets.at(-1)?.method, 'HEAD')
	}
	f.env.ASSETS.fetch = async () =>
		new Response('missing index', { status: 404 })
	const missing = await routeWebRequest(
		new Request('https://gateway.example.com/account'),
		f.env
	)
	assert.equal(missing.status, 503)
	assert.equal(f.admin.length, 0)
})
