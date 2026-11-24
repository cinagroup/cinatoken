/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AnalyticsViewControls } from './AnalyticsViewControls'
import type { AnalyticsView } from './analytics-view'
import { adminModelAnalyticsMessages } from './messages'

type Locale = 'en' | 'zh' | 'ja' | 'ko'
async function render(
	locale: Locale,
	scope: 'models' | 'providers',
	view: AnalyticsView = 'overview',
	search = 'Cloud'
): Promise<string> {
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
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(AnalyticsViewControls, {
				scope,
				view,
				search,
				count: 2,
				total: 12,
				onView: () =>
					assert.fail('Rendering must not change the selected view'),
				onSearch: () => assert.fail('Rendering must not change local search'),
			})
		)
	)
}

test('four languages explain view controls, local search scope, matching counts and full-column CSV without untranslated keys', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = adminModelAnalyticsMessages[locale]
		for (const scope of ['models', 'providers'] as const) {
			const html = await render(locale, scope)
			for (const label of [
				messages.viewLabel,
				messages.viewOverview,
				messages.viewCost,
				messages.viewPerformance,
				messages.viewAll,
				messages.viewClearSearch,
				messages.viewSearchHint,
				messages.viewCsvHint,
				scope === 'models'
					? messages.viewSearchModels
					: messages.viewSearchProviders,
			])
				assert.ok(html.includes(label), `${locale}/${scope}: ${label}`)
			assert.ok(
				html.includes(
					messages.viewMatching
						.replace('{{matched}}', '2')
						.replace('{{total}}', '12')
				)
			)
			assert.equal(html.includes('cinatoken.adminModelAnalytics.'), false)
			assert.equal(html.includes('{{'), false)
			assert.equal(html.includes('<form'), false)
		}
	}
})

test('every controlled view has one pressed button and labeled search with an associated scope hint', async () => {
	for (const view of ['overview', 'cost', 'performance', 'all'] as const) {
		const html = await render('en', 'models', view)
		const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
		const pressed = buttons.filter((button) =>
			button.includes('aria-pressed="true"')
		)
		assert.equal(pressed.length, 1)
		const labels = {
			overview: 'Overview',
			cost: 'Cost',
			performance: 'Performance',
			all: 'All columns',
		}
		assert.ok(pressed[0].includes(labels[view]))
		assert.equal(
			buttons.filter((button) => button.includes('aria-pressed="false"'))
				.length,
			3
		)
		assert.ok(buttons.every((button) => button.includes('type="button"')))
		assert.match(html, /role="group"[^>]*aria-labelledby="[^"]+-view"/)
		const input = html.match(/<input\b[^>]*>/)?.[0] ?? ''
		const id = input.match(/\bid="([^"]+)"/)?.[1]
		const hint = input.match(/\baria-describedby="([^"]+)"/)?.[1]
		assert.ok(id && html.includes(`for="${id}"`))
		assert.ok(hint && html.includes(`id="${hint}"`))
		assert.ok(input.includes('type="search"'))
		assert.ok(input.includes('value="Cloud"'))
		assert.ok(html.includes('role="status"'))
	}
})

test('clear is available for a nonempty controlled search, disabled when empty, and search text is escaped', async () => {
	const empty = await render('en', 'models', 'overview', '')
	const filled = await render(
		'en',
		'providers',
		'cost',
		'<script>alert(1)</script>'
	)
	const clearButton = (html: string) =>
		(html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find((button) =>
			button.includes('Clear search')
		) ?? ''
	assert.match(clearButton(empty), /\bdisabled=""/)
	assert.doesNotMatch(clearButton(filled), /\bdisabled=""/)
	assert.equal(filled.includes('<script>'), false)
	assert.ok(filled.includes('value="&lt;script&gt;alert(1)&lt;/script&gt;"'))
})
