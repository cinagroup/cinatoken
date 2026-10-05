/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import * as React from 'react'
import { QueryClient, QueryObserver } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToReadableStream } from 'react-dom/server.edge'
import { createPublicCatalogApi, PublicCatalogError } from '../catalog-api'
import { validateStatsSearch } from '../catalog-search'
import { FRONTEND_SOURCE_DOWNLOAD_URL } from '../frontend-attribution'
import { PUBLIC_FRONTEND_ORIGIN_URL } from '../home/home-links'
import { publicHomeMessages } from '../home/home-messages'
import { publicMessages } from '../messages'
import { PublicApplication } from './public-application'
import {
	PUBLIC_BOOTSTRAP_MAX_BYTES,
	parsePublicBootstrap,
	publicBootstrapSchema,
	safePublicError,
	serializePublicBootstrap,
} from './public-bootstrap'
import { localizePublicHref, type PublicLocale } from './public-location'
import { publicModelQueryOptions } from './public-query-options'
import {
	publicSnapshotQueryKey,
	restorePublicQueries,
} from './public-query-state'
import {
	createPublicRequestApp,
	preparePublicRequest,
	type PublicRequestApp,
} from './public-request-app'

// Referenced tsconfig tests use classic JSX; this is the real React runtime, not a DOM shim.
Object.assign(globalThis, { React })
const generatedAt = '2026-10-01T00:00:00.000Z'
const model = {
	id: 'vendor/model',
	slug: 'fixture-model',
	display_name: 'Authority model',
	vendor: 'Vendor',
	context_window: 128_000,
	max_tokens: 32_000,
	pricing_profile: {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: 1,
				output_price: 2,
				cache_read_price: 0,
				cache_write_price: null,
				image_input_price: null,
				image_input_cache_price: null,
				image_output_price: null,
			},
		],
	},
	tags: [],
	route_groups: ['default'],
	protocols: ['openai'],
	protocols_by_group: { default: ['openai'] },
	recommended_protocol: 'openai',
	description: 'Authority model description',
	input_modalities: ['text'],
	output_modalities: ['text'],
	released_at: null,
	endpoint_slugs: [],
	regions: [],
	data_policy_summary: {
		verified_route_count: 0,
		zdr_available: false,
		latest_verified_at: null,
	},
}

function fixture(
	path: string,
	label = 'Authority model',
	currency = 'SGD'
): unknown {
	const row = { ...model, display_name: label }
	if (path.includes('/catalog/model/'))
		return {
			object: 'model',
			data: row,
			billing_currency: currency,
			generated_at: generatedAt,
		}
	if (path.includes('/catalog/providers'))
		return {
			object: 'list',
			data: [
				{
					id: 'Vendor',
					display_name: 'Authority provider',
					model_count: 1,
					protocols: ['openai'],
					route_groups: ['default'],
					input_modalities: ['text'],
					output_modalities: ['text'],
					latest_released_at: null,
				},
			],
			billing_currency: currency,
			generated_at: generatedAt,
		}
	if (path.includes('/catalog/stats/')) {
		const range = new URL(path, 'https://catalog.test').searchParams.get(
			'range'
		)
		return {
			object: 'list',
			data: [
				{
					id: row.id,
					slug: row.slug,
					display_name: label,
					vendor: row.vendor,
					request_count: 20,
					success_rate: 100,
					avg_latency_ms: 25,
					output_tokens: 10,
					total_tokens: 30,
				},
			],
			range,
			window_start: '2026-09-01T00:00:00.000Z',
			window_end: generatedAt,
			minimum_sample_size: 20,
			generated_at: generatedAt,
		}
	}
	return {
		object: 'list',
		data: [row],
		billing_currency: currency,
		generated_at: generatedAt,
	}
}

