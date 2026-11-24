/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AnalyticsInsights } from './AnalyticsInsights'
import { ModelAnalyticsSummary } from './ModelAnalyticsSummary'
import { summarizeAnalyticsRows } from './analytics-insights'
import { adminModelAnalyticsMessages } from './messages'

const totals = summarizeAnalyticsRows([
	{
		request_count: 90,
		success_count: 81,
		error_count: 6,
		standard_cost: 54,
		charged_cost: 36,
		metered_cost: 27,
	},
	{
		request_count: 10,
		success_count: 2,
		error_count: 3,
		charged_cost: 4,
		metered_cost: 17,
	},
])
type Locale = 'en' | 'zh' | 'ja' | 'ko'
async function render(node: ReactNode, locale: Locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminModelAnalytics: adminModelAnalyticsMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}

test('four languages expose weighted outcomes, negative cost difference and scope definitions for both analytics pages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const m = adminModelAnalyticsMessages[locale]
		for (const scope of ['models', 'providers'] as const) {
			const html = await render(
				createElement(AnalyticsInsights, {
					summary: totals,
					currency: 'USD',
					locale,
					scope,
				}),
				locale
			)
			for (const key of [
				'insightsTitle',
				'insightsRequests',
				'insightsSuccessRate',
				'insightsErrors',
				'insightsCostDifference',
				'insightsDefinitions',
				'insightsRateNote',
				'insightsOtherNote',
				'insightsCostNote',
			] as const)
				assert.ok(html.includes(m[key]), `${locale}/${scope}/${key}`)
			assert.ok(
				html.includes(
					m[
						scope === 'models'
							? 'insightsScopeModels'
							: 'insightsScopeProviders'
					]
				)
			)
			assert.ok(
				html.includes(
					(0.83).toLocaleString(locale, {
						style: 'percent',
						minimumFractionDigits: 1,
						maximumFractionDigits: 1,
					})
				)
			)
			assert.match(html, /<dd[^>]*>100<\/dd>/)
			assert.match(html, /<dd[^>]*>9<\/dd>/)
			assert.ok(
				html.includes(
					m.insightsOutcomes
						.replace('{{success}}', '83')
						.replace('{{errors}}', '9')
						.replace('{{other}}', '8')
				)
			)
			assert.ok(
				html.includes(
					new Intl.NumberFormat(locale, {
						style: 'currency',
						currency: 'USD',
						minimumFractionDigits: 2,
						maximumFractionDigits: 4,
					}).format(-4)
				)
			)
			assert.equal((html.match(/<dt\b/g) ?? []).length, 4)
			assert.equal(html.includes('cinatoken.adminModelAnalytics.'), false)
			assert.equal(html.includes('{{'), false)
		}
	}
})

test('unknown currency hides only the monetary difference while outcomes stay visible; no requests is not zero-percent success', async () => {
	const hidden = await render(
		createElement(AnalyticsInsights, {
			summary: totals,
			currency: null,
			locale: 'en',
			scope: 'models',
		})
	)
	assert.ok(hidden.includes(adminModelAnalyticsMessages.en.hidden))
	assert.ok(hidden.includes('83.0%'))
	assert.doesNotMatch(hidden, /\$|NaN|Infinity/)
	const empty = await render(
		createElement(AnalyticsInsights, {
			summary: summarizeAnalyticsRows([]),
			currency: 'CNY',
			locale: 'en',
			scope: 'providers',
		})
	)
	assert.ok(empty.includes(adminModelAnalyticsMessages.en.insightsNoSamples))
	assert.equal(empty.includes('0.0%'), false)
	assert.doesNotMatch(empty, /style="width:|NaN|Infinity/)
})

test('the existing cost toolbar preserves missing standard costs and disabled export when used with insight totals', async () => {
	const html = await render(
		createElement(ModelAnalyticsSummary, {
			currency: 'USD',
			locale: 'en',
			totals,
			tokenMode: 'compact',
			exportDisabled: true,
			onToggleTokens: () =>
				assert.fail('Static rendering cannot change token units'),
			onExport: () => assert.fail('Static rendering cannot trigger export'),
		})
	)
	assert.equal(totals.standard, null)
	assert.ok(html.includes(adminModelAnalyticsMessages.en.unavailable))
	assert.ok(html.includes('$40.00') && html.includes('$44.00'))
	assert.match(html, /<button[^>]*disabled=""[^>]*>Export CSV<\/button>/)
})
