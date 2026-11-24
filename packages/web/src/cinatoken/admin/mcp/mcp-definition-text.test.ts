/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement, type ReactNode } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { McpDefinitionText } from './McpDefinitionText'
import { mcpDefinitionTextMessages } from './definition-text-messages'
import {
	MCP_DEFINITION_PREVIEW_LIMIT,
	MCP_DEFINITION_TEXT_LIMIT,
	mcpDefinitionText,
	type McpDefinitionTextField,
} from './mcp-definition-text'
import { adminMcpMessages } from './messages'

type Locale = keyof typeof mcpDefinitionTextMessages
const locales: Locale[] = ['en', 'zh', 'ja', 'ko']
function textField(value: McpDefinitionTextField) {
	assert.equal(value.status, 'text')
	if (value.status !== 'text') throw new Error('Expected readable text')
	return value
}
async function render(node: ReactNode, locale: Locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: {
					cinatoken: {
						adminMcp: {
							...adminMcpMessages[locale],
							...mcpDefinitionTextMessages[locale],
						},
					},
				},
			},
		},
	})
	const html = renderToStaticMarkup(
		createElement(I18nextProvider, { i18n }, node)
	)
	assert.doesNotMatch(html, /cinatoken\.adminMcp|\{\{/u)
	return html
}
function block(definition: unknown, label = 'definition') {
	return createElement(McpDefinitionText, { definition, label })
}

test('definition text keeps top-level title and description separate without mutating input', () => {
	const definition = Object.freeze({
		title: ' Human-readable title ',
		description: ' First line\nSecond line ',
		nested: { title: 'Not a top-level title' },
	})
	const fields = mcpDefinitionText(definition)
	assert.equal(textField(fields.title).text, 'Human-readable title')
	assert.equal(textField(fields.description).text, 'First line\nSecond line')
	assert.equal(textField(fields.title).expandable, false)
	assert.equal(textField(fields.description).expandable, false)
	assert.equal(definition.title, ' Human-readable title ')
	assert.equal(definition.description, ' First line\nSecond line ')
})

test('definition text distinguishes omitted, whitespace-only and malformed values', () => {
	for (const definition of [undefined, null, {}]) {
		assert.deepEqual(mcpDefinitionText(definition), {
			title: { status: 'missing' },
			description: { status: 'missing' },
		})
	}
	for (const definition of ['', 'raw', 0, false, NaN, Infinity, []]) {
		assert.deepEqual(mcpDefinitionText(definition), {
			title: { status: 'invalid' },
			description: { status: 'invalid' },
		})
	}
	assert.deepEqual(mcpDefinitionText({ title: ' \n\t', description: 0 }), {
		title: { status: 'empty' },
		description: { status: 'invalid' },
	})
	assert.deepEqual(mcpDefinitionText({ title: null, description: false }), {
		title: { status: 'missing' },
		description: { status: 'invalid' },
	})
})

test('definition text ignores inherited and nested fields and never invokes accessors or serialization', () => {
	let invoked = 0
	const definition = Object.create({ title: 'Inherited title' }) as object
	Object.defineProperty(definition, 'description', {
		get() {
			invoked += 1
			throw new Error('Must not invoke a getter')
		},
	})
	assert.deepEqual(mcpDefinitionText(definition), {
		title: { status: 'missing' },
		description: { status: 'invalid' },
	})
	assert.equal(invoked, 0)
	assert.deepEqual(
		mcpDefinitionText({
			title: { text: 'Nested title' },
			nested: { description: 'Nested description' },
			toJSON() {
				throw new Error('Must not serialize')
			},
		}),
		{ title: { status: 'invalid' }, description: { status: 'missing' } }
	)
})

test('definition text redacts each field before preview and expanded clipping', () => {
	const fields = mcpDefinitionText({
		title:
			'Bearer PRIVATE_TITLE https://example.invalid/?api_key=PRIVATE_QUERY',
		description:
			'"password":"PRIVATE_PASSWORD" ' +
			'x'.repeat(MCP_DEFINITION_TEXT_LIMIT - 20) +
			' Bearer PRIVATE_BOUNDARY_SECRET',
	})
	const title = textField(fields.title)
	const description = textField(fields.description)
	assert.match(title.text, /\[redacted\]/u)
	assert.match(description.text, /\[redacted\]/u)
	for (const value of [
		title.text,
		title.preview,
		description.text,
		description.preview,
	])
		assert.doesNotMatch(value, /PRIVATE_/u)
})

test('definition text expands at 160 characters and two logical lines without splitting Unicode', () => {
	const short = textField(mcpDefinitionText({ title: '😀'.repeat(160) }).title)
	assert.equal(short.expandable, false)
	const long = textField(mcpDefinitionText({ title: '😀'.repeat(161) }).title)
	assert.equal([...long.preview].length, MCP_DEFINITION_PREVIEW_LIMIT)
	assert.equal(long.preview, '😀'.repeat(160))
	assert.equal(long.expandable, true)
	assert.equal(long.truncated, false)
	for (const newline of ['\n', '\r\n', '\r', '\u2028', '\u2029']) {
		const field = textField(
			mcpDefinitionText({
				description: ['First', 'Second', 'Third'].join(newline),
			}).description
		)
		assert.equal(field.preview, ['First', 'Second'].join(newline))
		assert.equal(field.text, ['First', 'Second', 'Third'].join(newline))
		assert.equal(field.expandable, true)
	}
})

test('definition text preserves the 8192-character display allowance and explicitly marks the next character', () => {
	const exact = textField(
		mcpDefinitionText({ description: '😀'.repeat(MCP_DEFINITION_TEXT_LIMIT) })
			.description
	)
	assert.equal([...exact.text].length, MCP_DEFINITION_TEXT_LIMIT)
	assert.equal(exact.truncated, false)
	const overflow = textField(
		mcpDefinitionText({
			description: '😀'.repeat(MCP_DEFINITION_TEXT_LIMIT) + 'NOT_DISPLAYED',
		}).description
	)
	assert.equal(overflow.text, exact.text)
	assert.equal(overflow.truncated, true)
	assert.equal(overflow.expandable, true)
	assert.equal([...overflow.preview].length, MCP_DEFINITION_PREVIEW_LIMIT)
})

test('definition text renders separate translated labels and fallback states in all four languages', async () => {
	for (const locale of locales) {
		const messages = mcpDefinitionTextMessages[locale]
		const html = await render(block({ title: '', description: 42 }), locale)
		assert.ok(html.includes(adminMcpMessages[locale].definition))
		for (const key of [
			'definitionTitle',
			'definitionDescription',
			'definitionTextEmpty',
			'definitionTextInvalid',
		] as const)
			assert.ok(html.includes(messages[key]))
		const omitted = await render(block(null, 'pendingDefinition'), locale)
		assert.ok(omitted.includes(adminMcpMessages[locale].pendingDefinition))
		assert.ok(omitted.includes(messages.definitionTextMissing))
		assert.doesNotMatch(html + omitted, /<button|<pre|<input/u)
	}
})

test('definition text escapes upstream HTML and preserves readable redacted text', async () => {
	const html = await render(
		block({
			title: '<script>alert(1)</script>',
			description: '<img src=x onerror=alert(1)> Bearer PRIVATE_HTML_SECRET',
		})
	)
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
	assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u)
	assert.match(html, /\[redacted\]/u)
	assert.doesNotMatch(html, /<script|<img|PRIVATE_HTML_SECRET/u)
})

