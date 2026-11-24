/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminModelAnalyticsMessages } from '../models/messages'
import { UserAnalyticsControls } from './UserAnalyticsControls'
import { UserAnalyticsInsights } from './UserAnalyticsInsights'
import { UserAnalyticsTable } from './UserAnalyticsTable'
import { adminUserAnalyticsMessages } from './messages'
import { userAnalyticsCsv, userCostTotals } from './user-analytics-domain'
import type { UserAnalyticsDetailState } from './user-analytics-drilldowns'
import {
	userAnalyticsFixtureRow as row,
	userAnalyticsFixtureKeys as keys,
	userAnalyticsFixtureModel as model,
} from './user-analytics-fixtures'
import { summarizeUserAnalyticsRows } from './user-analytics-insights'
import {
	filterUserAnalyticsRows,
	userVisibleColumns,
	type UserAnalyticsView,
} from './user-analytics-view'

const range = { startUtc: '2026-10-23 00:00:00', endUtc: '2026-10-23 08:00:00' }
async function renderer(locale: 'en' | 'zh' | 'ja' | 'ko') {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminUserAnalytics: adminUserAnalyticsMessages[locale],
						adminModelAnalytics: adminModelAnalyticsMessages[locale],
					},
				},
			},
		},
		interpolation: { escapeValue: false },
	})
	return (element: Parameters<typeof renderToStaticMarkup>[0]) =>
		renderToStaticMarkup(createElement(I18nextProvider, { i18n }, element))
}
test('local email search is literal and case-insensitive; matched rows drive costs and the unchanged20-column CSV', () => {
	const rows = [
		{ ...row, user_email: ' A' },
		{ ...row, user_email: 'Match%_@example.test' },
		{ ...row, user_email: 'other@example.test' },
	]
	assert.deepEqual(filterUserAnalyticsRows(rows, ' %_ '), [rows[1]])
	assert.deepEqual(filterUserAnalyticsRows(rows, 'MATCH'), [rows[1]])
	assert.deepEqual(filterUserAnalyticsRows(rows, '  '), rows)
	const matched = filterUserAnalyticsRows(rows, 'match')
	assert.equal(userCostTotals(matched).charged, row.charged_cost)
	const csv = userAnalyticsCsv(matched, range, 'USD').split('\r\n')
	assert.equal(csv.length, 2)
	assert.equal(csv[0]!.split(',').length, 20)
	assert.ok(csv[1]!.startsWith('Match%_@example.test,'))
})
test('each view has identity columns and preserves wallet snapshots in budget/all views', () => {
	assert.deepEqual(userVisibleColumns('overview'), [
		'user_email',
		'request_count',
		'charged_cost',
		'distinct_models',
		'last_active_at',
		'success_rate',
	])
	assert.deepEqual(userVisibleColumns('cost'), [
		'user_email',
		'request_count',
		'input_tokens',
		'output_tokens',
		'standard_cost',
		'charged_cost',
		'metered_cost',
	])
	assert.deepEqual(userVisibleColumns('budget'), [
		'user_email',
		'request_count',
		'last_active_at',
		'wallet_granted',
		'wallet_spent',
		'wallet_balance',
		'budget_usage_rate',
	])
	assert.equal(userVisibleColumns('all').length, 14)
})
test('multiple user and Key states render independently with correct detail column spans in every view', async () => {
	const render = await renderer('en')
	const other = {
		...row,
		user_email: 'other@example.test',
		user_id: '22222222-2222-4222-8222-222222222222',
	}
	const details: ReadonlyMap<string, UserAnalyticsDetailState> = new Map([
		[
			row.user_email,
			{
				kind: 'models',
				state: { rows: [model], loading: false, error: false, retry() {} },
			},
		],
		[
			other.user_email,
			{
				kind: 'keys',
				state: { rows: keys, loading: false, error: false, retry() {} },
				keyModels: new Map([
					[
						keys[0]!.api_key_id!,
						{
							rows: [{ ...model, model_id: 'stale-private-model' }],
							loading: false,
							error: true,
							retry() {},
						},
					],
					[
						keys[1]!.api_key_id!,
						{ rows: [], loading: false, error: false, retry() {} },
					],
				]),
				toggleKey() {},
			},
		],
	])
	for (const view of ['overview', 'cost', 'budget', 'all'] as const) {
		const html = render(
			createElement(UserAnalyticsTable, {
				rows: [row, other],
				range,
				view,
				details,
				currency: 'USD',
				timezone: 'UTC',
				locale: 'en',
				tokenMode: 'numeric',
				logsAllowed: true,
				sortKey: 'request_count',
				sortDirection: 'desc',
				onSort() {},
				onToggle() {},
			})
		)
		assert.equal(
			(html.split('</thead>')[0]!.match(/<th /g) ?? []).length,
			userVisibleColumns(view).length
		)
		assert.equal(
			(
				html.match(
					new RegExp(`colSpan="${userVisibleColumns(view).length}"`, 'g')
				) ?? []
			).length,
			2
		)
		assert.ok(html.includes('colSpan="11"'))
		assert.ok(!html.includes('stale-private-model'))
		assert.ok(html.includes('No model usage for this Key'))
		assert.ok(html.includes('Toggle model usage for ' + row.user_email))
		assert.ok(html.includes('Toggle Key usage for ' + other.user_email))
		assert.ok(html.includes('user_id=' + other.user_id))
	}
})
test('four-language controls and exact summary retain unknown legacy counts and hide unverified amounts', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const render = await renderer(locale),
			messages = adminUserAnalyticsMessages[locale]
		for (const view of [
			'overview',
			'cost',
			'budget',
			'all',
		] satisfies UserAnalyticsView[]) {
			const html = render(
				createElement(UserAnalyticsControls, {
					view,
					onView() {},
					search: '',
					onSearch() {},
					count: 1,
					total: 3,
				})
			)
			assert.equal((html.match(/aria-pressed="true"/g) ?? []).length, 1)
			assert.ok(html.includes(messages.viewBudget.replace(/&/g, '&amp;')))
			assert.ok(!html.includes('cinatoken.adminUserAnalytics.'))
		}
		const html = render(
			createElement(UserAnalyticsInsights, {
				summary: summarizeUserAnalyticsRows([
					{ ...row, success_count: undefined },
				]),
				currency: null,
				locale,
			})
		)
		assert.ok(html.includes(messages.insightsUnknown))
		assert.ok(html.includes(messages.hidden))
		assert.ok(!html.includes('width:'))
		assert.ok(!html.includes('cinatoken.adminUserAnalytics.'))
	}
})
