/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { modelAnalyticsRowSchema } from './model-analytics-contracts'
import {
	formatTokens,
	modelAnalyticsCsv,
	modelCostTotals,
	modelLogHref,
	modelCsvColumns,
	sortModelRows,
	ttftPrimary,
} from './model-analytics-domain'

const row = modelAnalyticsRowSchema.parse({
	model_id: '=HYPERLINK("https://example.test")',
	route_group: ' +SUM(1,2)',
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

test('CSV has exactly 28 safe columns, neutralizes formula cells, and refuses untrusted currency', () => {
	assert.equal(modelCsvColumns.length, 28)
	assert.throws(() =>
		modelAnalyticsCsv(
			[row],
			{ startUtc: '2026-09-28 00:00:00', endUtc: '2026-09-28 01:00:00' },
			null
		)
	)
	const csv = modelAnalyticsCsv(
		[row],
		{ startUtc: '2026-09-28 00:00:00', endUtc: '2026-09-28 01:00:00' },
		'USD'
	)
	assert.ok(csv.startsWith('\uFEFF'))
	assert.ok(csv.includes(`"'=HYPERLINK(""https://example.test"")"`))
	assert.ok(csv.includes("' +SUM(1,2)"))
	assert.ok(csv.includes('150'))
	assert.equal(csv.split('\r\n').length, 2)
})

test('sort and display preserve exact tokens, null metrics and multi-failover rates', () => {
	const other = { ...row, model_id: 'model-b', charged_cost: 2 }
	assert.deepEqual(
		sortModelRows([other, row], 'charged_cost', 'asc').map(
			(item) => item.charged_cost
		),
		[0.4, 2]
	)
	assert.equal(formatTokens(1234, 'numeric', 'en'), '1,234')
	assert.equal(formatTokens(1234, 'compact', 'en'), '1.23K')
	assert.deepEqual(ttftPrimary(row), { kind: 'R', value: 31 })
	assert.equal(row.avg_latency_ms, null)
	assert.equal(row.failover_rate, 150)
})

test('missing legacy standard cost never becomes a confirmed zero total', () => {
	assert.deepEqual(modelCostTotals([row]), {
		standard: 0.6,
		charged: 0.4,
		metered: 0.3,
	})
	assert.deepEqual(
		modelCostTotals([row, { ...row, standard_cost: undefined }]),
		{ standard: null, charged: 0.8, metered: 0.6 }
	)
	const csv = modelAnalyticsCsv(
		[
			{
				...row,
				model_id: 'model-a',
				route_group: 'default',
				standard_cost: undefined,
			},
		],
		{ startUtc: '2026-09-28 00:00:00', endUtc: '2026-09-28 01:00:00' },
		'USD'
	)
	assert.equal(csv.split('\r\n')[1]?.split(',')[8], '')
})

test('Request Logs link encodes committed model, group, range and provider identity', () => {
	const link = modelLogHref(
		{ model_id: 'a/b', route_group: '+default' },
		{ startUtc: '2026-09-28 00:00:00', endUtc: '2026-09-28 01:00:00' },
		{ provider_id: 'id?x' }
	)
	const url = new URL(link, 'https://example.test')
	assert.equal(url.pathname, '/admin/request-logs')
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		model_id: 'a/b',
		route_group: '+default',
		start_date: '2026-09-28 00:00:00',
		end_date: '2026-09-28 01:00:00',
		provider_id: 'id?x',
	})
})
