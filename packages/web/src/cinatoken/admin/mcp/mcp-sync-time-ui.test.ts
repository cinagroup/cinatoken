/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpLastSync } from './McpLastSync'
import { McpServerDetailCard } from './McpServerDetailCard'
import { McpServerList } from './McpServerList'
import { mcpServerSummarySchema } from './mcp-contracts'
import { validateMcpSearch } from './mcp-domain'
import { adminMcpMessages } from './messages'

type Locale = keyof typeof adminMcpMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
const noop = () => undefined
const server = mcpServerSummarySchema.parse({
	id: 'sync-server',
	slug: 'sync-docs',
	name: 'Sync docs',
	description: null,
	status: 'active',
	urlMasked: 'https://example.invalid/mcp',
	authHeaderNames: [],
	pricing: { v: 2, standard: 1, chargedFactor: 1, meteredFactor: 1 },
	timeoutMs: 30000,
	maxResponseBytes: 1048576,
	lastSyncedAt: '2026-10-23 16:00:00',
	lastSyncError: null,
	enabledCount: 0,
	pendingCount: 0,
})
async function render(node: ReactNode, locale: Locale = 'en'): Promise<string> {
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
	const html = renderToStaticMarkup(
		createElement(I18nextProvider, { i18n }, node)
	)
	assert.doesNotMatch(html, /cinatoken\.adminMcp/u)
	return html
}
function text(html: string): string {
	return html.replace(/<[^>]*>/gu, '')
}
function lastSync(value: string | null, timezone?: string | null) {
	return createElement(McpLastSync, { value, timezone })
}
function detail(value: string | null, timezone?: string | null) {
	return createElement(McpServerDetailCard, {
		server: { ...server, lastSyncedAt: value },
		timezone,
		currency: 'USD',
		busy: false,
		writeAllowed: true,
		secrets: null,
		test: null,
		sync: null,
		onEdit: noop,
		onTest: noop,
		onSync: noop,
		onToggle: noop,
		onDelete: noop,
		onReveal: noop,
	})
}
function list(value: string | null, timezone?: string | null) {
	return createElement(McpServerList, {
		servers: [{ ...server, lastSyncedAt: value }],
		timezone,
		search: validateMcpSearch({}),
		busy: false,
		onSearch: noop,
	})
}

test('MCP sync display distinguishes missing and unavailable time with translated attempt labels', async () => {
	for (const locale of locales) {
		const messages = adminMcpMessages[locale]
		assert.equal(
			text(await render(lastSync(null), locale)),
			`${messages.lastSync}: ${messages.noSyncRecorded}`
		)
		for (const raw of [
			'',
			'2026-02-30T01:00:00Z',
			'PRIVATE_INVALID_TIMESTAMP',
		]) {
			const html = await render(lastSync(raw), locale)
			assert.equal(
				text(html),
				`${messages.lastSync}: ${messages.syncTimeUnavailable}`
			)
			assert.doesNotMatch(html, /<time|PRIVATE_INVALID_TIMESTAMP/u)
		}
	}
})

test('MCP sync display formats its own locale and business calendar day while retaining a semantic UTC instant', async () => {
	const raw = '2026-10-23T16:00:00.123Z'
	for (const locale of locales) {
		const formatted = new Intl.DateTimeFormat(locale, {
			timeZone: 'Asia/Shanghai',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23',
		}).format(new Date(raw))
		const html = await render(lastSync(raw, 'Asia/Shanghai'), locale)
		assert.equal(
			text(html),
			`${adminMcpMessages[locale].lastSync}: ${formatted} Asia/Shanghai`
		)
		assert.match(html, /datetime="2026-10-23T16:00:00\.123Z"/iu)
	}
	assert.equal(
		text(await render(lastSync(raw, 'Asia/Shanghai'))),
		'Last sync attempt: 10/24/2026, 00:00:00 Asia/Shanghai'
	)
})

test('MCP sync display defaults omitted or unavailable configuration to explicit UTC and retains epoch zero', async () => {
	for (const locale of locales) {
		const implicit = await render(lastSync('1970-01-01 00:00:00'), locale)
		assert.equal(
			implicit,
			await render(lastSync('1970-01-01T00:00:00Z', null), locale)
		)
		assert.equal(
			implicit,
			await render(lastSync('1970-01-01T00:00:00.000Z', 'UTC'), locale)
		)
		assert.match(text(implicit), / UTC$/u)
	}
	assert.equal(
		text(await render(lastSync('1970-01-01T00:00:00Z'))),
		'Last sync attempt: 01/01/1970, 00:00:00 UTC'
	)
})

test('MCP sync display honors spring and autumn DST changes for explicit instants', async () => {
	for (const [raw, expected] of [
		['2026-03-08T06:59:00Z', '03/08/2026, 01:59:00'],
		['2026-03-08T07:00:00Z', '03/08/2026, 03:00:00'],
		['2026-11-01T05:59:00Z', '11/01/2026, 01:59:00'],
		['2026-11-01T06:00:00Z', '11/01/2026, 01:00:00'],
	])
		assert.equal(
			text(await render(lastSync(raw, 'America/New_York'))),
			`Last sync attempt: ${expected} America/New_York`
		)
})

test('MCP list and detail share the timestamp states and optional-timezone compatibility', async () => {
	for (const locale of locales) {
		for (const value of [server.lastSyncedAt, null, 'bad-sync-time']) {
			const expected = await render(lastSync(value, 'Asia/Shanghai'), locale)
			assert.ok(
				(await render(list(value, 'Asia/Shanghai'), locale)).includes(expected)
			)
			assert.ok(
				(await render(detail(value, 'Asia/Shanghai'), locale)).includes(
					expected
				)
			)
		}
	}
	for (const node of [list(server.lastSyncedAt), detail(server.lastSyncedAt)]) {
		const html = await render(node)
		assert.match(html, /10\/23\/2026, 16:00:00 UTC/u)
		assert.doesNotMatch(html, /2026-10-23 16:00:00/u)
	}
})
