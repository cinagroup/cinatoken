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

test('CSV keeps the original 28 columns before additive metrics and neutralizes formulas', () => {
	assert.equal(providerCsvColumns.length, 35)
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

test('quality metric sorting keeps unknown and no-sample values last in either direction', () => {
	const missing = { ...row, provider_id: 'legacy' }
	const noSamples = {
		...row,
		provider_id: 'no-samples',
		stream_tokens_per_second: null,
		stream_sample_count: 0,
	}
	const high = {
		...row,
		provider_id: 'high',
		stream_tokens_per_second: 50,
		stream_sample_count: 1,
		failover_request_count: 2,
		failover_request_rate: 100,
	}
	const zero = {
		...row,
		provider_id: 'zero',
		stream_tokens_per_second: 0,
		stream_sample_count: 1,
		failover_request_count: 0,
		failover_request_rate: 0,
	}
	const tie = { ...zero, provider_id: 'tie' }
	const source = [missing, high, zero, noSamples, tie]
	for (const key of [
		'stream_tokens_per_second',
		'failover_request_rate',
	] as const) {
		assert.deepEqual(
			sortProviderRows(source, key, 'asc').map((item) => item.provider_id),
			['zero', 'tie', 'high', 'legacy', 'no-samples']
		)
		assert.deepEqual(
			sortProviderRows(source, key, 'desc').map((item) => item.provider_id),
			['high', 'zero', 'tie', 'legacy', 'no-samples']
		)
	}
	assert.deepEqual(
		source.map((item) => item.provider_id),
		['legacy', 'high', 'zero', 'no-samples', 'tie']
	)
})

test('quality CSV appends exact values and leaves unavailable metrics blank', () => {
	assert.deepEqual(providerCsvColumns.slice(0, 28), [
		'provider_id',
		'provider_name',
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
	assert.deepEqual(providerCsvColumns.slice(28, 32), [
		'stream_tokens_per_second',
		'stream_sample_count',
		'failover_request_count',
		'failover_request_rate',
	])
	const clean = {
		...row,
		provider_id: 'provider-a',
		provider_name: 'Provider A',
	}
	const csv = providerAnalyticsCsv(
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
		lines.map((line) => line.slice(28, 32)),
		[
			['', '', '', ''],
			['12.3456', '1', '1', '50'],
			['', '0', '0', '0'],
		]
	)
	assert.ok(lines.every((line) => line.length === 35 && line[23] === '150'))
})

test('provider type sorting uses known localized labels and leaves unavailable kinds last in both directions', () => {
	const rows = [
		{ ...row, provider_id: 'unknown', provider_name: 'Alpha' },
		{ ...row, provider_id: 'z', provider_name: 'Same account' },
		{ ...row, provider_id: 'a', provider_name: 'Same account' },
		{ ...row, provider_id: 'missing', provider_name: 'Another' },
	]
	const dimensions = new Map<
		string,
		import('./provider-dimensions').ProviderDimension
	>([
		[
			'unknown',
			{
				key: 'unavailable',
				kind: null,
				label: 'Unavailable',
				status: 'unavailable',
			},
		],
		['z', { key: 'kind:z', kind: 'z', label: 'Zeta', status: 'current' }],
		['a', { key: 'kind:a', kind: 'a', label: 'Alpha', status: 'current' }],
		[
			'missing',
			{ key: 'missing', kind: null, label: 'Unknown', status: 'missing' },
		],
	])
	assert.deepEqual(
		sortProviderRows(rows, 'provider_kind', 'asc', dimensions).map(
			(r) => r.provider_id
		),
		['a', 'z', 'unknown', 'missing']
	)
	assert.deepEqual(
		sortProviderRows(rows, 'provider_kind', 'desc', dimensions).map(
			(r) => r.provider_id
		),
		['z', 'a', 'unknown', 'missing']
	)
	assert.deepEqual(
		rows.map((r) => r.provider_id),
		['unknown', 'z', 'a', 'missing']
	)
})

test('provider CSV keeps the 32 existing columns before directory fields and escapes raw kinds and labels', () => {
	assert.deepEqual(providerCsvColumns.slice(32), [
		'provider_kind',
		'provider_kind_label',
		'provider_directory_status',
	])
	assert.deepEqual(providerCsvColumns.slice(28, 32), [
		'stream_tokens_per_second',
		'stream_sample_count',
		'failover_request_count',
		'failover_request_rate',
	])
	const rows = [
		{ ...row, provider_id: 'known', provider_name: 'Name' },
		{ ...row, provider_id: 'lost', provider_name: 'Historical' },
	]
	const dimensions = new Map<
		string,
		import('./provider-dimensions').ProviderDimension
	>([
		[
			'known',
			{
				key: 'kind:=CMD()',
				kind: '=CMD()',
				label: ' +SUM(1,2)',
				status: 'current',
			},
		],
		[
			'lost',
			{ key: 'missing', kind: null, label: 'Unknown type', status: 'missing' },
		],
	])
	const csv = providerAnalyticsCsv(rows, range, 'USD', dimensions)
	assert.ok(csv.includes(`,'=CMD(),"' +SUM(1,2)",current`))
	assert.ok(csv.endsWith(',,' + 'Unknown type,missing'))
	const unavailable = providerAnalyticsCsv(
		[{ ...row, provider_id: 'unknown', provider_name: 'Name' }],
		range,
		'CNY'
	)
	assert.ok(unavailable.endsWith(',,,unavailable'))
})
