/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { PublicChatPage } from '../chat/PublicChatPage'
import { HomePage } from '../home-page'
import { BenchmarksPage } from './BenchmarksPage'
import { ModelCatalogPage } from './ModelCatalogPage'
import { ModelComparePage } from './ModelComparePage'
import { ModelDetailPage } from './ModelDetailPage'
import { PublicProvidersPage } from './PublicProvidersPage'
import { RankingsPage } from './RankingsPage'
import { PublicAuthProvider } from './auth/public-auth-context'
import type { CatalogModel } from './catalog-contracts'
import {
	validateCompareSearch,
	validateModelCatalogSearch,
	validateProvidersSearch,
	validateStatsSearch,
} from './catalog-search'
import {
	modelHref,
	modelKey,
	validateBenchmarkSearch,
} from './catalog-view-model'
import {
	PUBLIC_DOCS_URL,
	PUBLIC_FRONTEND_ORIGIN_URL,
	PUBLIC_GITHUB_URL,
} from './home/home-links'
import { publicHomeMessages } from './home/home-messages'
import { publicMessages } from './messages'
import { createPublicI18n } from './ssr/public-i18n'
import {
	createPublicLocation,
	PUBLIC_LOCALES,
	PublicLocationProvider,
	type PublicLocale,
} from './ssr/public-location'
import { restorePublicQueries } from './ssr/public-query-state'

// The repository's Node loader uses classic JSX for imported TSX modules.
Object.assign(globalThis, { React })
const element = React.createElement
const noop = () => undefined
const generatedAt = '2026-10-01T00:00:00Z'
const alpha: CatalogModel = {
	id: 'alpha-id',
	slug: 'alpha',
	display_name: 'Alpha preserved model',
	vendor: 'openai',
	context_window: 128_000,
	max_tokens: 0,
	description: 'Published description preserved',
	pricing_profile: {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: -1,
				output_price: 0,
				cache_read_price: 0,
				cache_write_price: 2.5,
				image_input_price: null,
				image_input_cache_price: null,
				image_output_price: null,
			},
		],
	},
	tags: ['reasoning'],
	route_groups: ['default'],
	protocols: ['openai', 'anthropic'],
	protocols_by_group: { default: ['openai', 'anthropic'] },
	recommended_protocol: 'openai',
	input_modalities: ['text', 'image'],
	output_modalities: ['text'],
	released_at: '2026-01-01',
	endpoint_slugs: ['global'],
	regions: ['global'],
	data_policy_summary: {
		verified_route_count: 2,
		zdr_available: true,
		latest_verified_at: generatedAt,
	},
}
const beta: CatalogModel = {
	...alpha,
	id: 'beta-id',
	slug: 'beta',
	display_name: 'Beta retained model',
	context_window: 64_000,
}
const models = {
	object: 'list' as const,
	data: [alpha, beta],
	billing_currency: 'CNY',
	generated_at: generatedAt,
}
const providers = {
	object: 'list' as const,
	data: [
		{
			id: 'author',
			display_name: 'Provider, A',
			model_count: 2,
			protocols: ['openai' as const],
			route_groups: ['default'],
			input_modalities: ['text'],
			output_modalities: ['text'],
			latest_released_at: '2026-01-01',
		},
	],
	billing_currency: 'CNY',
	generated_at: generatedAt,
}
const stats = {
	object: 'list' as const,
	range: '30d' as const,
	minimum_sample_size: 20,
	generated_at: generatedAt,
	window_start: '2026-09-01T00:00:00Z',
	window_end: generatedAt,
	data: [
		{
			id: alpha.id,
			slug: alpha.slug,
			display_name: alpha.display_name!,
			vendor: alpha.vendor,
			request_count: 20,
			success_rate: 100,
			avg_latency_ms: 1,
			output_tokens: 10,
			total_tokens: 20,
		},
		{
			id: beta.id,
			slug: beta.slug,
			display_name: beta.display_name!,
			vendor: beta.vendor,
			request_count: 100,
			success_rate: 80,
			avg_latency_ms: 9,
			output_tokens: 30,
			total_tokens: 40,
		},
	],
}

function render(
	locale: PublicLocale,
	child: React.ReactNode,
	seed?: (client: QueryClient) => void
): string {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	})
	seed?.(client)
	try {
		return renderToStaticMarkup(
			element(
				I18nextProvider,
				{ i18n: createPublicI18n(locale) },
				element(
					QueryClientProvider,
					{ client },
					element(
						PublicLocationProvider,
						{ value: createPublicLocation(locale) },
						element(PublicAuthProvider, null, child)
					)
				)
			),
			{ identifierPrefix: 'cinatoken-public-' }
		)
	} finally {
		client.clear()
	}
}
function seedModels(client: QueryClient) {
	client.setQueryData(['cinatoken', 'public', 'models'], models)
}

