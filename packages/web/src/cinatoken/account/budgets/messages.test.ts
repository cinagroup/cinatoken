import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceBudgetMessages } from './messages'

function messages(value: object, prefix = ''): Map<string, string> {
	const result = new Map<string, string>()
	for (const [key, item] of Object.entries(value)) {
		const path = prefix + '.' + key
		if (typeof item === 'string') result.set(path, item)
		else
			for (const [name, text] of messages(item as object, path))
				result.set(name, text)
	}
	return result
}
test('workspace budgets have complete translated messages and interpolation values', () => {
	const english = messages(workspaceBudgetMessages.en)
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		const translated = messages(workspaceBudgetMessages[locale])
		assert.deepEqual([...translated.keys()].sort(), [...english.keys()].sort())
		for (const [key, value] of translated) {
			assert.ok(value.trim(), locale + ':' + key)
			assert.deepEqual(
				value.match(/\{\{.*?\}\}/gu),
				english.get(key)?.match(/\{\{.*?\}\}/gu),
				locale + ':' + key
			)
		}
	}
})
