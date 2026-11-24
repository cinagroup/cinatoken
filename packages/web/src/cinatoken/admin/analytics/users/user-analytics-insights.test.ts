/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { userAnalyticsRowSchema } from './user-analytics-contracts'
import { userAnalyticsFixtureRow } from './user-analytics-fixtures'
import { summarizeUserAnalyticsRows } from './user-analytics-insights'

function row(requests: number, successes: number, errors: number) {
	return userAnalyticsRowSchema.parse({
		...userAnalyticsFixtureRow,
		request_count: requests,
		distinct_models: requests ? 1 : 0,
		success_count: successes,
		error_count: errors,
		success_rate: requests ? (successes / requests) * 100 : 0,
	})
}

test('user summary aggregates exact counts before calculating the weighted success rate', () => {
	const summary = summarizeUserAnalyticsRows([row(10, 1, 2), row(90, 81, 7)])
	assert.equal(summary.requests, 100)
	assert.equal(summary.successes, 82)
	assert.equal(summary.errors, 9)
	assert.equal(summary.other, 9)
	assert.equal(summary.successRate, 82)
})

test('legacy success percentages never fabricate successful or other request counts', () => {
	const legacy = userAnalyticsRowSchema.parse(userAnalyticsFixtureRow)
	const summary = summarizeUserAnalyticsRows([legacy, row(3, 1, 1)])
	assert.equal(summary.requests, 6)
	assert.equal(summary.errors, 2)
	assert.equal(summary.successes, null)
	assert.equal(summary.other, null)
	assert.equal(summary.successRate, null)
	assert.equal(summary.charged, 0.8)
	assert.equal(summary.metered, 0.6)
	assert.equal(summary.standard, 1.2)
})

test('empty user summary distinguishes no samples from actual zero successes', () => {
	assert.deepEqual(summarizeUserAnalyticsRows([]), {
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
	assert.equal(summarizeUserAnalyticsRows([row(2, 0, 1)]).successRate, 0)
	assert.equal(summarizeUserAnalyticsRows([row(0, 0, 0)]).successRate, null)
})

test('missing standard cost remains unknown while negative charge-minus-cost is preserved', () => {
	const summary = summarizeUserAnalyticsRows([
		{
			...row(2, 1, 1),
			standard_cost: undefined,
			charged_cost: 1,
			metered_cost: 4,
		},
		{ ...row(1, 1, 0), standard_cost: 9, charged_cost: 2, metered_cost: 3 },
	])
	assert.equal(summary.standard, null)
	assert.equal(summary.charged, 3)
	assert.equal(summary.metered, 7)
	assert.equal(summary.costDifference, -4)
})

test('search-subset summaries use only supplied rows and never mutate them', () => {
	const a = Object.freeze({ ...row(10, 8, 1), user_email: 'a@example.test' })
	const b = Object.freeze({ ...row(30, 15, 10), user_email: 'b@example.test' })
	const rows = Object.freeze([a, b])
	const summary = summarizeUserAnalyticsRows(
		rows.filter((item) => item.user_email.startsWith('b'))
	)
	assert.equal(summary.requests, 30)
	assert.equal(summary.successRate, 50)
	assert.equal(summary.other, 5)
	assert.deepEqual(rows, [a, b])
})

test('user contract preserves optional exact success count and accepts equivalent floating arithmetic', () => {
	const parsed = userAnalyticsRowSchema.parse({
		...userAnalyticsFixtureRow,
		success_count: 1,
	})
	assert.equal(parsed.success_count, 1)
	assert.equal(
		userAnalyticsRowSchema.parse(userAnalyticsFixtureRow).success_count,
		undefined
	)
})

test('user contract rejects malformed, impossible, or contradictory supplied success counts', () => {
	for (const success_count of [
		null,
		-1,
		0.5,
		Number.NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
		3,
	]) {
		assert.equal(
			userAnalyticsRowSchema.safeParse({
				...userAnalyticsFixtureRow,
				success_count,
			}).success,
			false
		)
	}
	assert.equal(
		userAnalyticsRowSchema.safeParse({
			...userAnalyticsFixtureRow,
			success_count: 2,
		}).success,
		false
	)
	assert.equal(
		userAnalyticsRowSchema.safeParse({ ...row(0, 0, 0), success_rate: 1 })
			.success,
		false
	)
	assert.equal(
		userAnalyticsRowSchema.safeParse({ ...row(3, 1, 1), success_rate: 33.3 })
			.success,
		false
	)
})
