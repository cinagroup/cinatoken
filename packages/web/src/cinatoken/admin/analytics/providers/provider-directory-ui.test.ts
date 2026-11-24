/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminModelAnalyticsMessages } from '../models/messages'
import { ProviderDimensionInfo } from './ProviderDimensionInfo'
import { ProviderDirectoryControls } from './ProviderDirectoryControls'
import type { AnalyticsProviderDirectory } from './analytics-provider-directory'
import type { ProviderDimension } from './provider-dimensions'

type Locale = 'en' | 'zh' | 'ja' | 'ko'
async function render(node: ReactNode, locale: Locale): Promise<string> {
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
test('four languages distinguish missing, unavailable, unclassified and virtual suppliers without inventing deletion', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const m = adminModelAnalyticsMessages[locale]
		const ready: AnalyticsProviderDirectory = {
			status: 'ready',
			providers: new Map([
				[
					'unclassified',
					{ id: 'unclassified', name: 'OpenAI name alone is not a kind' },
				],
			]),
		}
		for (const [id, directory, expected] of [
			['missing', ready, m.directoryMissing],
			['missing', { status: 'unavailable' }, m.kindUnavailable],
			['unclassified', ready, m.kindUnclassified],
			['octafuse-tools', { status: 'unavailable' }, m.kindRest],
			['octafuse-mcp', { status: 'loading' }, m.kindMcp],
		] as const) {
			const html = await render(
				createElement(ProviderDimensionInfo, {
					providerId: id,
					directory,
					locale,
				}),
				locale
			)
			assert.ok(html.includes(expected))
			if (directory.status !== 'ready')
				assert.equal(html.includes(m.directoryMissing), false)
			assert.equal(html.includes('cinatoken.admin'), false)
		}
	}
})
test('a selected type remains selectable when the directory becomes unavailable and exposes an explicit clear action', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const m = adminModelAnalyticsMessages[locale]
		const html = await render(
			createElement(ProviderDirectoryControls, {
				directory: { status: 'unavailable' },
				isFetching: false,
				onRetry: () => assert.fail('Rendering cannot retry'),
				filter: {
					value: 'kind:openai',
					onChange: () => assert.fail('Rendering cannot broaden the filter'),
					dimensions: new Map(),
				},
			}),
			locale
		)
		assert.match(html, /<option value="kind:openai" selected="">/)
		for (const key of [
			'directorySelectedUnavailable',
			'directoryClearKind',
			'directoryUnavailable',
			'directoryHint',
			'directoryRetry',
		] as const)
			assert.ok(html.includes(m[key]))
		assert.equal(html.includes('cinatoken.admin'), false)
	}
})
test('type choices deduplicate by stable key while preserving distinct kinds with identical labels, and escape supplied labels', async () => {
	const dimension = {
		kind: 'a',
		label: '<script>same</script>',
		status: 'current' as const,
	}
	const dimensions = new Map<string, ProviderDimension>([
		['one', { ...dimension, key: 'kind:a' }],
		['two', { ...dimension, key: 'kind:a' }],
		['three', { ...dimension, key: 'kind:b', kind: 'b' }],
	])
	const html = await render(
		createElement(ProviderDirectoryControls, {
			directory: { status: 'ready', providers: new Map() },
			isFetching: false,
			onRetry: () => undefined,
			filter: { value: '', onChange: () => undefined, dimensions },
		}),
		'en'
	)
	assert.equal((html.match(/<option value="kind:a"/g) ?? []).length, 1)
	assert.equal((html.match(/<option value="kind:b"/g) ?? []).length, 1)
	assert.ok(html.includes('&lt;script&gt;same&lt;/script&gt;'))
	assert.equal(html.includes('<script>'), false)
})