test('definition text starts collapsed with distinct accessible controls for every block and field', async () => {
	const definition = {
		title: 'Title '.repeat(40),
		description: 'Line 1\nLine 2\nHidden line 3',
	}
	const html = await render(
		createElement(
			'div',
			null,
			block(definition),
			block(definition, 'pendingDefinition')
		)
	)
	const controls = [...html.matchAll(/aria-controls="([^"]+)"/gu)].map(
		(match) => match[1]
	)
	assert.equal(controls.length, 4)
	assert.equal(new Set(controls).size, 4)
	for (const id of controls) assert.ok(html.includes(`id="${id}"`))
	assert.equal([...html.matchAll(/aria-expanded="false"/gu)].length, 4)
	assert.equal([...html.matchAll(/line-clamp-2/gu)].length, 4)
	assert.match(html, /Expand Title/u)
	assert.match(html, /Expand Description/u)
	assert.doesNotMatch(html, /Hidden line 3/u)
})

test('definition text bounds initial DOM and localizes the truncation notice without promising full text', async () => {
	for (const locale of locales) {
		const messages = mcpDefinitionTextMessages[locale]
		const html = await render(
			block({ description: 'x'.repeat(MCP_DEFINITION_TEXT_LIMIT + 1) }),
			locale
		)
		assert.ok(html.length < 4000)
		assert.ok(html.includes('x'.repeat(MCP_DEFINITION_PREVIEW_LIMIT) + '…'))
		assert.ok(!html.includes('x'.repeat(MCP_DEFINITION_PREVIEW_LIMIT + 1)))
		const limit = new Intl.NumberFormat(locale).format(
			MCP_DEFINITION_TEXT_LIMIT
		)
		assert.ok(
			html.includes(
				messages.definitionTextTruncated.replace('{{limit}}', limit)
			)
		)
		assert.ok(
			html.includes(
				messages.definitionTextMore.replace(
					'{{field}}',
					messages.definitionDescription
				)
			)
		)
		assert.doesNotMatch(html, /full description|complete text/iu)
	}
})

test('definition text safely renders nonobject primitives including NaN without state-reset loops', async () => {
	for (const definition of [false, 0, NaN, Infinity, 'invalid', []]) {
		const html = await render(block(definition))
		assert.ok(html.includes(mcpDefinitionTextMessages.en.definitionTextInvalid))
		assert.doesNotMatch(html, /<button|<pre/u)
	}
})