function requestApp(
	path: string,
	locale: PublicLocale = 'en',
	read: typeof fetch = async (input) => Response.json(fixture(String(input)))
): PublicRequestApp {
	return createPublicRequestApp({
		url: `http://127.0.0.1:5250/${locale}${path}`,
		locale,
		api: createPublicCatalogApi(read),
		publicOrigin: 'https://cinatoken.test',
	})
}

async function render(app: PublicRequestApp): Promise<string> {
	const stream = await renderToReadableStream(
		React.createElement(PublicApplication, { app }),
		{ identifierPrefix: 'cinatoken-public-' }
	)
	await stream.allReady
	return new Response(stream).text()
}

for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
	for (const path of [
		'',
		'/models',
		'/models/Vendor/fixture-model',
		'/providers',
		'/compare?models=Vendor%2Ffixture-model',
		'/chat?model=vendor%2Fmodel',
		'/rankings?range=30d',
		'/benchmarks?range=90d',
		'/missing',
	]) {
		test(`NOTICE English attribution stays visible in the single ${locale} footer: ${path || 'home'}`, async () => {
			const app = requestApp(path, locale)
			try {
				const prepared = await preparePublicRequest(app)
				assert.equal(prepared.status, path === '/missing' ? 404 : 200)
				const html = await render(app)
				const footers =
					html.match(/<footer(?:\s[^>]*)?>[\s\S]*?<\/footer>/g) ?? []
				assert.equal(footers.length, 1)
				const footer = footers[0]!
				assert.ok(
					footer.includes(
						'Frontend design and development by New API contributors.'
					),
					'English NOTICE text cannot be replaced by a translation'
				)
				assert.match(
					footer,
					/<span lang="en">Frontend design and development by New API contributors\.<\/span>/
				)
				assert.equal(
					footer.split(
						'Frontend design and development by New API contributors.'
					).length - 1,
					1
				)
				assert.ok(
					footer.includes(publicHomeMessages[locale].attribution.statement)
				)
				assert.equal(
					(
						footer.match(
							/href="https:\/\/github\.com\/QuantumNous\/new-api"/g
						) ?? []
					).length,
					1
				)
				assert.ok(footer.includes(`href="${PUBLIC_FRONTEND_ORIGIN_URL}"`))
				assert.equal(
					footer.split(`href="${FRONTEND_SOURCE_DOWNLOAD_URL}"`).length - 1,
					1
				)
				assert.ok(
					footer.includes(publicHomeMessages[locale].attribution.sourceDownload)
				)
			} finally {
				app.dispose()
			}
		})
	}
}

for (const path of [
	'',
	'/models?q=Authority',
	'/models/Vendor/fixture-model',
	'/providers',
	'/compare?models=Vendor%2Ffixture-model',
	'/chat?model=vendor%2Fmodel',
	'/rankings?range=30d',
	'/benchmarks?range=90d',
]) {
	test(`request factory keeps the public-only route, snapshot and anonymous SDK contract: ${path || 'home'}`, async () => {
		const requests: string[] = []
		const app = requestApp(path, 'en', async (input, init) => {
			requests.push(String(input))
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.deepEqual(
				[...new Headers(init?.headers)],
				[['accept', 'application/json']]
			)
			return Response.json(fixture(String(input)))
		})
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, 200)
			assert.equal(requests.length, path ? 1 : 0)
			assert.equal(Object.keys(app.router.routesById).length, 9)
			assert.equal(
				Object.keys(app.router.routesById).some((id) =>
					/admin|account|gateway/.test(id)
				),
				false
			)
			assert.deepEqual(
				Object.keys(
					app.i18n.getResourceBundle('en', 'translation').cinatoken
				).sort(),
				['chat', 'home', 'public', 'publicAuth', 'shell']
			)
			const html = await render(app)
			assert.match(html, /<h1/)
			assert.equal(html.includes('cinatoken.public.'), false)
			assert.equal(html.includes('cinatoken.home.'), false)
			assert.equal(
				requests.length,
				path ? 1 : 0,
				'Rendering must not perform a second authority read'
			)
			if (path.startsWith('/benchmarks') || path.startsWith('/rankings')) {
				const search = app.router.state.matches.at(-1)?.search
				assert.ok(search && 'metric' in search)
				const parsed = validateStatsSearch(search)
				assert.equal(
					parsed.metric,
					path.startsWith('/benchmarks') ? 'latency' : 'popular'
				)
			}
			if (prepared.modelDetail)
				assert.equal(
					app.queryClient.getQueryData([
						'cinatoken',
						'public',
						'model',
						'Vendor',
						'fixture-model',
					]),
					prepared.modelDetail
				)
		} finally {
			app.dispose()
		}
		assert.equal(app.queryClient.getQueryCache().getAll().length, 0)
	})
}

