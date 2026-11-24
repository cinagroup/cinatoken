/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { StreamTimeoutCard } from './StreamTimeoutCard'
import { createAdminConfigApi } from './config-api'
import type { StreamTimeoutConfiguration } from './config-contracts'
import type { StreamTimeoutField } from './config-stream-timeout'
import { configFullMessages } from './messages'

async function render(
	locale: 'en' | 'zh' | 'ja' | 'ko',
	field: StreamTimeoutField,
	configuration: StreamTimeoutConfiguration | undefined
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: {
			[locale]: {
				translation: {
					cinatoken: { adminConfigFull: configFullMessages[locale] },
				},
			},
		},
	})
	const client = new QueryClient()
	const api = createAdminConfigApi({
		send: async () => assert.fail('Render cannot send requests'),
		invalidResponse: () => assert.fail(),
		sanitizeError: () => new Error(),
	})
	try {
		return renderToStaticMarkup(
			createElement(
				QueryClientProvider,
				{ client },
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(StreamTimeoutCard, {
						api,
						field,
						configuration,
						scopeKey: 'scope',
						reconciliationKey: JSON.stringify(['user', 'subject', 1]),
						canWrite: false,
						disabled: false,
						revalidate: async () => assert.fail(),
					})
				)
			)
		)
	} finally {
		client.clear()
	}
}
test('four translated timeout cards distinguish legacy interpretation, raw value, independent saves and cache delay', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(locale, 'streamFirstEventTimeoutMs', {
			value: '10ms',
			source: 'invalid',
			revision: 'legacy',
		})
		assert.ok(html.includes(configFullMessages[locale].streamTimeoutTitle!))
		assert.ok(html.includes('10ms'))
		assert.ok(html.includes(configFullMessages[locale].streamLegacy!))
		assert.ok(html.includes(configFullMessages[locale].streamCacheHint!))
		assert.equal(html.includes('<form'), false)
		assert.equal(html.includes('cinatoken.adminConfigFull.'), false)
	}
})
test('unavailable capabilities and unsafe legacy durations never masquerade as disabled settings', async () => {
	const missing = await render('en', 'streamFirstEventTimeoutMs', undefined)
	assert.ok(missing.includes(configFullMessages.en.streamUnavailable!))
	assert.equal(missing.includes(configFullMessages.en.streamDisabled!), false)
	const unsafe = await render('en', 'streamFirstEventTimeoutMs', {
		value: '2147483648',
		source: 'invalid',
		revision: 'legacy',
	})
	assert.ok(unsafe.includes(configFullMessages.en.streamUnsafeTimer!))
	const literal = await render('en', 'streamFirstEventTimeoutRouteGroups', {
		value: '*,vip',
		source: 'configured',
		revision: 'legacy',
	})
	assert.ok(literal.includes('*, vip'))
	assert.equal(literal.includes(configFullMessages.en.streamAllGroups!), false)
})
