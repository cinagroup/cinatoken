import assert from 'node:assert/strict'
import test from 'node:test'
import type { CatalogModel, CatalogPricing } from './catalog-contracts'
import {
	validateCompareSearch,
	validateModelCatalogSearch,
	validateProvidersSearch,
	validateStatsSearch,
} from './catalog-search'
import {
	facets,
	filterModels,
	filterProviders,
	formatMoney,
	imageTokenMode,
	modelHref,
	modelKey,
	modelName,
	paginate,
	priceOverview,
	sortStats,
	compareCatalogText,
	validateBenchmarkSearch,
} from './catalog-view-model'
import { buildCatalogExample } from './code-examples'

const tier = {
	upto: null,
	label: null,
	input_price: 2,
	output_price: 8,
	cache_read_price: 0,
	cache_write_price: 2.5,
	image_input_price: null,
	image_input_cache_price: null,
	image_output_price: null,
}
const model: CatalogModel = {
	id: 'author/model',
	slug: '~YXV0aG9yL21vZGVs',
	display_name: null,
	vendor: 'Vendor% Labs',
	context_window: null,
	max_tokens: 0,
	pricing_profile: { tiers: [tier] },
	tags: [],
	route_groups: ['default'],
	protocols: ['openai'],
	protocols_by_group: { default: ['openai'] },
	recommended_protocol: 'openai',
	description: null,
	input_modalities: ['text', 'image'],
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

test('shared URL state restores legacy CSV and typed arrays without extra selections or invalid numeric windows', () => {
	const search = validateModelCatalogSearch({
		q: 'author',
		vendors: 'Vendor% Labs,Other',
		inputs: ['text', 'text'],
		context: '128k',
		sort: 'price',
		view: 'table',
		page: '2',
	})
	assert.deepEqual(search.vendors, ['Vendor% Labs', 'Other'])
	assert.deepEqual(search.inputs, ['text'])
	assert.deepEqual(
		validateModelCatalogSearch({ vendors: '["Provider, A"]', output: 'image' })
			.vendors,
		['Provider, A']
	)
	assert.deepEqual(validateModelCatalogSearch({ output: 'image' }).outputs, [
		'image',
	])
	assert.equal(search.page, 2)
	assert.equal(
		validateModelCatalogSearch({ page: '-1', context: 'imaginary' }).context,
		'all'
	)
	assert.equal(
		validateStatsSearch({ range: 'all', page: 'Infinity' }).range,
		'7d'
	)
	assert.equal(validateStatsSearch({ page: 'Infinity' }).page, 1)
	assert.deepEqual(
		validateCompareSearch({ models: ['a', 'b', 'a', 'c', 'd', 'e'] }).models,
		['a', 'b', 'c', 'd']
	)
})

test('benchmark URL defaults retain latency while explicit metric and restored range remain authoritative', () => {
	assert.equal(validateStatsSearch({}).metric, 'popular')
	assert.equal(validateBenchmarkSearch(undefined).metric, 'latency')
	assert.equal(validateBenchmarkSearch({ metric: 'invalid' }).metric, 'latency')
	assert.deepEqual(
		validateBenchmarkSearch({ range: '30d', page: '2', q: 'model' }),
		{
			range: '30d',
			page: 2,
			q: 'model',
			metric: 'latency',
		}
	)
	assert.equal(validateBenchmarkSearch({ metric: 'popular' }).metric, 'popular')
	assert.equal(
		validateBenchmarkSearch({ metric: 'reliable' }).metric,
		'reliable'
	)
})

test('catalog search and tie ordering use one explicit English comparison in every runtime', () => {
	const names = ['Ömega', 'Alpha', 'Zeta', 'alpha']
	const expected = [...names].sort(
		new Intl.Collator('en', { sensitivity: 'variant' }).compare
	)
	assert.deepEqual([...names].sort(compareCatalogText), expected)
	assert.deepEqual(facets([names]), expected)
	const rows = names.map((name) => ({ ...model, id: name, display_name: name }))
	assert.deepEqual(
		filterModels(rows, validateModelCatalogSearch({ sort: 'name' })).map(
			modelName
		),
		expected
	)
	assert.equal(
		filterModels(
			[{ ...model, vendor: 'Istanbul' }],
			validateModelCatalogSearch({ q: 'ISTANBUL', vendors: ['istanbul'] })
		).length,
		1
	)
})

test('percent/unicode vendor and opaque real model IDs survive share URLs without name inference', () => {
	const row = { ...model, vendor: '供應商%: A, B' }
	const key = modelKey(row)
	const url = new URL(
		`https://portal.example/compare?models=${encodeURIComponent(key)}`
	)
	assert.deepEqual(
		validateCompareSearch({ models: url.searchParams.get('models') }).models,
		[key]
	)
	assert.equal(
		modelHref(row),
		`/models/${encodeURIComponent(row.vendor)}/${row.slug}`
	)
	assert.equal(modelName({ ...row, id: 'gpt-fake-name' }), 'gpt-fake-name')
})

test('unknown context/capabilities never pass minimum or modality filters; zero remains valid metadata', () => {
	const rows = [
		model,
		{ ...model, id: 'known', context_window: 128_000 },
		{ ...model, id: 'unknown-modalities', input_modalities: null },
	]
	assert.deepEqual(
		filterModels(rows, validateModelCatalogSearch({ context: '128k' })).map(
			(row) => row.id
		),
		['known']
	)
	assert.deepEqual(
		filterModels(
			rows,
			validateModelCatalogSearch({
				inputs: 'text,image',
				vendors: 'vendor% labs',
			})
		)
			.map((row) => row.id)
			.sort(),
		['author/model', 'known']
	)
	assert.equal(
		filterModels(rows, validateModelCatalogSearch({ q: 'gpt-4' })).length,
		0
	)
	assert.deepEqual(facets([null, [], ['audio', 'text', 'text']]), [
		'audio',
		'text',
	])
})

test('pricing mode matches Core: legacy blocks/cache-only image fields do not infer billing and fractional currency stays visible', () => {
	assert.deepEqual(
		priceOverview({
			tiers: [tier],
			image: { default: 100 },
			audio_billing_mode: 'token',
			audio: { price_per_second: 10 },
		}),
		[{ unit: 'token', input: 2, output: 8 }]
	)
	assert.equal(
		imageTokenMode({ tiers: [{ ...tier, image_input_cache_price: 1 }] }),
		false
	)
	assert.equal(
		imageTokenMode({ tiers: [{ ...tier, image_input_price: 1 }] }),
		true
	)
	assert.equal(
		imageTokenMode({ tiers: [tier], image_billing_mode: 'token' }),
		true
	)
	assert.deepEqual(
		priceOverview({
			tiers: [],
			image_billing_mode: 'per_image',
			image: { default: 0, input: { default: 0.01 } },
		}),
		[{ unit: 'image', input: 0.01, output: 0 }]
	)
	assert.deepEqual(
		priceOverview({
			tiers: [],
			audio_billing_mode: 'per_character',
			audio: { price_per_character: 0.000001, minimum_characters: 20 },
		}),
		[{ unit: 'character', input: 0.000001, output: null }]
	)
	assert.ok(formatMoney(0.000001, 'CNY', 'en').includes('0.000001'))
	assert.ok(formatMoney(-0.1, 'CNY', 'en').includes('-'))
})

test('price sorting groups units instead of treating one image as one million tokens', () => {
	const imageProfile: CatalogPricing = {
		tiers: [],
		image_billing_mode: 'per_image',
		image: { default: 0.001 },
	}
	const rows = [
		{ ...model, id: 'Image', pricing_profile: imageProfile },
		{
			...model,
			id: 'Expensive token',
			pricing_profile: { tiers: [{ ...tier, input_price: 10 }] },
		},
		{ ...model, id: 'Cheaper token' },
		{ ...model, id: 'Unknown', pricing_profile: null },
	]
	assert.deepEqual(
		filterModels(rows, validateModelCatalogSearch({ sort: 'price' })).map(
			(row) => row.id
		),
		['Cheaper token', 'Expensive token', 'Image', 'Unknown']
	)
	assert.equal(rows[0]?.id, 'Image')
})

test('providers are filtered aggregate authors and pagination clamps a restored page after filtering', () => {
	const provider = {
		id: 'vendor',
		display_name: 'Vendor',
		model_count: 4,
		protocols: ['openai' as const],
		route_groups: ['default'],
		input_modalities: ['text'],
		output_modalities: ['text'],
		latest_released_at: null,
	}
	assert.equal(
		filterProviders([provider], validateProvidersSearch({ outputs: 'image' }))
			.length,
		0
	)
	assert.equal(
		filterProviders([provider], validateProvidersSearch({ q: 'vendor' }))
			.length,
		1
	)
	const rows = Array.from({ length: 49 }, (_, id) => ({ id }))
	assert.equal(paginate(rows, 999).page, 3)
	assert.deepEqual(paginate(rows, 999).rows, [{ id: 48 }])
	assert.equal(paginate([], 999).pages, 1)
})

test('real observed stats keep missing latency last and sort success rate independently of popularity', () => {
	const row = {
		id: 'unknown',
		slug: 'unknown',
		display_name: 'Unknown',
		vendor: 'Vendor',
		request_count: 100,
		success_rate: 50,
		avg_latency_ms: null,
		output_tokens: 0,
		total_tokens: 30,
	}
	const rows = [
		row,
		{
			...row,
			id: 'known',
			display_name: 'Known',
			request_count: 20,
			success_rate: 100,
			avg_latency_ms: 0,
		},
	]
	assert.equal(
		sortStats(rows, validateStatsSearch({ metric: 'latency' }))[0]?.id,
		'known'
	)
	assert.equal(
		sortStats(rows, validateStatsSearch({ metric: 'reliable' }))[0]?.id,
		'known'
	)
	assert.equal(
		sortStats(rows, validateStatsSearch({ metric: 'popular' }))[0]?.id,
		'unknown'
	)
	assert.equal(rows[0]?.avg_latency_ms, null)
})

test('API examples require actual text capabilities/protocols and quote model IDs as data', () => {
	assert.equal(buildCatalogExample(model, 'anthropic'), null)
	assert.equal(
		buildCatalogExample({ ...model, output_modalities: ['image'] }, 'openai'),
		null
	)
	assert.equal(
		buildCatalogExample({ ...model, input_modalities: null }, 'openai'),
		null
	)
	assert.equal(
		buildCatalogExample(model, 'openai', 'https://user:private@example.com'),
		null
	)
	const code = buildCatalogExample(
		{ ...model, id: "bad'$(printf attack)" },
		'openai',
		'https://gateway.example/path'
	)!
	assert.ok(code.includes("curl 'https://gateway.example/v1/chat/completions'"))
	assert.ok(code.includes("bad'\"'\"'$(printf attack)"))
	assert.ok(code.includes('YOUR_API_KEY'))
	assert.ok(code.includes('Authorization: Bearer'))
})
