/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpClientCatalog } from './McpClientCatalog'
import { parseMcpClientResponse } from './mcp-client'
import { adminMcpMessages } from './messages'

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
function catalog(entries: Record<string, unknown>[]) {
	return createElement(McpClientCatalog, {
		entries,
		method: 'resources/list',
		slug: '',
		servers: [{ slug: 'docs', name: 'Reference Library' }],
	})
}

test('returned catalog has translated search, readable resource fields and per-entry JSON in every supported locale', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(
			locale,
			catalog([
				{
					uri: 'octafuse://docs/https%3A%2F%2Fexample.invalid',
					name: 'Guide name',
					title: 'Getting started',
					description: 'How to read',
					mimeType: 'text/plain',
				},
			])
		)
		for (const text of [
			'Reference Library',
			'Getting started',
			'How to read',
			'text/plain',
			adminMcpMessages[locale].clientCatalogSearch,
			adminMcpMessages[locale].clientCatalogEntryJson,
		])
			assert.ok(html.includes(text))
		assert.match(html, /type="search"/u)
		assert.match(html, /<article/u)
		assert.match(html, /<details/u)
		assert.doesNotMatch(html, /cinatoken\.adminMcp|\{\{/u)
	}
})

test('returned catalog escapes content, keeps JSON collapsed and abbreviates long descriptions accessibly', async () => {
	const parsed = parseMcpClientResponse(
		JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			result: {
				resources: [
					{
						uri: 'octafuse://docs/resource',
						name: '<img src=x>',
						description: 'x'.repeat(330) + 'UNEXPANDED_END',
						token: 'SECRET_CANARY',
					},
				],
			},
		}),
		{ id: 1, rpcMethod: 'resources/list' }
	)
	const html = await render('en', catalog(parsed.entries!))
	assert.match(html, /&lt;img src=x&gt;/u)
	assert.match(html, /aria-expanded="false"/u)
	assert.match(html, /Show full description/u)
	assert.doesNotMatch(html, /<img|UNEXPANDED_END|SECRET_CANARY|<pre/u)
})

test('returned catalog renders at most fifty entries even when all entries belong to one server', async () => {
	const html = await render(
		'en',
		catalog(
			Array.from({ length: 121 }, (_, index) => ({
				uri: `octafuse://docs/item-${index}`,
			}))
		)
	)
	assert.equal((html.match(/<article /gu) ?? []).length, 50)
	assert.match(html, /item-49/u)
	assert.doesNotMatch(html, /item-50/u)
	assert.match(html, /1–50 of 121 matching entries \(121 loaded\)/u)
	assert.match(html, /aria-label="Returned catalog pages"/u)
})

test('empty catalog responses have an explicit empty state and no misleading server or page controls', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(locale, catalog([]))
		assert.ok(html.includes(adminMcpMessages[locale].clientCatalogEmpty))
		assert.ok(!html.includes(adminMcpMessages[locale].clientCatalogNoMatches))
		assert.doesNotMatch(html, /<article|<nav/u)
	}
})
