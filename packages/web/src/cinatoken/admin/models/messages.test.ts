import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminModelsMessages } from './messages'

test('four model locales contain complete natural text and the same interpolation variables', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		assert.deepEqual(
			Object.keys(adminModelsMessages[locale]).sort(),
			Object.keys(adminModelsMessages.en).sort()
		)
		for (const [key, message] of Object.entries(adminModelsMessages[locale])) {
			assert.ok(message.trim(), `${locale}:${key}`)
			assert.deepEqual(
				(message.match(/\{\{.*?\}\}/gu) ?? []).sort(),
				(adminModelsMessages.en[key].match(/\{\{.*?\}\}/gu) ?? []).sort(),
				`${locale}:${key}`
			)
		}
	}
	for (const locale of ['zh', 'ja', 'ko'] as const)
		for (const key of [
			'writeUnknown',
			'importResult',
			'deleteWarning',
			'currencyUnknown',
			'currencyCurrent',
			'validation',
		])
			assert.notEqual(
				adminModelsMessages[locale][key],
				adminModelsMessages.en[key]
			)
})
