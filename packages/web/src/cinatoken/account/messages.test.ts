import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accountMessages } from './messages'

function leaves(value: object, prefix = ''): Map<string, string> {
	const result = new Map<string, string>()
	for (const [key, item] of Object.entries(value)) {
		const path = prefix ? `${prefix}.${key}` : key
		if (typeof item === 'string') result.set(path, item)
		else
			for (const [nested, text] of leaves(item as object, path))
				result.set(nested, text)
	}
	return result
}

test('every account locale has the same keys and interpolation variables', () => {
	const expected = leaves(accountMessages.en)
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		const translated = leaves(accountMessages[locale])
		assert.deepEqual(
			[...translated.keys()].sort(),
			[...expected.keys()].sort(),
			locale
		)
		for (const [key, text] of translated) {
			assert.ok(text.trim(), `${locale}:${key}`)
			assert.deepEqual(
				(text.match(/\{\{.*?\}\}/g) ?? []).sort(),
				(expected.get(key)?.match(/\{\{.*?\}\}/g) ?? []).sort(),
				`${locale}:${key}`
			)
		}
	}
})
