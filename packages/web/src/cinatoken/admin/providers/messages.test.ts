import assert from 'node:assert/strict'
import { test } from 'node:test'
import { providerMessages } from './messages'

test('provider locales have complete messages and preserve interpolation variables in natural order', () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		assert.deepEqual(
			Object.keys(providerMessages[locale]).sort(),
			Object.keys(providerMessages.en).sort()
		)
		for (const [key, message] of Object.entries(providerMessages[locale])) {
			assert.ok(message.trim(), `${locale}:${key}`)
			assert.deepEqual(
				(message.match(/\{\{.*?\}\}/gu) ?? []).sort(),
				(providerMessages.en[key].match(/\{\{.*?\}\}/gu) ?? []).sort(),
				`${locale}:${key}`
			)
		}
	}
})
