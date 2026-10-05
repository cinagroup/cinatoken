import assert from 'node:assert/strict'
import test from 'node:test'
import { consoleMessages } from './messages'

test('Console access and navigation copy is complete and localized in all four languages', () => {
	const keys = Object.keys(consoleMessages.en).sort()
	const scripts = {
		zh: /\p{Script=Han}/u,
		ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
		ko: /\p{Script=Hangul}/u,
	}
	for (const language of ['zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(consoleMessages[language]).sort(), keys)
		for (const [key, value] of Object.entries(consoleMessages[language]))
			assert.match(value, scripts[language], `${language}.${key}`)
	}
})
