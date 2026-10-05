/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { endpointMessages } from './messages'

function flatten(
	value: Record<string, unknown>,
	prefix = ''
): Record<string, string> {
	const result: Record<string, string> = {}
	for (const [key, entry] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (typeof entry === 'string') result[path] = entry
		else if (entry && typeof entry === 'object' && !Array.isArray(entry))
			Object.assign(result, flatten(entry as Record<string, unknown>, path))
	}
	return result
}

test('all endpoint languages have the same nonempty keys and interpolation variables', () => {
	const en = flatten(endpointMessages.en)
	const keys = Object.keys(en).sort()
	assert.ok(keys.length > 100)
	for (const language of ['zh', 'ja', 'ko'] as const) {
		const translated = flatten(endpointMessages[language])
		assert.deepEqual(Object.keys(translated).sort(), keys)
		for (const key of keys) {
			assert.ok(translated[key]?.trim(), `${language}:${key}`)
			const variables = (text: string) =>
				[...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/gu)]
					.map((match) => match[1])
					.sort()
			assert.deepEqual(
				variables(translated[key]!),
				variables(en[key]!),
				`${language}:${key}`
			)
		}
	}
})
