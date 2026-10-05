/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { userAnalyticsRowSchema } from './user-analytics-contracts'
import {
	formatLastActive,
	sortUserRows,
	userAnalyticsCsv,
	userCostTotals,
	userCsvColumns,
	userLogHref,
} from './user-analytics-domain'

const row = userAnalyticsRowSchema.parse({
	user_email: '=HYPERLINK("https://example.test")',
	request_count: 2,
	input_tokens: 1234,
	output_tokens: 5000000,
	standard_cost: 0.6,
	charged_cost: 0.4,
	metered_cost: 0.3,
	distinct_models: 1,
	last_active_at: '2026-09-28T02:05:06.000Z',
	budget_max: 10,
	budget_spent: 15,
	budget_usage_rate: 150,
	success_rate: 50,
	error_count: 1,
})
const range = {
	startUtc: '2026-09-28 00:00:00',
	endUtc: '2026-09-28 08:00:00',
}

test('CSV retains all 16 legacy columns while neutralizing email formulas', () => {
	assert.equal(userCsvColumns.length, 16)
	assert.throws(() => userAnalyticsCsv([row], range, null))
	const csv = userAnalyticsCsv([row], range, 'USD')
	assert.ok(csv.startsWith('\uFEFF'))
	assert.ok(csv.includes(`"'=HYPERLINK(""https://example.test"")"`))
	assert.equal(csv.split('\r\n').length, 2)
	assert.ok(csv.includes(',150,'))
})

test('missing standard cost is not invented as a zero in summary or CSV', () => {
	const missing = {
		...row,
		user_email: 'safe@example.test',
		standard_cost: undefined,
	}
	assert.deepEqual(userCostTotals([row, missing]), {
		standard: null,
		charged: 0.8,
		metered: 0.6,
	})
	assert.equal(
		userAnalyticsCsv([missing], range, 'USD').split('\r\n')[1]?.split(',')[4],
		''
	)
})

test('sort handles null budget and activity without clamping over-budget values', () => {
	const noBudget = {
		...row,
		user_email: 'none@example.test',
		last_active_at: null,
		budget_max: null,
		budget_usage_rate: null,
	}
	assert.deepEqual(
		sortUserRows([row, noBudget], 'budget_usage_rate', 'desc').map(
			(item) => item.budget_usage_rate
		),
		[150, null]
	)
	assert.equal(formatLastActive(null, 'Asia/Singapore', 'en'), null)
	assert.equal(row.budget_usage_rate, 150)
	assert.match(
		formatLastActive(row.last_active_at, 'Asia/Singapore', 'en')!,
		/10:05:06/
	)
})

test('Request Logs links use the selected row email and committed UTC range', () => {
	const main = new URL(
		userLogHref('a+b@example.test', range),
		'https://example.test'
	)
	const detail = new URL(
		userLogHref('a+b@example.test', range, {
			model_id: 'model/x',
			route_group: '+default',
		}),
		'https://example.test'
	)
	assert.equal(main.pathname, '/admin/request-logs')
	assert.deepEqual(Object.fromEntries(main.searchParams), {
		user_email: 'a+b@example.test',
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	assert.deepEqual(Object.fromEntries(detail.searchParams), {
		user_email: 'a+b@example.test',
		start_date: range.startUtc,
		end_date: range.endUtc,
		model_id: 'model/x',
		route_group: '+default',
	})
})
