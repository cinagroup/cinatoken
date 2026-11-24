/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { providerSortKeys } from '../providers/provider-analytics-domain'
import {
	analyticsColumnVisible,
	analyticsVisibleColumns,
	filterModelAnalyticsRows,
	filterProviderAnalyticsRows,
} from './analytics-view'
import { modelSortKeys } from './model-analytics-domain'

const expectedMetrics = {
	overview: [
		'request_count',
		'charged_cost',
		'success_rate',
		'avg_effective_ttft_ms',
		'failover_request_rate',
	],
	cost: [
		'request_count',
		'input_tokens',
		'output_tokens',
		'cache_hit_rate',
		'standard_cost',
		'charged_cost',
		'metered_cost',
		'avg_charged_per_request',
	],
	performance: [
		'request_count',
		'success_rate',
		'avg_latency_ms',
		'avg_effective_ttft_ms',
		'avg_upstream_response_ms',
		'stream_tokens_per_second',
		'failover_request_rate',
		'avg_attempts',
	],
} as const

test('model and provider views retain the legacy overview, cost and performance column mapping in current table order', () => {
	for (const view of ['overview', 'cost', 'performance'] as const) {
		assert.deepEqual(analyticsVisibleColumns(modelSortKeys, view), [
			'model_id',
			'route_group',
			...expectedMetrics[view],
		])
		assert.deepEqual(analyticsVisibleColumns(providerSortKeys, view), [
			'provider_name',
			'provider_kind',
			...expectedMetrics[view],
		])
	}
})

test('all preserves every current Web column including the two legacy metrics without changing source keys', () => {
	const tables: readonly (readonly string[])[] = [
		modelSortKeys,
		providerSortKeys,
	]
	for (const keys of tables) {
		const original = [...keys]
		const selected = analyticsVisibleColumns(keys, 'all')
		assert.deepEqual(selected, original)
		assert.notEqual(selected, keys)
		assert.deepEqual(keys, original)
	}
	for (const key of ['tokens_per_second', 'failover_rate']) {
		for (const view of ['overview', 'cost', 'performance'] as const)
			assert.equal(analyticsColumnVisible(key, view), false)
		assert.equal(analyticsColumnVisible(key, 'all'), true)
	}
})

test('identity columns remain available for sort fallback and subsets keep their given order', () => {
	for (const view of ['overview', 'cost', 'performance', 'all'] as const) {
		for (const key of [
			'model_id',
			'route_group',
			'provider_name',
			'provider_id',
		])
			assert.equal(analyticsColumnVisible(key, view), true)
	}
	const keys = Object.freeze([
		'avg_attempts',
		'provider_name',
		'charged_cost',
		'request_count',
	] as const)
	assert.deepEqual(analyticsVisibleColumns(keys, 'cost'), [
		'provider_name',
		'charged_cost',
		'request_count',
	])
	assert.equal(analyticsColumnVisible('provider_kind', 'overview'), true)
	assert.equal(analyticsColumnVisible('unknown_column', 'performance'), false)
	assert.deepEqual(analyticsVisibleColumns([], 'overview'), [])
})

const models = Object.freeze([
	Object.freeze({
		model_id: 'Claude-Sonnet',
		route_group: 'Premium',
		note: 'only-extra',
	}),
	Object.freeze({ model_id: 'GPT-4.1', route_group: 'DEFAULT', note: '' }),
	Object.freeze({ model_id: 'claude-haiku', route_group: 'default', note: '' }),
])

test('model search trims and matches case-insensitive model IDs or route groups while preserving input and row identity', () => {
	const before = structuredClone(models)
	const result = filterModelAnalyticsRows(models, '  CLAUDE \n')
	assert.deepEqual(result, [models[0], models[2]])
	assert.equal(result[0], models[0])
	assert.equal(result[1], models[2])
	assert.deepEqual(filterModelAnalyticsRows(models, '\t default  '), [
		models[1],
		models[2],
	])
	assert.deepEqual(filterModelAnalyticsRows(models, 'only-extra'), [])
	assert.deepEqual(filterModelAnalyticsRows(models, 'does-not-exist'), [])
	assert.deepEqual(models, before)
})

const providers = Object.freeze([
	Object.freeze({ provider_id: 'Provider-A', provider_name: 'Shared Cloud' }),
	Object.freeze({ provider_id: 'Deleted-B', provider_name: null }),
	Object.freeze({ provider_id: 'provider-c', provider_name: '' }),
	Object.freeze({ provider_id: 'provider-d', provider_name: 'SHARED Cloud' }),
])

test('provider search matches names and IDs including null and empty-name fallbacks', () => {
	const before = structuredClone(providers)
	const result = filterProviderAnalyticsRows(providers, ' shared CLOUD ')
	assert.deepEqual(result, [providers[0], providers[3]])
	assert.equal(result[0], providers[0])
	assert.equal(result[1], providers[3])
	assert.deepEqual(filterProviderAnalyticsRows(providers, ' deleted-b '), [
		providers[1],
	])
	assert.deepEqual(filterProviderAnalyticsRows(providers, 'PROVIDER-C'), [
		providers[2],
	])
	assert.deepEqual(filterProviderAnalyticsRows(providers, 'provider-a'), [
		providers[0],
	])
	assert.deepEqual(filterProviderAnalyticsRows(providers, 'does-not-exist'), [])
	assert.deepEqual(providers, before)
})

test('empty local searches return all rows in a fresh array and support empty data', () => {
	for (const search of ['', '   ', '\t\n']) {
		const modelResult = filterModelAnalyticsRows(models, search)
		assert.deepEqual(modelResult, models)
		assert.notEqual(modelResult, models)
		const providerResult = filterProviderAnalyticsRows(providers, search)
		assert.deepEqual(providerResult, providers)
		assert.notEqual(providerResult, providers)
	}
	assert.deepEqual(filterModelAnalyticsRows([], 'name'), [])
	assert.deepEqual(filterProviderAnalyticsRows([], 'name'), [])
})