test('concurrent preparations share one authoritative detail object and promise within a request', async () => {
	let reads = 0
	const app = requestApp(
		'/models/Vendor/fixture-model',
		'en',
		async (input) => {
			reads++
			return Response.json(fixture(String(input), `Snapshot ${reads}`))
		}
	)
	try {
		const first = preparePublicRequest(app)
		const second = preparePublicRequest(app)
		assert.equal(first, second)
		const [a, b] = await Promise.all([first, second])
		assert.equal(a, b)
		assert.equal(reads, 1)
		assert.equal(a.modelDetail?.data.display_name, 'Snapshot 1')
		assert.equal(
			a.modelDetail,
			app.queryClient.getQueryData([
				'cinatoken',
				'public',
				'model',
				'Vendor',
				'fixture-model',
			])
		)
	} finally {
		app.dispose()
	}
})

test('parallel four-language requests isolate translations, query data and authority instances', async () => {
	const locales = ['en', 'zh', 'ja', 'ko'] as const
	const apps = locales.map((locale) =>
		requestApp('/models', locale, async (input) =>
			Response.json(
				fixture(
					String(input),
					`Only ${locale}`,
					locale === 'zh' ? 'CNY' : 'SGD'
				)
			)
		)
	)
	try {
		const prepared = await Promise.all(
			apps.map((app) => preparePublicRequest(app))
		)
		const html = await Promise.all(apps.map((app) => render(app)))
		for (let i = 0; i < locales.length; i++) {
			const locale = locales[i]!
			assert.equal(apps[i]!.i18n.resolvedLanguage, locale)
			assert.ok(html[i]!.includes(publicMessages[locale].modelsTitle))
			assert.ok(html[i]!.includes(`Only ${locale}`))
			assert.ok(html[i]!.includes(`href="/${locale}/providers"`))
			assert.equal(prepared[i]!.bootstrap.locale, locale)
			for (const other of locales.filter((value) => value !== locale))
				assert.equal(html[i]!.includes(`Only ${other}`), false)
		}
		assert.equal(new Set(apps.map((app) => app.queryClient)).size, 4)
		assert.equal(new Set(apps.map((app) => app.i18n)).size, 4)
		assert.equal(new Set(apps.map((app) => app.router)).size, 4)
	} finally {
		apps.forEach((app) => app.dispose())
	}
})

