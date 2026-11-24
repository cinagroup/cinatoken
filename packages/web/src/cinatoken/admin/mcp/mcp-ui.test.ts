/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { AdminDomainWriteRecovery } from '../domain-write-recovery'
import { McpCatalog } from './McpCatalog'
import { McpPricingFields } from './McpPricingFields'
import { McpServerDetailCard } from './McpServerDetailCard'
import { McpServerList } from './McpServerList'
import { mcpCatalogItemSchema, mcpServerSummarySchema } from './mcp-contracts'
import { validateMcpSearch } from './mcp-domain'
import { mcpPricingDraftFrom } from './mcp-input'
import { assertMcpReviewCurrent, McpReviewChangedError } from './mcp-review'
import { adminMcpMessages } from './messages'

const server = mcpServerSummarySchema.parse({
	id: 'server-1',
	slug: 'docs',
	name: 'Docs catalog',
	description: '<script>remote</script>',
	status: 'active',
	urlMasked: 'https://docs.invalid/mcp?token=***',
	authHeaderNames: ['Authorization'],
	pricing: { v: 1, prices: { standard: 0, charged: 0.03, metered: 0.02 } },
	timeoutMs: 30000,
	maxResponseBytes: 1048576,
	lastSyncedAt: null,
	lastSyncError: null,
	enabledCount: 1,
	pendingCount: 1,
})
const item = mcpCatalogItemSchema.parse({
	id: 'item-1',
	serverId: server.id,
	kind: 'tool',
	upstreamKey: 'read',
	exposedName: 'docs__read',
	definition: {
		description: '<img src=x onerror=alert(1)>',
		token: 'private-token',
	},
	pendingDefinition: { description: 'Updated definition' },
	reviewState: 'changed',
	status: 'enabled',
	pricing: null,
	pricingState: 'inherit',
})
async function render(
	locale: keyof typeof adminMcpMessages,
	node: ReactNode
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: { cinatoken: { adminMcp: adminMcpMessages[locale] } },
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}
const noop = () => undefined
function catalog(items = [item]) {
	return createElement(McpCatalog, {
		detail: { server, items },
		search: validateMcpSearch({}),
		currency: 'USD',
		busy: false,
		onSearch: noop,
		onStatus: noop,
		onAccept: noop,
		onPricing: noop,
	})
}
test('MCP catalog renders safe descriptions, pending review and inherited v1 independent prices', async () => {
	const html = await render('en', catalog())
	assert.match(html, /docs__read/u)
	assert.match(html, /Accept change/u)
	assert.match(html, /0\.03/u)
	assert.doesNotMatch(html, /<img|private-token/u)
	assert.match(html, /Updated definition/u)
	assert.match(html, /&lt;img/u)
})
test('invalid and unknown legacy pricing fail closed instead of displaying inherited amounts', async () => {
	for (const state of ['invalid', undefined] as const) {
		const html = await render(
			'en',
			catalog([{ ...item, pendingDefinition: null, pricingState: state }])
		)
		assert.doesNotMatch(html, /0\.03/u)
		assert.match(
			html,
			state === 'invalid'
				? /invalid|unavailable/iu
				: /origin|source|unknown|confirm/iu
		)
	}
})
test('catalog rendering is bounded to the current page and removed entries cannot be enabled', async () => {
	const html = await render(
		'en',
		catalog(
			Array.from({ length: 81 }, (_, i) => ({
				...item,
				id: 'item-' + i,
				exposedName: 'docs__item' + i,
			}))
		)
	)
	assert.match(html, /docs__item39/u)
	assert.doesNotMatch(html, /docs__item40/u)
	assert.match(html, />Next</u)
	const removed = await render(
		'en',
		createElement(McpCatalog, {
			detail: { server, items: [{ ...item, status: 'removed' }] },
			search: validateMcpSearch({ itemFilter: 'removed' }),
			currency: 'USD',
			busy: false,
			onSearch: noop,
			onStatus: noop,
			onAccept: noop,
			onPricing: noop,
		})
	)
	assert.doesNotMatch(removed, /Accept change/u)
	assert.match(removed, /disabled/u)
})
test('server connection is masked by default and preserves the explicit previous interface boundary', async () => {
	const html = await render(
		'en',
		createElement(McpServerDetailCard, {
			server,
			writeAllowed: false,
			busy: false,
			secrets: null,
			currency: 'USD',
			test: null,
			sync: null,
			onEdit: noop,
			onTest: noop,
			onSync: noop,
			onToggle: noop,
			onDelete: noop,
			onReveal: noop,
		})
	)
	assert.match(html, /token=\*\*\*/u)
	assert.match(html, /Reveal/u)
	assert.match(html, /provider|source=mcp/u)
	assert.doesNotMatch(html, /<script|Bearer/u)
})
test('server lists and pricing version controls have translations for all supported locales', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			locale,
			createElement(McpServerList, {
				servers: [server],
				search: validateMcpSearch({}),
				busy: false,
				onSearch: noop,
			})
		)
		assert.ok(html.includes(adminMcpMessages[locale].open))
		assert.doesNotMatch(html, /cinatoken\.adminMcp/u)
		const pricing = await render(
			locale,
			createElement(McpPricingFields, {
				draft: mcpPricingDraftFrom(server.pricing),
				onChange: noop,
				currency: 'USD',
			})
		)
		assert.match(pricing, /value="v1" selected/u)
		assert.doesNotMatch(pricing, /cinatoken\.adminMcp/u)
	}
})
test('unknown MCP writes persist only the generic marker and remain separate from models', () => {
	const values = new Map<string, string>()
	const store = new AdminDomainWriteRecovery({
		getItem: (k) => values.get(k) ?? null,
		setItem: (k, v) => {
			values.set(k, v)
		},
		removeItem: (k) => {
			values.delete(k)
		},
	})
	const identity = JSON.stringify(['u', 'subject', 1])
	store.markPending(identity, 'mcp', 'resource')
	assert.equal(store.status(identity, 'mcp'), 'pending')
	assert.equal(store.status(identity, 'models'), 'ready')
	const serialized = [...values.values()].join('')
	assert.doesNotMatch(serialized, /docs|secret|token|https/u)
	assert.equal(
		new AdminDomainWriteRecovery({
			getItem: (k) => values.get(k) ?? null,
			setItem: noop,
			removeItem: noop,
		}).status(identity, 'mcp'),
		'pending'
	)
})