for (const locale of PUBLIC_LOCALES) {
	test(`home ${locale}: initial HTML retains discovery, product sections, demo, private entries and attribution`, () => {
		const html = render(locale, element(HomePage))
		for (const path of [
			'/models',
			'/providers',
			'/compare',
			'/chat',
			'/rankings',
			'/benchmarks',
		])
			assert.ok(html.includes(`href="/${locale}${path}"`), path)
		for (const path of ['/account', '/dashboard']) {
			assert.ok(html.includes(`href="${path}"`))
			assert.ok(!html.includes(`href="/${locale}${path}"`))
		}
		for (const section of ['features', 'architecture', 'deployment']) {
			assert.ok(html.includes(`id="${section}"`))
			assert.ok(html.includes(`href="#${section}"`))
		}
		for (const link of [
			PUBLIC_DOCS_URL,
			PUBLIC_GITHUB_URL,
			PUBLIC_FRONTEND_ORIGIN_URL,
		])
			assert.ok(html.includes(`href="${link}"`))
		assert.equal((html.match(/role="tab"/g) ?? []).length, 4)
		assert.ok(html.includes(publicHomeMessages[locale].demo.illustration))
		assert.ok(html.includes(publicHomeMessages[locale].attribution.statement))
		const footers = html.match(/<footer(?:\s[^>]*)?>[\s\S]*?<\/footer>/g) ?? []
		assert.equal(footers.length, 1)
		assert.ok(
			footers[0]!.includes(
				'Frontend design and development by New API contributors.'
			),
			'NOTICE.frontend English attribution must remain in the visible footer'
		)
		assert.match(
			footers[0]!,
			/<span lang="en">Frontend design and development by New API contributors\.<\/span>/
		)
		assert.equal(
			footers[0]!.split(
				'Frontend design and development by New API contributors.'
			).length - 1,
			1
		)
		assert.doesNotMatch(html, /238 ms|200 OK|cinatoken\.home\./)
	})
	test(`models ${locale}: initial HTML obeys the full restored filters and view instead of rendering defaults`, () => {
		const html = render(
			locale,
			element(ModelCatalogPage, {
				search: validateModelCatalogSearch({
					q: 'Alpha',
					vendors: ['OPENAI'],
					inputs: ['image'],
					outputs: ['text'],
					protocols: ['anthropic'],
					context: '128k',
					sort: 'price',
					view: 'table',
					page: 9,
				}),
				onSearchChange: noop,
			}),
			seedModels
		)
		assert.ok(html.includes(alpha.display_name!))
		assert.ok(!html.includes(beta.display_name!))
		assert.ok(html.includes('<table'))
		assert.ok(html.includes(`href="/${locale}${modelHref(alpha)}"`))
		assert.ok(html.includes('CNY'))
		assert.ok(html.includes('-1'))
		assert.ok(html.includes(publicMessages[locale].tokenUnit))
		assert.ok(html.includes('value="Alpha"'))
		assert.ok(html.includes('value="price" selected=""'))
		assert.ok(html.includes('value="table" selected=""'))
		assert.doesNotMatch(html, /cinatoken\.public\./)
	})
	test(`detail ${locale}: initial HTML preserves public data, negative and zero prices, protocols and safe text`, () => {
		const detail = {
			object: 'model' as const,
			data: {
				...alpha,
				display_name: 'Alpha </script><script>unsafe-name</script>',
			},
			billing_currency: 'CNY',
			generated_at: generatedAt,
		}
		const html = render(
			locale,
			element(ModelDetailPage, { vendor: alpha.vendor, slug: alpha.slug }),
			(client) =>
				client.setQueryData(
					['cinatoken', 'public', 'model', alpha.vendor, alpha.slug],
					detail
				)
		)
		assert.ok(
			html.includes(
				'Alpha &lt;/script&gt;&lt;script&gt;unsafe-name&lt;/script&gt;'
			)
		)
		assert.ok(html.includes(alpha.description!))
		assert.ok(html.includes('CNY'))
		assert.ok(html.includes('2.5'))
		for (const field of [
			alpha.id,
			'default',
			'global',
			'reasoning',
			'anthropic',
			'/v1/chat/completions',
			generatedAt,
		])
			assert.ok(html.includes(field), field)
		assert.ok(
			html.includes(
				`href="/${locale}/compare?models=${encodeURIComponent(modelKey(alpha))}"`
			)
		)
		assert.doesNotMatch(html, /<script>|cinatoken\.public\./)
	})
	test(`providers ${locale}: anonymous aggregates and exact comma-bearing provider filters retain the locale`, () => {
		const html = render(
			locale,
			element(PublicProvidersPage, {
				search: validateProvidersSearch({
					q: 'Provider',
					inputs: ['text'],
					outputs: ['text'],
					protocols: ['openai'],
					sort: 'models',
				}),
				onSearchChange: noop,
			}),
			(client) =>
				client.setQueryData(['cinatoken', 'public', 'providers'], providers)
		)
		assert.ok(html.includes('Provider, A'))
		assert.ok(
			html.includes(
				`href="/${locale}/models?vendors=${encodeURIComponent(JSON.stringify(['Provider, A']))}"`
			)
		)
		assert.ok(html.includes('default'))
		assert.doesNotMatch(html, /cinatoken\.public\./)
	})
	test(`compare ${locale}: URL selections, missing models and all public comparison rows are rendered immediately`, () => {
		const html = render(
			locale,
			element(ModelComparePage, {
				search: validateCompareSearch({
					models: [modelKey(beta), modelKey(alpha), 'missing:key'],
				}),
				onSearchChange: noop,
			}),
			seedModels
		)
		assert.ok(
			html.indexOf(beta.display_name!) < html.indexOf(alpha.display_name!)
		)
		assert.ok(html.includes('missing:key'))
		assert.ok(html.includes('CNY'))
		for (const label of [
			'context',
			'maxOutput',
			'regions',
			'endpointSlugs',
			'zdrAvailable',
			'catalogPrices',
		] as const)
			assert.ok(html.includes(publicMessages[locale][label]))
		assert.ok(html.includes(`href="/${locale}${modelHref(beta)}"`))
		assert.doesNotMatch(html, /cinatoken\.public\./)
	})
	test(`chat ${locale}: anonymous SSR uses the selected published model and never reads a browser transcript`, () => {
		const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
		let reads = 0
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			value: {
				getItem() {
					reads++
					return '{"messages":[{"content":"private transcript"}]}'
				},
				setItem() {
					throw new Error('SSR storage write')
				},
				removeItem() {
					throw new Error('SSR storage removal')
				},
			},
		})
		try {
			const html = render(
				locale,
				element(PublicChatPage, { modelId: beta.id }),
				(client) =>
					client.setQueryData(['cinatoken', 'public', 'chat-models'], models)
			)
			assert.equal(reads, 0)
			assert.ok(html.includes('value="beta-id" selected=""'))
			assert.ok(html.includes('type="password"'))
			assert.ok(html.includes('href="/account/keys"'))
			assert.doesNotMatch(html, /private transcript|cinatoken\.chat\./)
		} finally {
			if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
			else Reflect.deleteProperty(globalThis, 'localStorage')
		}
	})
	for (const mode of ['rankings', 'benchmarks'] as const) {
		test(`${mode} ${locale}: the restored 30-day window and mode-specific default metric render the real observed order`, () => {
			const search =
				mode === 'benchmarks'
					? validateBenchmarkSearch({ range: '30d' })
					: validateStatsSearch({ range: '30d' })
			const html = render(
				locale,
				element(mode === 'benchmarks' ? BenchmarksPage : RankingsPage, {
					search,
					onSearchChange: noop,
				}),
				(client) =>
					client.setQueryData(['cinatoken', 'public', 'stats', '30d'], stats)
			)
			const first =
				mode === 'benchmarks' ? alpha.display_name! : beta.display_name!
			const second =
				mode === 'benchmarks' ? beta.display_name! : alpha.display_name!
			assert.ok(html.indexOf(first) < html.indexOf(second))
			assert.ok(html.includes(stats.window_start))
			assert.ok(html.includes(stats.window_end))
			assert.ok(html.includes(`value="${search.metric}" selected=""`))
			assert.ok(html.includes('value="30d" selected=""'))
			assert.ok(html.includes(publicMessages[locale].outputTokens))
			assert.ok(html.includes(publicMessages[locale].totalTokens))
			assert.ok(html.includes(`href="/${locale}${modelHref(alpha)}"`))
			assert.doesNotMatch(html, /cinatoken\.public\./)
		})
	}
}

test('restored typed failures render an error, while real empty catalog data retains its distinct successful empty state', () => {
	const failed = render(
		'en',
		element(ModelCatalogPage, {
			search: validateModelCatalogSearch({}),
			onSearchChange: noop,
		}),
		(client) =>
			restorePublicQueries(client, [
				{
					kind: 'models',
					result: {
						status: 'error',
						error: { code: 'http', status: 503, retryAfter: null },
						observedAt: Date.now(),
					},
				},
			])
	)
	assert.ok(failed.includes(publicMessages.en.unavailable))
	assert.ok(!failed.includes(publicMessages.en.empty))
	assert.ok(!failed.includes(publicMessages.en.loading))
	const empty = render(
		'en',
		element(ModelCatalogPage, {
			search: validateModelCatalogSearch({}),
			onSearchChange: noop,
		}),
		(client) =>
			client.setQueryData(['cinatoken', 'public', 'models'], {
				...models,
				data: [],
			})
	)
	assert.ok(empty.includes(publicMessages.en.empty))
	assert.ok(!empty.includes(publicMessages.en.unavailable))
})