for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
	test(`HTTP ${status} restores a safe error first frame and supports explicit retry without authority replay`, async () => {
		let reads = 0
		let fail = true
		const app = requestApp(
			'/models/Vendor/fixture-model',
			'ja',
			async (input) => {
				reads++
				return fail
					? Response.json(
							{ privateError: 'SECRET_DATABASE_URL' },
							{ status, headers: { 'Retry-After': '2' } }
						)
					: Response.json(fixture(String(input)))
			}
		)
		const client = new QueryClient()
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, status === 404 ? 404 : 503)
			const serialized = serializePublicBootstrap(prepared.bootstrap)
			assert.equal(serialized.includes('SECRET_DATABASE_URL'), false)
			const bootstrap = parsePublicBootstrap(serialized)
			restorePublicQueries(client, bootstrap.records)
			const observer = new QueryObserver(
				client,
				publicModelQueryOptions(app.input.api, 'Vendor', 'fixture-model')
			)
			const unsubscribe = observer.subscribe(() => undefined)
			try {
				const first = observer.getCurrentResult()
				assert.equal(first.status, 'error')
				assert.equal(first.isFetching, false)
				assert.ok(first.error instanceof PublicCatalogError)
				assert.equal(first.error.status, status)
				assert.equal(reads, 1)
				const html = await render(app)
				assert.ok(
					html.includes(publicMessages.ja.notFound) ||
						html.includes(publicMessages.ja.unavailable) ||
						html.includes(publicMessages.ja.rateLimited)
				)
				assert.equal(html.includes('SECRET_DATABASE_URL'), false)
				assert.equal(reads, 1)
				fail = false
				const retried = await observer.refetch()
				assert.equal(retried.status, 'success')
				assert.equal(reads, 2)
			} finally {
				unsubscribe()
			}
		} finally {
			client.clear()
			app.dispose()
		}
	})
}

test('invalid public DTO and network failures produce 503 without an invented successful empty snapshot', async () => {
	for (const mode of ['invalid', 'network'] as const) {
		const app = requestApp('/models', 'zh', async () => {
			if (mode === 'network') throw new Error('PRIVATE_FETCH_URL')
			return Response.json({
				object: 'list',
				data: [],
				billing_currency: 'usd',
				generated_at: generatedAt,
			})
		})
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, 503)
			assert.equal(prepared.bootstrap.records[0]?.result.status, 'error')
			assert.equal(
				serializePublicBootstrap(prepared.bootstrap).includes(
					'PRIVATE_FETCH_URL'
				),
				false
			)
			assert.ok(
				(await render(app)).includes(
					publicMessages.zh[
						mode === 'invalid' ? 'invalidResponse' : 'unavailable'
					]
				)
			)
		} finally {
			app.dispose()
		}
	}
})

test('bootstrap white list rejects cross-resource, cross-range and private state and escapes script boundaries', async () => {
	const app = requestApp(
		'/models/Vendor/fixture-model',
		'ko',
		async (input) => {
			const response = fixture(String(input)) as { data: typeof model }
			return Response.json({
				...response,
				privateUser: 'SECRET_SUBJECT',
				data: {
					...response.data,
					description: '</script><img src=x onerror=alert(1)>&\u2028\u2029',
					credential: 'SECRET_KEY',
				},
			})
		}
	)
	try {
		const prepared = await preparePublicRequest(app)
		const serialized = serializePublicBootstrap(prepared.bootstrap)
		assert.equal(serialized.includes('</script>'), false)
		assert.equal(serialized.includes('SECRET_'), false)
		assert.ok(serialized.includes('\\u003c'))
		assert.ok(serialized.includes('\\u2028'))
		assert.deepEqual(parsePublicBootstrap(serialized), prepared.bootstrap)
		assert.throws(() =>
			parsePublicBootstrap(
				JSON.stringify({ ...prepared.bootstrap, privateSession: 'secret' })
			)
		)
		assert.throws(() =>
			parsePublicBootstrap(
				JSON.stringify({
					...prepared.bootstrap,
					pathname: '/ko/models/Other/fixture-model',
				})
			)
		)
		assert.throws(() =>
			parsePublicBootstrap(
				JSON.stringify({ ...prepared.bootstrap, locale: 'en' })
			)
		)
		assert.throws(() =>
			parsePublicBootstrap(
				JSON.stringify({
					...prepared.bootstrap,
					records: [
						{
							...prepared.bootstrap.records[0],
							queryKey: ['cinatoken', 'account', 'secret'],
						},
					],
				})
			)
		)
		assert.deepEqual(safePublicError(new Error('PRIVATE_ERROR')), {
			code: 'network',
			status: 0,
			retryAfter: null,
		})
	} finally {
		app.dispose()
	}
	const stats = requestApp('/benchmarks?range=30d')
	try {
		const prepared = await preparePublicRequest(stats)
		assert.throws(() =>
			parsePublicBootstrap(
				JSON.stringify({ ...prepared.bootstrap, search: '?range=90d' })
			)
		)
	} finally {
		stats.dispose()
	}
})