test('review blocks missing, removed, reassigned and stale current or pending definitions before any accept', () => {
	assert.doesNotThrow(() => assertMcpReviewCurrent(item, { ...item }))
	for (const current of [
		undefined,
		{ ...item, status: 'removed' as const },
		{ ...item, serverId: 'another' },
		{ ...item, id: 'another' },
		{ ...item, kind: 'prompt' as const },
		{ ...item, upstreamKey: 'another' },
		{ ...item, exposedName: 'another' },
		{ ...item, status: 'disabled' as const },
		{
			...item,
			definition: {
				...(item.definition as object),
				inputSchema: { type: 'object' },
			},
		},
		{ ...item, reviewState: 'none' as const },
		{ ...item, pendingDefinition: null },
		{ ...item, pendingDefinition: { description: 'Newer upstream change' } },
	])
		assert.throws(
			() => assertMcpReviewCurrent(item, current),
			McpReviewChangedError
		)
})

test('server lists distinguish an empty directory from no matches and preserve full matched counts', async () => {
	const servers = Array.from({ length: 21 }, (_, index) => ({
		...server,
		id: `row-${index}`,
		name: `Server ${index}`,
	}))
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const list = (rows: typeof servers, q = '') =>
			createElement(McpServerList, {
				servers: rows,
				search: validateMcpSearch({ q }),
				currency: 'CNY',
				busy: false,
				onSearch: noop,
			})
		const empty = await render(locale, list([]))
		assert.ok(empty.includes(adminMcpMessages[locale].serverCatalogEmpty))
		assert.ok(!empty.includes(adminMcpMessages[locale].empty))
		const noMatch = await render(locale, list(servers, 'absent'))
		assert.ok(noMatch.includes(adminMcpMessages[locale].empty))
		assert.ok(noMatch.includes(adminMcpMessages[locale].clearServerFilters))
		const populated = await render(locale, list(servers))
		assert.match(populated, /Server 19/u)
		assert.doesNotMatch(populated, /Server 20/u)
		assert.match(populated, /21/u)
		assert.match(populated, /0\.03 CNY/u)
		assert.doesNotMatch(populated, /cinatoken\.adminMcp/u)
	}
})
test('catalog empty and no-match states are translated and search reaches items outside the first page', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const node = (items: (typeof item)[], query: string) =>
			createElement(McpCatalog, {
				detail: { server, items },
				search: validateMcpSearch({ itemQuery: query }),
				currency: 'USD',
				busy: false,
				onSearch: noop,
				onStatus: noop,
				onAccept: noop,
				onPricing: noop,
			})
		const empty = await render(locale, node([], ''))
		assert.ok(empty.includes(adminMcpMessages[locale].itemCatalogEmpty))
		const none = await render(locale, node([item], 'absent'))
		assert.ok(none.includes(adminMcpMessages[locale].noItems))
		assert.ok(none.includes(adminMcpMessages[locale].clearItemFilters))
		const rows = Array.from({ length: 81 }, (_, index) => ({
			...item,
			id: `item-${index}`,
			exposedName: `docs__entry${index}`,
			definition: {
				title: index === 80 ? 'FindFinalTitle' : 'Other',
				description: 'Existing description',
			},
		}))
		const last = await render(locale, node(rows, 'findfinaltitle'))
		assert.match(last, /docs__entry80/u)
		assert.doesNotMatch(last, /docs__entry0<|cinatoken\.adminMcp/u)
	}
})

