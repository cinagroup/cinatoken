/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeAnalyticsRows } from './analytics-insights'
import {
	filterModelAnalyticsRows,
	filterProviderAnalyticsRows,
} from './analytics-view'

type InsightsRow = Parameters<typeof summarizeAnalyticsRows>[0][number]
const row: InsightsRow = {
	request_count: 10,
	success_count: 8,
	error_count: 1,
	standard_cost: 6,
	charged_cost: 4,
	metered_cost: 3,
}

test('summary uses total success counts rather than averaging row percentages', () => {
	const rows = [
		{
			...row,
			request_count: 1,
			success_count: 1,
			error_count: 0,
			success_rate: 100,
		},
		{
			...row,
			request_count: 9,
			success_count: 0,
			error_count: 9,
			success_rate: 0,
		},
	]
	assert.deepEqual(summarizeAnalyticsRows(rows), {
		requests: 10,
		successes: 1,
		errors: 9,
		other: 0,
		successRate: 10,
		standard: 12,
		charged: 8,
		metered: 6,
		costDifference: 2,
	})
})

test('summary keeps outcomes beyond success and error in other without inferring successful requests', () => {
	const result = summarizeAnalyticsRows([
		row,
		{ ...row, request_count: 6, success_count: 2, error_count: 1 },
	])
	assert.equal(result.requests, 16)
	assert.equal(result.successes, 10)
	assert.equal(result.errors, 2)
	assert.equal(result.other, 4)
	assert.equal(result.successRate, 62.5)
})

test('empty and zero-request samples have a null rate while measured zero success stays zero', () => {
	const empty = {
		requests: 0,
		successes: 0,
		errors: 0,
		other: 0,
		successRate: null,
		standard: 0,
		charged: 0,
		metered: 0,
		costDifference: 0,
	}
	assert.deepEqual(summarizeAnalyticsRows([]), empty)
	assert.deepEqual(
		summarizeAnalyticsRows([
			{
				request_count: 0,
				success_count: 0,
				error_count: 0,
				standard_cost: 0,
				charged_cost: 0,
				metered_cost: 0,
			},
		]),
		empty
	)
	const failures = summarizeAnalyticsRows([
		{ ...row, success_count: 0, error_count: 10 },
	])
	assert.equal(failures.successRate, 0)
	assert.equal(failures.other, 0)
})

test('any missing standard cost makes the aggregate unknown but known zero stays zero', () => {
	const missing: InsightsRow = {
		request_count: 10,
		success_count: 8,
		error_count: 1,
		charged_cost: 4,
		metered_cost: 3,
	}
	for (const rows of [
		[row, missing],
		[missing, row],
	]) {
		const result = summarizeAnalyticsRows(rows)
		assert.equal(result.standard, null)
		assert.equal(result.charged, 8)
		assert.equal(result.metered, 6)
		assert.equal(result.costDifference, 2)
	}
	assert.equal(
		summarizeAnalyticsRows([{ ...row, standard_cost: undefined }]).standard,
		null
	)
	assert.equal(
		summarizeAnalyticsRows([{ ...row, standard_cost: 0 }]).standard,
		0
	)
})

test('cost difference preserves negative charges and losses without using standard cost', () => {
	const result = summarizeAnalyticsRows([
		{ ...row, standard_cost: 100, charged_cost: 2, metered_cost: 5 },
		{ ...row, standard_cost: 200, charged_cost: -1, metered_cost: 1 },
	])
	assert.equal(result.standard, 300)
	assert.equal(result.charged, 1)
	assert.equal(result.metered, 6)
	assert.equal(result.costDifference, -5)
	assert.equal(
		summarizeAnalyticsRows([{ ...row, charged_cost: 0, metered_cost: 5 }])
			.costDifference,
		-5
	)
})

test('model and provider search subsets summarize only the visible rows', () => {
	const models = [
		{ ...row, model_id: 'Model-A', route_group: 'Premium' },
		{ ...row, model_id: 'Model-B', route_group: 'Default', charged_cost: 12 },
	]
	assert.deepEqual(
		summarizeAnalyticsRows(filterModelAnalyticsRows(models, ' premium ')),
		summarizeAnalyticsRows([row])
	)
	const providers = [
		{ ...row, provider_id: 'provider-a', provider_name: null },
		{
			...row,
			provider_id: 'provider-b',
			provider_name: 'Cloud',
			charged_cost: 12,
		},
	]
	assert.deepEqual(
		summarizeAnalyticsRows(
			filterProviderAnalyticsRows(providers, ' PROVIDER-A ')
		),
		summarizeAnalyticsRows([row])
	)
	assert.equal(
		summarizeAnalyticsRows(filterModelAnalyticsRows(models, 'missing'))
			.requests,
		0
	)
	assert.equal(
		summarizeAnalyticsRows(filterProviderAnalyticsRows(providers, 'missing'))
			.successRate,
		null
	)
})

test('summary does not mutate readonly rows or retain accumulator state between calls', () => {
	const rows = Object.freeze([
		Object.freeze({ ...row }),
		Object.freeze({ ...row, charged_cost: 10 }),
	])
	const before = structuredClone(rows)
	const first = summarizeAnalyticsRows(rows)
	const second = summarizeAnalyticsRows(rows)
	assert.deepEqual(rows, before)
	assert.deepEqual(first, second)
	assert.notEqual(first, second)
	first.charged = 999
	assert.equal(second.charged, 14)
	assert.equal(summarizeAnalyticsRows(rows).charged, 14)
})