test('unknown and malformed locale resources return 404 without reading catalog or accepting private routes', async () => {
	for (const [path, locale] of [
		['/en/missing', 'en'],
		['/en/admin', 'en'],
		['/en/models/Vendor/%2Fsecret', 'en'],
		['/en/models/Vendor/%zz', 'en'],
		['/fr/models', 'en'],
		['/ko/missing', 'ko'],
		['/en/models/a/b%2Fc', 'en'],
	] as const) {
		let reads = 0
		const app = createPublicRequestApp({
			url: `http://127.0.0.1${path}`,
			locale,
			publicOrigin: 'https://cinatoken.test',
			api: createPublicCatalogApi(async () => {
				reads++
				return Response.json(fixture('/models'))
			}),
		})
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, 404)
			assert.equal(reads, 0)
			assert.equal(prepared.bootstrap.records.length, 0)
			assert.equal(prepared.bootstrap.pathname, path)
			assert.equal(prepared.bootstrap.locale, locale)
			assert.ok(app.router.state.matches.length > 0)
			assert.equal(app.router.history.location.href, path)
			assert.deepEqual(
				parsePublicBootstrap(serializePublicBootstrap(prepared.bootstrap)),
				prepared.bootstrap
			)
			assert.match(await render(app), /404/)
		} finally {
			app.dispose()
		}
	}
})

test('pre-aborted requests perform no SDK read and disposal clears only their request cache', async () => {
	const controller = new AbortController()
	controller.abort(new Error('caller_cancelled'))
	let reads = 0
	const app = createPublicRequestApp({
		url: 'http://127.0.0.1/en/models',
		locale: 'en',
		publicOrigin: 'https://cinatoken.test',
		signal: controller.signal,
		api: createPublicCatalogApi(async () => {
			reads++
			return Response.json(fixture('/models'))
		}),
	})
	await assert.rejects(preparePublicRequest(app), /caller_cancelled/)
	assert.equal(reads, 0)
	app.dispose()
	app.dispose()
	assert.equal(app.queryClient.getQueryCache().getAll().length, 0)
	assert.equal(app.signal.aborted, true)
})

test('language links preserve current public resources and query while private and external paths remain exact', () => {
	assert.equal(
		localizePublicHref(
			'/zh/models/Vendor/fixture-model?q=x&vendors=%5B%22Vendor%22%5D#pricing',
			'ja'
		),
		'/ja/models/Vendor/fixture-model?q=x&vendors=%5B%22Vendor%22%5D#pricing'
	)
	assert.equal(localizePublicHref('/', 'ko'), '/ko')
	for (const path of [
		'/account?tab=keys',
		'/admin/models',
		'/api/locale',
		'/dashboard',
		'#resources',
		'https://elsewhere.test/models',
		'//elsewhere.test/models',
	])
		assert.equal(localizePublicHref(path, 'zh'), path)
})

test('duplicate range parameters use the same Router parser for SSR and restored bootstrap', async () => {
	const app = requestApp('/benchmarks?range=30d&range=90d')
	try {
		const prepared = await preparePublicRequest(app)
		assert.equal(prepared.status, 200)
		const record = prepared.bootstrap.records[0]
		assert.equal(record?.kind, 'stats')
		assert.deepEqual(
			parsePublicBootstrap(serializePublicBootstrap(prepared.bootstrap)),
			prepared.bootstrap
		)
		if (record?.kind === 'stats') assert.equal(record.range, '7d')
		assert.equal(
			app.queryClient.getQueryData(publicSnapshotQueryKey(record!)) !==
				undefined,
			true
		)
	} finally {
		app.dispose()
	}
})

