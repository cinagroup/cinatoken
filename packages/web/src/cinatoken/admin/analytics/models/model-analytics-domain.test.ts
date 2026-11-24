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

test('CSV keeps the original 28 columns before additive metrics and neutralizes formulas', () => {
	assert.equal(modelCsvColumns.length, 32)
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

test('quality metric sorting keeps unknown and no-sample values last in either direction', () => {
	const missing = { ...row, model_id: 'legacy' }
	const noSamples = {
		...row,
		model_id: 'no-samples',
		stream_tokens_per_second: null,
		stream_sample_count: 0,
	}
	const high = {
		...row,
		model_id: 'high',
		stream_tokens_per_second: 50,
		stream_sample_count: 1,
		failover_request_count: 2,
		failover_request_rate: 100,
	}
	const zero = {
		...row,
		model_id: 'zero',
		stream_tokens_per_second: 0,
		stream_sample_count: 1,
		failover_request_count: 0,
		failover_request_rate: 0,
	}
	const tie = { ...zero, model_id: 'tie' }
	const source = [missing, high, zero, noSamples, tie]
	for (const key of [
		'stream_tokens_per_second',
		'failover_request_rate',
	] as const) {
		assert.deepEqual(
			sortModelRows(source, key, 'asc').map((item) => item.model_id),
			['zero', 'tie', 'high', 'legacy', 'no-samples']
		)
		assert.deepEqual(
			sortModelRows(source, key, 'desc').map((item) => item.model_id),
			['high', 'zero', 'tie', 'legacy', 'no-samples']
		)
	}
	assert.deepEqual(
		source.map((item) => item.model_id),
		['legacy', 'high', 'zero', 'no-samples', 'tie']
	)
})

test('quality CSV appends exact values and leaves unavailable metrics blank', () => {
	assert.deepEqual(modelCsvColumns.slice(0, 28), [
		'model_id',
		'route_group',
		'request_count',
		'input_tokens',
		'output_tokens',
		'cache_read_tokens',
		'cache_write_tokens',
		'cache_hit_rate',
		'standard_cost',
		'charged_cost',
		'metered_cost',
		'success_count',
		'error_count',
		'success_rate',
		'avg_latency_ms',
		'avg_first_reasoning_token_ms',
		'avg_first_token_ms',
		'avg_effective_ttft_ms',
		'avg_reasoning_phase_ms',
		'reasoning_ttft_rate',
		'content_ttft_rate',
		'avg_upstream_response_ms',
		'tokens_per_second',
		'failover_rate',
		'avg_attempts',
		'avg_charged_per_request',
		'range_start_utc',
		'range_end_utc',
	])
	assert.deepEqual(modelCsvColumns.slice(28), [
		'stream_tokens_per_second',
		'stream_sample_count',
		'failover_request_count',
		'failover_request_rate',
	])
	const clean = { ...row, model_id: 'model-a', route_group: 'default' }
	const csv = modelAnalyticsCsv(
		[
			clean,
			{
				...clean,
				stream_tokens_per_second: 12.3456,
				stream_sample_count: 1,
				failover_request_count: 1,
				failover_request_rate: 50,
			},
			{
				...clean,
				stream_tokens_per_second: null,
				stream_sample_count: 0,
				failover_request_count: 0,
				failover_request_rate: 0,
			},
		],
		{ startUtc: '2026-09-28 00:00:00', endUtc: '2026-09-28 01:00:00' },
		'USD'
	)
	const lines = csv
		.split('\r\n')
		.slice(1)
		.map((line) => line.split(','))
	assert.deepEqual(
		lines.map((line) => line.slice(28)),
		[
			['', '', '', ''],
			['12.3456', '1', '1', '50'],
			['', '0', '0', '0'],
		]
	)
	assert.ok(lines.every((line) => line.length === 32 && line[23] === '150'))
})
