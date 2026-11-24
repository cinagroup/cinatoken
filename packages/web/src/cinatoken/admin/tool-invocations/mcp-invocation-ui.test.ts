/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { CinaTokenApiError } from '../../api'
import { AdminToolInvocations } from './AdminToolInvocations'
import { ToolInvocationDetail } from './ToolInvocationDetail'
import { ToolInvocationSourceFilters } from './ToolInvocationSourceFilters'
import { ToolInvocationTable } from './ToolInvocationTable'
import { adminToolInvocationMessages } from './messages'
import { createAdminToolInvocationsApi } from './tool-invocation-api'
import { toolInvocationSchema } from './tool-invocation-contracts'
import { validateToolInvocationSearch } from './tool-invocation-domain'

async function render(
	locale: keyof typeof adminToolInvocationMessages,
	node: ReactNode
): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminToolInvocations: adminToolInvocationMessages[locale],
					},
				},
			},
		},
	})
	return renderToStaticMarkup(createElement(I18nextProvider, { i18n }, node))
}
const mcp = toolInvocationSchema.parse({
	id: 'mcp-log-1',
	provider_id: 'octafuse-mcp',
	model_id: 'mcp:deep-wiki/read_docs',
	provider_model_name: 'read_docs',
	request_body: JSON.stringify({
		name: 'read_docs',
		arguments: {
			repo: 'cina/cinatoken',
			token: 'private-token',
			html: '<script>alert(1)</script>',
		},
	}),
	raw_usage: JSON.stringify({
		result_count: 999,
		content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }],
		token: 'private-output',
	}),
	pricing_audit: null,
	user_email: 'user@example.invalid',
	status: 'success',
	standard_cost: 1,
	charged_cost: 0.5,
	metered_cost: 0.2,
	latency_ms: 100,
	error_message: null,
	created_at: '2026-10-01T00:00:00.000Z',
})

test('MCP rows show their source, server/tool and redacted arguments without REST result counts', async () => {
	const html = await render(
		'en',
		createElement(ToolInvocationTable, {
			page: { data: [mcp], total: 1, page: 1, page_size: 50 },
			currency: 'CNY',
			timezone: 'UTC',
			locale: 'en',
			context: 'mcp',
		})
	)
	assert.match(html, />MCP</u)
	assert.match(html, /deep-wiki \/ read_docs/u)
	assert.match(html, /repo=cina\/cinatoken/u)
	assert.doesNotMatch(html, /private-token|999|<script|<img/iu)
})

test('MCP details use JSON immediately, safely escape upstream content and retain metadata', async () => {
	const html = await render(
		'en',
		createElement(ToolInvocationDetail, { log: mcp })
	)
	assert.match(html, /deep-wiki/u)
	assert.match(html, /read_docs/u)
	assert.match(html, /aria-selected="true"/u)
	assert.match(html, /&lt;img/u)
	assert.doesNotMatch(
		html,
		/>List<|private-token|private-output|<script|<img/iu
	)
	const rest = await render(
		'en',
		createElement(ToolInvocationDetail, {
			log: {
				...mcp,
				provider_id: 'octafuse-tools',
				model_id: 'tool:web-search',
				raw_usage: '{"results":[{"title":"first result"}]}',
			},
		})
	)
	assert.match(rest, />List</u)
	assert.match(rest, /first result/u)
})

test('MCP source/server controls and validation are translated in all four languages', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const text = adminToolInvocationMessages[locale].invocations
		const html = await render(
			locale,
			createElement(ToolInvocationSourceFilters, {
				search: validateToolInvocationSearch({
					source: 'mcp',
					server: 'deep-wiki',
				}),
				onSearch: () => {},
			})
		)
		for (const key of [
			'source',
			'serverFilter',
			'applyServer',
			'serverHint',
		] as const)
			assert.ok(html.includes(text[key]))
		assert.match(html, /value="deep-wiki"/u)
		assert.match(html, /maxlength="40"/iu)
	}
	const rest = await render(
		'en',
		createElement(ToolInvocationSourceFilters, {
			search: validateToolInvocationSearch({}),
			onSearch: () => {},
		})
	)
	assert.doesNotMatch(rest, /Server slug|Apply server filter/u)
})

test('invalid source/server routes render an error instead of crashing or linking to widened request logs', async () => {
	let calls = 0
	const api = createAdminToolInvocationsApi({
		send: async () => {
			calls += 1
			throw new Error('must not send')
		},
		invalidResponse: () => {
			throw new CinaTokenApiError('Invalid', 200, 'invalid-response')
		},
		sanitizeError: () => new Error('Console read failed'),
	})
	for (const search of [
		validateToolInvocationSearch({ source: 'future' }),
		validateToolInvocationSearch({ source: 'mcp', server: 'bad/slug' }),
		{ ...validateToolInvocationSearch({ source: 'mcp' }), server: 'bad/slug' },
	]) {
		const html = await render(
			'en',
			createElement(AdminToolInvocations, {
				api,
				scopeKey: 'console',
				reconciliationKey: '["user","subject",1]',
				revalidate: async () => {},
				search,
				onSearch: () => {},
			})
		)
		assert.ok(html.includes(adminToolInvocationMessages.en.invalidFilter))
		assert.ok(html.includes(adminToolInvocationMessages.en.resetFilters))
		assert.match(html, /role="alert"/u)
		assert.doesNotMatch(html, /href="\/admin\/request-logs/u)
	}
	assert.equal(calls, 0)
})
