/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	providerReliabilitySchema,
	modelProviderReliabilitySchema,
	reliabilityResponseSchema,
} from './reliability-contracts'
import {
	groupReliabilityModels,
	reliabilityErrorLogHref,
	reliabilityQueryPrefix,
	summarizeReliabilityRows,
} from './reliability-domain'

const row = {
	provider_id: 'provider:1',
	provider_name: 'Shared name',
	request_count: 3,
	success_count: 1,
	error_count: 1,
	success_rate: 100 / 3,
	avg_latency_ms: null,
	avg_upstream_response_ms: null,
	failover_rate: 200,
	avg_attempts: 3,
	failover_request_count: 2,
	failover_request_rate: 200 / 3,
	charged_cost: 2,
	metered_cost: 3,
	standard_cost: 4,
}

test('reliability preserves additive request measures and legacy events over100 independently', () => {
	const current = providerReliabilitySchema.parse(row)
	assert.equal(current.failover_rate, 200)
	assert.equal(current.failover_request_count, 2)
	const legacy = providerReliabilitySchema.parse({
		...row,
		failover_request_count: undefined,
		failover_request_rate: undefined,
	})
	assert.equal(legacy.failover_request_count, undefined)
	assert.equal(legacy.failover_request_rate, undefined)
	assert.equal(legacy.failover_rate, 200)
	assert.equal(
		providerReliabilitySchema.parse({
			...row,
			failover_request_count: 0,
			failover_request_rate: 0,
		}).failover_request_rate,
		0
	)
})

test('both reliability row types reject incomplete, impossible and inconsistent request failover pairs', () => {
	for (const change of [
		{ failover_request_count: undefined },
		{ failover_request_rate: undefined },
		{ failover_request_count: null },
		{ failover_request_rate: null },
		{ failover_request_count: 4 },
		{ failover_request_count: -1 },
		{ failover_request_count: 0.5 },
		{ failover_request_rate: 101 },
		{ failover_request_rate: 50 },
		{ failover_request_rate: Number.NaN },
		{ failover_request_count: 0, failover_request_rate: 0.1 },
		{ failover_request_count: 3, failover_request_rate: 99.9 },
	]) {
		assert.equal(
			providerReliabilitySchema.safeParse({ ...row, ...change }).success,
			false
		)
		assert.equal(
			modelProviderReliabilitySchema.safeParse({
				...row,
				model_id: 'm',
				...change,
			}).success,
			false
		)
	}
	assert.equal(
		providerReliabilitySchema.safeParse({
			...row,
			failover_request_rate: 66.66667,
		}).success,
		true
	)
})

test('provider exact counts must agree with totals and the supplied success rate', () => {
	for (const change of [
		{ success_count: 3 },
		{ success_rate: 50 },
		{ success_count: 0.5 },
	])
		assert.equal(
			providerReliabilitySchema.safeParse({ ...row, ...change }).success,
			false
		)
	assert.equal(
		providerReliabilitySchema.safeParse({
			...row,
			request_count: 0,
			success_count: 0,
			error_count: 0,
			success_rate: 0,
			failover_request_count: 0,
			failover_request_rate: 0,
		}).success,
		true
	)
})

test('summary weights exact successful counts and preserves other states, missing standard and negative difference', () => {
	const summary = summarizeReliabilityRows([
		providerReliabilitySchema.parse(row),
		providerReliabilitySchema.parse({
			...row,
			provider_id: 'p2',
			request_count: 9,
			success_count: 9,
			error_count: 0,
			success_rate: 100,
			failover_request_count: 0,
			failover_request_rate: 0,
			standard_cost: undefined,
		}),
	])
	assert.deepEqual(summary, {
		requests: 12,
		successes: 10,
		errors: 1,
		other: 1,
		successRate: (10 / 12) * 100,
		standard: null,
		charged: 4,
		metered: 6,
		costDifference: -2,
	})
	assert.deepEqual(summarizeReliabilityRows([]), {
		requests: 0,
		successes: 0,
		errors: 0,
		other: 0,
		successRate: null,
		standard: 0,
		charged: 0,
		metered: 0,
		costDifference: 0,
	})
})

test('error log deep links retain exact encoded provider and validated UTC time range', () => {
	const range = {
		startUtc: '2026-10-01 00:00:00',
		endUtc: '2026-10-02 00:00:00',
	}
	const id = 'provider:/a?x=1&name=東京'
	const url = new URL(
		reliabilityErrorLogHref(range, id),
		'https://local.invalid'
	)
	assert.equal(url.pathname, '/admin/request-logs')
	assert.deepEqual(Object.fromEntries(url.searchParams), {
		status: 'error',
		start_date: range.startUtc,
		end_date: range.endUtc,
		provider_id: id,
	})
	assert.equal(
		new URL(reliabilityErrorLogHref(range), url).searchParams.has(
			'provider_id'
		),
		false
	)
	assert.throws(() =>
		reliabilityErrorLogHref({ ...range, endUtc: '2026-02-30 00:00:00' })
	)
})

test('grouping model comparisons preserves first-seen group/provider order without mutation', () => {
	const first = modelProviderReliabilitySchema.parse({
		...row,
		model_id: '__proto__',
	})
	const second = modelProviderReliabilitySchema.parse({
		...row,
		model_id: 'm:1',
	})
	const third = modelProviderReliabilitySchema.parse({
		...row,
		model_id: '__proto__',
		provider_id: 'p2',
	})
	const input = Object.freeze([first, second, third])
	assert.deepEqual(groupReliabilityModels(input), [first, third, second])
	assert.deepEqual(input, [first, second, third])
})

test('response rejects duplicate aggregate/error identities but accepts colon-distinct model/provider pairs', () => {
	const provider = providerReliabilitySchema.parse(row)
	const model = modelProviderReliabilitySchema.parse({
		...row,
		model_id: 'a:b',
		provider_id: 'c',
	})
	const other = { ...model, model_id: 'a', provider_id: 'b:c' }
	const error = {
		id: 'e',
		model_id: null,
		provider_id: null,
		provider_name: null,
		status: 'error',
		created_at: '2026-10-01T00:00:00.000Z',
	}
	const data = {
		providers: [provider],
		modelProviders: [model, other],
		recentErrors: [error],
	}
	assert.equal(
		reliabilityResponseSchema.safeParse({ success: true, data }).success,
		true
	)
	for (const change of [
		{ providers: [provider, provider] },
		{ modelProviders: [model, model] },
		{ recentErrors: [error, error] },
		{ recentErrors: [{ ...error, status: 'success' }] },
	])
		assert.equal(
			reliabilityResponseSchema.safeParse({
				success: true,
				data: { ...data, ...change },
			}).success,
			false
		)
})

test('query prefixes distinguish principals, epochs, APIs and page instances', () => {
	const api = {},
		otherApi = {}
	const first = reliabilityQueryPrefix('scope', 'identity1', api, 'page1')
	assert.deepEqual(
		first,
		reliabilityQueryPrefix('scope', 'identity1', api, 'page1')
	)
	for (const changed of [
		reliabilityQueryPrefix('scope2', 'identity1', api, 'page1'),
		reliabilityQueryPrefix('scope', 'identity2', api, 'page1'),
		reliabilityQueryPrefix('scope', 'identity1', otherApi, 'page1'),
		reliabilityQueryPrefix('scope', 'identity1', api, 'page2'),
	])
		assert.notDeepEqual(first, changed)
})
