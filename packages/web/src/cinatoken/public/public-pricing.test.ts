import * as React from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { PricingDetails, PriceSummary } from './CatalogPricing'
import type { CatalogPricing } from './catalog-contracts'
import { publicMessages } from './messages'

const createElement = React.createElement
// The Node test loader uses classic JSX for this referenced app tsconfig.
// Supply its real React runtime without changing the production JSX transform.
Object.assign(globalThis, { React })

async function render(
	locale: keyof typeof publicMessages,
	profile: CatalogPricing
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		resources: {
			[locale]: {
				translation: { cinatoken: { public: publicMessages[locale] } },
			},
		},
		interpolation: { escapeValue: false },
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(PricingDetails, { profile, currency: 'CNY' })
		)
	)
}
test('actual pricing markup shows all cache/image token fields and preserves non-USD, negative and zero values in every locale', async () => {
	const profile: CatalogPricing = {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: -1,
				output_price: 2,
				cache_read_price: 0,
				cache_write_price: 0.25,
				image_input_price: 0.5,
				image_input_cache_price: 0.1,
				image_output_price: 4,
			},
		],
	}
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(locale, profile)
		for (const key of [
			'inputPrice',
			'outputPrice',
			'cacheRead',
			'cacheWrite',
			'imageInput',
			'imageCache',
			'imageOutput',
			'unlimited',
		] as const)
			assert.ok(html.includes(publicMessages[locale][key]), `${locale}.${key}`)
		assert.ok(html.includes('CNY'))
		assert.ok(html.includes('-'))
		assert.equal(html.includes('cinatoken.public.'), false)
	}
})
test('actual multimodal markup keeps quality/size/reference maps and fractional minimums, and hides ignored legacy prices', async () => {
	const image: CatalogPricing = {
		tiers: [],
		image_billing_mode: 'per_image',
		image: {
			default: 0,
			by_quality: { high: 0.2 },
			by_size: { '1024x1024': 0.3 },
			by_quality_size: { 'high:1024x1024': 0.5 },
			input: { default: 0.1 },
			uncertain_result_policy: 'zero',
		},
	}
	const html = await render('ja', image)
	for (const key of [
		'quality',
		'size',
		'qualitySize',
		'referenceImages',
		'zero',
	] as const)
		assert.ok(html.includes(publicMessages.ja[key]))
	assert.ok(html.includes('high:1024x1024'))
	const audio = await render('ko', {
		tiers: [],
		audio_billing_mode: 'per_second',
		audio: { price_per_second: 0.001, minimum_seconds: 1.5 },
	})
	assert.ok(audio.includes('1.5'))
	assert.ok(audio.includes(publicMessages.ko.secondUnit))
	const legacy = await render('zh', {
		tiers: [
			{
				upto: null,
				label: null,
				input_price: 1,
				output_price: 2,
				cache_read_price: null,
				cache_write_price: null,
				image_input_price: null,
				image_input_cache_price: null,
				image_output_price: null,
			},
		],
		image: { default: 999 },
	})
	assert.ok(legacy.includes(publicMessages.zh.legacyImage))
	assert.equal(legacy.includes('999'), false)
	const i18n = createInstance()
	await i18n.init({
		lng: 'en',
		resources: {
			en: { translation: { cinatoken: { public: publicMessages.en } } },
		},
	})
	const summary = renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(PriceSummary, { profile: image, currency: 'EUR' })
		)
	)
	assert.ok(summary.includes('EUR'))
	assert.ok(summary.includes(publicMessages.en.imageUnit))
})
test('all public copy is translated and preserves interpolation across four languages', () => {
	const argumentsOf = (value: string) =>
		[...value.matchAll(/\{\{(\w+)\}\}/gu)].map((match) => match[1]).sort()
	const scripts = {
		zh: /\p{Script=Han}/u,
		ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
		ko: /\p{Script=Hangul}/u,
	}
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		assert.deepEqual(
			Object.keys(publicMessages[locale]).sort(),
			Object.keys(publicMessages.en).sort()
		)
		for (const [key, value] of Object.entries(publicMessages[locale])) {
			assert.match(value, scripts[locale], `${locale}.${key}`)
			assert.deepEqual(
				argumentsOf(value),
				argumentsOf(publicMessages.en[key as keyof typeof publicMessages.en]),
				`${locale}.${key}`
			)
		}
	}
})
