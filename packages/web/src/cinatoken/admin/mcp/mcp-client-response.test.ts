/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ComponentProps } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpClientResponse } from './McpClientResponse'
import { buildMcpClientRequest, executeMcpClient } from './mcp-client'
import type { McpClientDiagnostic } from './mcp-client-diagnostics'
import { adminMcpMessages } from './messages'

const diagnostic: McpClientDiagnostic = {
	status: 502,
	elapsedMs: 123,
	headers: { 'content-type': 'text/html' },
	bodyText: '<html>Gateway failed</html>',
	bodyKind: 'text',
	truncated: false,
}
async function render(
	locale: keyof typeof adminMcpMessages,
	data: McpClientDiagnostic,
	response: ComponentProps<typeof McpClientResponse>['response'] = null
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
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(McpClientResponse, {
				diagnostic: data,
				response,
				servers: [],
			})
		)
	)
}
function buttonDisabled(html: string, text: string): boolean {
	const button = Array.from(
		html.matchAll(/<button([^>]*)>([^<]*)<\/button>/gu)
	).find((match) => match[2] === text)
	assert.ok(button, 'Missing button: ' + text)
	return /\sdisabled(?:="[^"]*")?(?=\s|$)/u.test(button[1])
}
for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
	test(`client diagnostics provide status, elapsed time, headers and escaped body in ${locale}`, async () => {
		const html = await render(locale, diagnostic)
		for (const key of [
			'clientHttpStatus',
			'clientElapsed',
			'clientResponseHeaders',
			'clientResponseBody',
			'copyResponse',
		] as const)
			assert.ok(html.includes(adminMcpMessages[locale][key]))
		assert.match(html, />502</u)
		assert.match(html, /123/u)
		assert.match(html, /content-type/u)
		assert.match(html, /&lt;html&gt;Gateway failed&lt;\/html&gt;/u)
		assert.doesNotMatch(html, /<html>|cinatoken\.adminMcp/u)
	})
}
test('empty, withheld and truncated bodies have distinct visible states and copy availability', async () => {
	const empty = await render('en', {
		...diagnostic,
		bodyText: '',
		bodyKind: 'empty',
	})
	assert.ok(empty.includes(adminMcpMessages.en.clientEmptyBody))
	assert.equal(buttonDisabled(empty, 'Copy response body'), false)
	const withheld = await render('en', {
		...diagnostic,
		status: null,
		headers: {},
		bodyText: null,
		bodyKind: 'unavailable',
	})
	assert.ok(withheld.includes(adminMcpMessages.en.clientBodyUnavailable))
	assert.ok(withheld.includes(adminMcpMessages.en.clientNoStatus))
	assert.ok(withheld.includes(adminMcpMessages.en.clientNoHeaders))
	assert.equal(buttonDisabled(withheld, 'Copy response body'), true)
	const truncated = await render('en', { ...diagnostic, truncated: true })
	assert.match(truncated, /262,144/u)
	assert.match(truncated, /role="status"/u)
})
test('HTTP errors containing a valid catalog cannot render as a successful grouped response', async () => {
	const request = buildMcpClientRequest({
		base: 'https://proxy.invalid',
		slug: '',
		method: 'tools/list',
		version: '2025-06-18',
		id: 1,
	})
	const response = await executeMcpClient(
		request,
		'sk-diagnostic-fixture-secret',
		{
			fetch: async () =>
				new Response(
					JSON.stringify({
						jsonrpc: '2.0',
						id: 1,
						result: { tools: [{ name: 'docs__read' }] },
					}),
					{ status: 502 }
				),
		}
	)
	const html = await render('en', response.diagnostic, response)
	assert.doesNotMatch(html, /Read-only response verified/u)
	assert.equal(buttonDisabled(html, 'Grouped catalog'), true)
})
