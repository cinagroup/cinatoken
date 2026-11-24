/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, Fragment } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import {
	AnalyticsQualityHelp,
	StreamSpeedValue,
	FailoverRequestValue,
} from './AnalyticsQualityMetrics'
import { adminModelAnalyticsMessages } from './messages'

async function render(
	locale: 'en' | 'zh' | 'ja' | 'ko',
	row: Parameters<typeof StreamSpeedValue>[0]['row']
) {
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
			createElement(
				Fragment,
				null,
				createElement(StreamSpeedValue, { row, locale }),
				createElement(FailoverRequestValue, { row, locale }),
				createElement(AnalyticsQualityHelp)
			)
		)
	)
}

test('quality cells distinguish absent metrics, no samples and a measured zero in all four languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = adminModelAnalyticsMessages[locale]
		const absent = await render(locale, {})
		assert.equal(
			absent.split(messages.qualityUnavailable + '</span>').length - 1,
			2
		)
		const empty = await render(locale, {
			stream_tokens_per_second: null,
			stream_sample_count: 0,
			failover_request_count: 0,
			failover_request_rate: 0,
		})
		assert.ok(empty.includes(messages.noStreamSamples + '</div>'))
		assert.ok(
			empty.includes(messages.streamSamples.replace('{{samples}}', '0'))
		)
		const measured = await render(locale, {
			stream_tokens_per_second: 0,
			stream_sample_count: 2,
			failover_request_count: 3,
			failover_request_rate: 75,
		})
		assert.equal(measured.includes(messages.noStreamSamples + '</div>'), false)
		assert.ok(measured.includes('>0</div>'))
		assert.ok(
			measured.includes(messages.streamSamples.replace('{{samples}}', '2'))
		)
		assert.ok(
			measured.includes(messages.failoverRequests.replace('{{requests}}', '3'))
		)
		assert.equal(measured.includes('cinatoken.adminModelAnalytics.'), false)
	}
})

test('metric definitions are accessible without hovering and distinguish sample and event rates', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const messages = adminModelAnalyticsMessages[locale]
		const html = await render(locale, {})
		assert.match(html, /<details[^>]*><summary[^>]*>/)
		assert.ok(html.includes(messages.qualityHelp))
		assert.ok(html.includes(messages.streamDefinition))
		assert.ok(html.includes(messages.failoverDefinition))
		assert.ok(html.includes(messages.qualityUnavailableHint))
	}
})
