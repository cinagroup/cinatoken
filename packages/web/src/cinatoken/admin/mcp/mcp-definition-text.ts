/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { safeLogText } from '../request-logs/log-redaction'

export const MCP_DEFINITION_TEXT_LIMIT = 8_192
export const MCP_DEFINITION_PREVIEW_LIMIT = 160

export type McpDefinitionTextField =
	| { status: 'missing' | 'empty' | 'invalid' }
	| {
			status: 'text'
			text: string
			preview: string
			expandable: boolean
			truncated: boolean
	  }

export type McpDefinitionTextFields = {
	title: McpDefinitionTextField
	description: McpDefinitionTextField
}

/** Count Unicode characters without allocating an array for the full input. */
function textPrefix(value: string, limit: number): string {
	let length = 0
	let count = 0
	for (const character of value) {
		if (count === limit) break
		length += character.length
		count += 1
	}
	return value.slice(0, length)
}

function fieldText(value: unknown): McpDefinitionTextField {
	if (value === null || value === undefined) return { status: 'missing' }
	if (typeof value !== 'string') return { status: 'invalid' }
	// Redact before clipping so a credential crossing either display limit is safe.
	const safe = safeLogText(value).trim()
	if (!safe) return { status: 'empty' }
	const text = textPrefix(safe, MCP_DEFINITION_TEXT_LIMIT)
	const lineBreaks = text.matchAll(/\r\n|[\n\r\u2028\u2029]/gu)
	lineBreaks.next()
	const secondBreak = lineBreaks.next().value
	const lines = secondBreak ? text.slice(0, secondBreak.index) : text
	const preview = textPrefix(lines, MCP_DEFINITION_PREVIEW_LIMIT)
	const truncated = text.length < safe.length
	return {
		status: 'text',
		text,
		preview,
		expandable: truncated || preview.length < text.length,
		truncated,
	}
}

/** Read only own top-level text fields; never coerce or serialize a definition. */
export function mcpDefinitionText(
	definition: unknown
): McpDefinitionTextFields {
	if (definition === null || definition === undefined)
		return { title: { status: 'missing' }, description: { status: 'missing' } }
	if (typeof definition !== 'object' || Array.isArray(definition))
		return { title: { status: 'invalid' }, description: { status: 'invalid' } }
	function field(key: 'title' | 'description'): McpDefinitionTextField {
		const descriptor = Object.getOwnPropertyDescriptor(definition, key)
		if (!descriptor) return { status: 'missing' }
		if (!Object.hasOwn(descriptor, 'value')) return { status: 'invalid' }
		return fieldText(descriptor.value)
	}
	return { title: field('title'), description: field('description') }
}
