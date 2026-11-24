/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpOverview } from './McpOverview'
import { mcpServerSummarySchema, type McpServerSummary } from './mcp-contracts'
import { adminMcpMessages } from './messages'

type Locale = keyof typeof adminMcpMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
const server = mcpServerSummarySchema.parse({
	id: 'overview-server',
	slug: 'overview',
	name: 'private-name-canary',
	description: 'private-description-canary',
	status: 'active',
	urlMasked: 'https://private-url-canary.invalid/mcp',
	authHeaderNames: ['Authorization'],
	pricing: null,
	timeoutMs: 30_000,
	maxResponseBytes: 1_048_576,
	lastSyncedAt: null,
	lastSyncError: null,
	enabledCount: 1_234,
	pendingCount: 2_345,
})

async function render(
	servers: McpServerSummary[],
	locale: Locale
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: { cinatoken: { adminMcp: adminMcpMessages[locale] } },
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(McpOverview, { servers })
		)
	)
}

function definitions(html: string): string[][] {
	return [
		...html.matchAll(/<dt\b[^>]*>([^<]*)<\/dt><dd\b[^>]*>([^<]*)<\/dd>/gu),
	].map((match) => [match[1], match[2]])
}

test('MCP overview exposes four localized labeled metrics in all supported languages without connection details', async () => {
	const servers = [
		server,
		{
			...server,
			id: 'disabled-server',
			status: 'disabled' as const,
			enabledCount: 99_999,
			pendingCount: 1,
			lastSyncError: 'private-error-canary',
		},
	]
	for (const locale of locales) {
		const html = await render(servers, locale)
		const messages = adminMcpMessages[locale]
		const format = new Intl.NumberFormat(locale)
		assert.ok(html.startsWith(`<section aria-label="${messages.overview}"`))
		assert.equal((html.match(/<dl\b/gu) ?? []).length, 1)
		assert.deepEqual(definitions(html), [
			[messages.totalServers, format.format(2)],
			[messages.enabledItems, format.format(1_234)],
			[messages.pendingItems, format.format(2_346)],
			[messages.syncFailedServers, format.format(1)],
		])
		assert.doesNotMatch(html, /cinatoken\.|private-.*-canary|Authorization/u)
	}
})

test('MCP overview displays a verified empty directory as four zero metrics', async () => {
	for (const locale of locales) {
		const html = await render([], locale)
		assert.deepEqual(
			definitions(html).map(([, value]) => value),
			Array(4).fill(new Intl.NumberFormat(locale).format(0))
		)
	}
})

test('MCP overview formats BigInt totals without rounding or scientific notation', async () => {
	const servers = [
		{
			...server,
			enabledCount: Number.MAX_SAFE_INTEGER,
			pendingCount: Number.MAX_SAFE_INTEGER,
		},
		{ ...server, id: 'second-server', enabledCount: 2, pendingCount: 2 },
	]
	for (const locale of locales) {
		const html = await render(servers, locale)
		const values = definitions(html).map(([, value]) => value)
		const expected = new Intl.NumberFormat(locale).format(
			9_007_199_254_740_993n
		)
		assert.deepEqual(values, ['2', expected, expected, '0'])
		assert.doesNotMatch(values.join(' '), /e[+-]\d/iu)
	}
	assert.equal(
		definitions(await render(servers, 'en'))[1][1],
		'9,007,199,254,740,993'
	)
})