test('review checks the original snapshot state but ignores unrelated sync metadata', () => {
	for (const previous of [
		{ ...item, reviewState: 'none' as const },
		{ ...item, reviewState: 'new' as const },
		{ ...item, pendingDefinition: null },
		{ ...item, status: 'removed' as const },
	])
		assert.throws(
			() => assertMcpReviewCurrent(previous, item),
			McpReviewChangedError
		)
	assert.doesNotThrow(() =>
		assertMcpReviewCurrent(item, { ...item, syncedAt: '2030-01-01T00:00:00Z' })
	)
})

test('catalog comparison exposes current and pending text independently in every locale', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			locale,
			catalog([
				{
					...item,
					definition: {
						title: 'Published title',
						description: 'Shared description',
						inputSchema: { hiddenCurrent: true },
					},
					pendingDefinition: {
						title: 'Pending title',
						description: 'Shared description',
						inputSchema: { hiddenPending: true },
					},
				},
			])
		)
		assert.ok(html.includes(adminMcpMessages[locale].currentText))
		assert.ok(html.includes(adminMcpMessages[locale].pendingText))
		assert.ok(html.includes(adminMcpMessages[locale].reviewTextHint))
		assert.match(html, /Published title/u)
		assert.match(html, /Pending title/u)
		assert.equal((html.match(/Shared description/gu) ?? []).length, 2)
		assert.doesNotMatch(html, /hiddenCurrent|hiddenPending/u)
	}
})

test('catalog only offers acceptance for changed, present, nonremoved pending definitions', async () => {
	for (const candidate of [
		{ ...item, reviewState: 'none' as const },
		{ ...item, reviewState: 'new' as const },
		{ ...item, pendingDefinition: null },
		{ ...item, status: 'removed' as const },
	]) {
		const html = await render('en', catalog([candidate]))
		assert.ok(!html.includes('Accept change'))
	}
	assert.match(await render('en', catalog([item])), /Accept change/u)
})
