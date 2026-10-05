/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { modelProviderRowSchema } from '../models/model-analytics-contracts'
import {
	providerAnalyticsCsv,
	providerCostTotals,
	providerCsvColumns,
	providerLogHref,
	sortProviderRows,
} from './provider-analytics-domain'

const row = modelProviderRowSchema.parse({
	provider_id: '=HYPERLINK("https://example.test")',
	provider_name: ' +SUM(1,2)',
	distinct_models: 2,
	request_count: 2,
	input_tokens: 1234,
	output_tokens: 5000000,
	cache_read_tokens: 20,
	cache_write_tokens: 4,
	cache_hit_rate: 20,
	standard_cost: 0.6,
	charged_cost: 0.4,
	metered_cost: 0.3,
	success_count: 1,
	error_count: 1,
	success_rate: 50,
	avg_latency_ms: null,
	avg_first_reasoning_token_ms: 31,
	avg_first_token_ms: 20,
	avg_effective_ttft_ms: 20,
	avg_reasoning_phase_ms: 11,
	reasoning_ttft_rate: 50,
	content_ttft_rate: 50,
	avg_upstream_response_ms: null,
	tokens_per_second: null,
	failover_rate: 150,
	avg_attempts: null,
	avg_charged_per_request: 0.2,
})
const range = {
	startUtc: '2026-09-28 00:00:00',
	endUtc: '2026-09-28 01:00:00',
}

test('CSV has the original 28 columns, neutralizes formulas and refuses unknown currency', () => {
	assert.equal(providerCsvColumns.length, 28)
	assert.throws(() => providerAnalyticsCsv([row], range, null))
	const csv = providerAnalyticsCsv([row], range, 'USD')
	assert.ok(csv.startsWith('\uFEFF'))
	assert.ok(csv.includes(`"'=HYPERLINK(""https://example.test"")"`))
	assert.ok(csv.includes("' +SUM(1,2)"))
	assert.equal(csv.split('\r\n').length, 2)
	assert.ok(csv.includes('150'))
})

test('missing legacy standard cost stays unavailable in summary, row and CSV', () => {
	const missing = {
		...row,
		provider_id: 'missing',
		provider_name: 'Safe',
		standard_cost: undefined,
	}
	assert.deepEqual(providerCostTotals([row, missing]), {
		standard: null,
		charged: 0.8,
		metered: 0.6,
	})
	const csv = providerAnalyticsCsv([missing], range, 'USD')
	assert.equal(csv.split('\r\n')[1]?.split(',')[8], '')
})

test('sort uses display name fallback, null metrics and keeps source stable on ties', () => {
	const named = { ...row, provider_id: 'Zulu', provider_name: 'Zulu' }
	const fallback = { ...row, provider_id: 'Alpha', provider_name: null }
	assert.deepEqual(
		sortProviderRows([named, fallback], 'provider_name', 'asc').map(
			(item) => item.provider_id
		),
		['Alpha', 'Zulu']
	)
	assert.equal(
		sortProviderRows([row, fallback], 'avg_latency_ms', 'asc')[0],
		row
	)
	assert.equal(row.failover_rate, 150)
})

test('Request Logs link uses committed provider, model, route group and range', () => {
	const link = providerLogHref('provider/a', range, {
		model_id: 'model?x',
		route_group: '+default',
	})
	const url = new URL(link, 'https://example.test')
	assert.equal(url.pathname, '/admin/request-logs')
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		provider_id: 'provider/a',
		start_date: range.startUtc,
		end_date: range.endUtc,
		model_id: 'model?x',
		route_group: '+default',
	})
})
