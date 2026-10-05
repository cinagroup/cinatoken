import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { guardrailMessages } from './messages'

test('guardrail messages cover all four locales and interpolate scope, budgets, confirmation and evidence', async () => {
	const keys = Object.keys(guardrailMessages.en).sort()
	for (const lang of ['en', 'zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(guardrailMessages[lang]).sort(), keys)
		for (const [key, value] of Object.entries(guardrailMessages[lang])) {
			assert.ok(value.trim(), `${lang}.${key}`)
			assert.doesNotMatch(
				value,
				/(?<!\{)\{\w+\}(?!\})/u,
				`${lang}.${key} must use i18next interpolation`
			)
		}
		const i18n = createInstance()
		await i18n.init({
			lng: lang,
			resources: { [lang]: { translation: guardrailMessages[lang] } },
			interpolation: { escapeValue: false },
		})
		assert.ok(
			i18n
				.t('workspaceScope', { name: 'Workspace QA' })
				.includes('Workspace QA')
		)
		assert.ok(i18n.t('budgetHint', { currency: 'CNY' }).includes('CNY'))
		assert.ok(i18n.t('confirmDesignate', { version: 3 }).includes('3'))
		assert.ok(
			i18n
				.t('previewPlannerPricingValue', {
					comparable: 1,
					prompt: 2,
					completion: 3,
					request: 4,
					image: 5,
					timezone: 'UTC',
				})
				.includes('USD')
		)
	}
})

test('translated policy and evidence copy cannot silently reuse English and retains every interpolation argument', () => {
	const localizedScripts = {
		zh: /\p{Script=Han}/u,
		ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
		ko: /\p{Script=Hangul}/u,
	}
	const argumentsOf = (value: string) =>
		[...value.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]).sort()
	for (const lang of ['zh', 'ja', 'ko'] as const) {
		for (const [key, value] of Object.entries(guardrailMessages[lang])) {
			const english =
				guardrailMessages.en[key as keyof typeof guardrailMessages.en]
			assert.deepEqual(
				argumentsOf(value),
				argumentsOf(english),
				`${lang}.${key}`
			)
			// This shared numeric format intentionally has no prose to translate.
			if (key !== 'budgetSource')
				assert.match(
					value,
					localizedScripts[lang],
					`${lang}.${key} needs localized copy`
				)
		}
	}
})
