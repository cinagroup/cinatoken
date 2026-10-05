import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminModelSchema } from '../model-contracts'
import { ModelPricePreview } from './ModelPricePreview'
import { adminModelsMessages } from './messages'

async function render(profile: unknown, locale = 'en'): Promise<string> {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		fallbackLng: false,
		resources: Object.fromEntries(
			Object.entries(adminModelsMessages).map(([language, messages]) => [
				language,
				{ translation: { cinatoken: { adminModels: messages } } },
			])
		),
	})
	const row = adminModelSchema.parse({
		id: 'model',
		display_name: null,
		vendor: 'other',
		context_window: null,
		max_tokens: null,
		pricing_profile:
			typeof profile === 'string' ? profile : JSON.stringify(profile),
		input_modalities: null,
		output_modalities: null,
		released_at: null,
		description: null,
		metadata: null,
		route_policy: null,
		created_at: '2026-09-27T00:00:00Z',
		routes_count: 0,
		active_routes_count: 0,
		tags: [],
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(ModelPricePreview, { row })
		)
	)
}
test('rendered token preview keeps zero text and nonzero image prices visible without inventing a currency', async () => {
	const html = await render({
		tiers: [
			{
				upto: null,
				input_price: 0,
				output_price: 0,
				image_input_price: 2,
				image_output_price: 8,
			},
		],
	})
	assert.match(html, /Input price.*0/)
	assert.match(html, /Image input token price.*2/)
	assert.match(html, /Image output token price.*8/)
	assert.match(html, /per 1M tokens/)
	assert.doesNotMatch(html, /USD|CNY|\$/)
})
test('rendered image, second and character previews retain the actual dimensions rather than token conversions', async () => {
	const cases = [
		{
			profile: { image_billing_mode: 'per_image', image: { default: 0.06 } },
			label: 'Per image',
			value: '0.06',
		},
		{
			profile: {
				audio_billing_mode: 'per_second',
				audio: { price_per_second: 0.0001 },
			},
			label: 'Price per audio second',
			value: '0.0001',
		},
		{
			profile: {
				audio_billing_mode: 'per_character',
				audio: { price_per_character: 0.00002 },
			},
			label: 'Price per speech character',
			value: '0.00002',
		},
	]
	for (const item of cases) {
		const html = await render(item.profile)
		assert.ok(html.includes(item.label))
		assert.ok(html.includes(item.value))
		assert.doesNotMatch(html, /per 1M|USD|CNY/)
	}
})
test('pricing failure and card units are translated in all four locales without untranslated keys', async () => {
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const invalid = await render('{invalid', locale)
		assert.ok(invalid.includes(adminModelsMessages[locale].pricing_invalid))
		const token = await render(
			{ tiers: [{ upto: null, input_price: 1, output_price: 2 }] },
			locale
		)
		assert.ok(token.includes(adminModelsMessages[locale].input_price))
		assert.doesNotMatch(token, /cinatoken\.|\{\{/)
	}
})