test('serialized UTF-8 limit rejects script-escape expansion and multibyte DTOs before hydration', () => {
	const bootstrapWithDescriptions = (count: number, description: string) =>
		publicBootstrapSchema.parse({
			version: 1,
			locale: 'en',
			pathname: '/en/models',
			search: '',
			status: 200,
			records: [
				{
					kind: 'models',
					result: {
						status: 'success',
						observedAt: 1,
						data: {
							object: 'list',
							billing_currency: 'SGD',
							generated_at: generatedAt,
							data: Array.from({ length: count }, (_, index) => ({
								...model,
								id: `Vendor/model-${index}`,
								slug: `model-${index}`,
								description,
							})),
						},
					},
				},
			],
		})
	const expanded = bootstrapWithDescriptions(31, '<'.repeat(100_000))
	const raw = JSON.stringify(expanded)
	assert.ok(Buffer.byteLength(raw) < PUBLIC_BOOTSTRAP_MAX_BYTES)
	assert.ok(
		Buffer.byteLength(raw.replace(/</g, '\\u003c')) > PUBLIC_BOOTSTRAP_MAX_BYTES
	)
	assert.throws(
		() => serializePublicBootstrap(expanded),
		/Public snapshot is too large/
	)
	const multibyte = JSON.stringify(
		bootstrapWithDescriptions(60, '中'.repeat(100_000))
	)
	assert.ok(multibyte.length < PUBLIC_BOOTSTRAP_MAX_BYTES)
	assert.ok(Buffer.byteLength(multibyte) > PUBLIC_BOOTSTRAP_MAX_BYTES)
	assert.throws(
		() => parsePublicBootstrap(multibyte),
		/Public snapshot is too large/
	)
	for (const accepted of [
		bootstrapWithDescriptions(27, '<'.repeat(100_000)),
		bootstrapWithDescriptions(55, '中'.repeat(100_000)),
	]) {
		const serialized = serializePublicBootstrap(accepted)
		assert.ok(Buffer.byteLength(serialized) <= PUBLIC_BOOTSTRAP_MAX_BYTES)
		assert.deepEqual(parsePublicBootstrap(serialized), accepted)
	}
	const home = JSON.stringify({
		version: 1,
		locale: 'en',
		pathname: '/en',
		search: '',
		status: 200,
		records: [],
	})
	const exact =
		home + ' '.repeat(PUBLIC_BOOTSTRAP_MAX_BYTES - Buffer.byteLength(home))
	assert.equal(Buffer.byteLength(exact), PUBLIC_BOOTSTRAP_MAX_BYTES)
	assert.equal(parsePublicBootstrap(exact).pathname, '/en')
	assert.throws(
		() => parsePublicBootstrap(exact + ' '),
		/Public snapshot is too large/
	)
})

test('SSR keeps valid raw filter encodings and locale roots without replacing the initial URL', async () => {
	for (const path of [
		'/',
		'/models?q=Authority+model',
		'/models?vendors=Vendor',
		'/models?vendors=%5B%22Vendor%22%5D&sort=popular',
		'/providers?q=Authority%20provider',
		'/compare?models=%5B%22Vendor%2Ffixture-model%22%5D',
		'/benchmarks?range=30d&metric=popular',
		'/rankings?range=30d&range=90d',
	]) {
		const app = requestApp(path)
		try {
			const prepared = await preparePublicRequest(app)
			assert.equal(prepared.status, 200)
			assert.equal(
				app.router.history.location.href,
				app.url.pathname + app.url.search
			)
			assert.equal(prepared.bootstrap.pathname, app.url.pathname)
			assert.equal(prepared.bootstrap.search, app.url.search)
			assert.match(await render(app), /<h1/)
		} finally {
			app.dispose()
		}
	}
})
