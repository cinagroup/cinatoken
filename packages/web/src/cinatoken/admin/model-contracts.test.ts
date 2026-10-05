import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	modelCatalogResponseSchema,
	modelListResponseSchema,
	modelResponseSchema,
	modelPricingDetails,
} from './model-contracts'

test('model pricing preserves token/cache and image-token per-million values without relabeling currency', () => {
	const value = modelPricingDetails(
		JSON.stringify({
			tiers: [
				{
					upto: 20_000,
					input_price: 1,
					output_price: 4,
					cache_read_price: 0.1,
					cache_write_price: 0.5,
					image_input_price: 2,
					image_input_cache_price: 0.2,
					image_output_price: 8,
				},
				{ upto: null, input_price: 3, output_price: 12 },
			],
		})
	)
	assert.equal(value.state, 'available')
	assert.equal(value.imageBillingMode, 'token')
	assert.equal(value.audioBillingMode, null)
	assert.equal(value.profile?.tiers[0].input_price, 1)
	assert.equal(value.profile?.tiers[0].cache_write_price, 0.5)
	assert.equal(value.profile?.tiers[0].image_input_cache_price, 0.2)
	assert.equal(value.profile?.tiers[1].upto, null)
	assert.equal('currency' in value, false)
})

test('per-image pricing preserves output maps, input reference pricing and uncertain-result policy', () => {
	const value = modelPricingDetails(
		JSON.stringify({
			image_billing_mode: 'per_image',
			image: {
				default: 0.06,
				by_quality: { high: 0.1 },
				by_size: { '1024x1024': 0.08 },
				by_quality_size: { 'high:1024x1024': 0.2 },
				input: { default: 0.01, by_quality: { high: 0.03 } },
				uncertain_result_policy: 'zero',
			},
		})
	)
	assert.equal(value.imageBillingMode, 'per_image')
	assert.deepEqual(value.profile?.tiers, [])
	assert.equal(value.profile?.image?.by_quality_size?.['high:1024x1024'], 0.2)
	assert.equal(value.profile?.image?.input?.default, 0.01)
	assert.equal(value.profile?.image?.uncertain_result_policy, 'zero')
})

test('audio retains second, token and character units and billing minimums without conversion', () => {
	const second = modelPricingDetails(
		'{"audio_billing_mode":"per_second","audio":{"price_per_second":0.0001,"minimum_seconds":1.5}}'
	)
	assert.equal(second.audioBillingMode, 'per_second')
	assert.equal(second.profile?.audio?.price_per_second, 0.0001)
	assert.equal(second.profile?.audio?.minimum_seconds, 1.5)
	const character = modelPricingDetails(
		'{"audio_billing_mode":"per_character","audio":{"price_per_character":0.00002,"minimum_characters":20}}'
	)
	assert.equal(character.audioBillingMode, 'per_character')
	assert.equal(character.profile?.audio?.minimum_characters, 20)
	const token = modelPricingDetails(
		'{"audio_billing_mode":"token","tiers":[{"upto":null,"input_price":1.25,"output_price":5}]}'
	)
	assert.equal(token.audioBillingMode, 'token')
	assert.equal(token.profile?.tiers[0].output_price, 5)
})

test('legacy image blocks do not silently become per-image billing; missing or invalid profiles remain explicit', () => {
	const legacy = modelPricingDetails(
		'{"tiers":[{"upto":null,"input_price":0,"output_price":0}],"image":{"default":0.05}}'
	)
	assert.equal(legacy.state, 'available')
	assert.equal(legacy.imageBillingMode, null)
	assert.equal(modelPricingDetails(null).state, 'missing')
	assert.equal(modelPricingDetails(' ').state, 'missing')
	assert.equal(modelPricingDetails('{invalid').state, 'invalid')
	assert.equal(
		modelPricingDetails('{"image_billing_mode":"guess"}').state,
		'invalid'
	)
})

test('catalog requires its actual billing branch even for an empty collection', () => {
	for (const billing_currency of ['USD', 'CNY'])
		assert.equal(
			modelCatalogResponseSchema.safeParse({
				success: true,
				data: [],
				count: 0,
				billing_currency,
			}).success,
			true
		)
	for (const billing_currency of [undefined, 'usd', 'EUR'])
		assert.equal(
			modelCatalogResponseSchema.safeParse({
				success: true,
				data: [],
				count: 0,
				billing_currency,
			}).success,
			false
		)
})

test('model list and detail require current gateway currency independent of the import branch', () => {
	const row = {
		id: 'old/model',
		display_name: null,
		vendor: 'other',
		context_window: null,
		max_tokens: null,
		pricing_profile: null,
		input_modalities: null,
		output_modalities: null,
		released_at: null,
		description: null,
		metadata: null,
		route_policy: null,
		created_at: '2026-09-27T00:00:00.000Z',
		routes_count: 0,
		active_routes_count: 0,
		tags: [],
	}
	for (const currency of ['USD', 'CNY', 'EUR']) {
		assert.equal(
			modelListResponseSchema.safeParse({
				success: true,
				data: [],
				count: 0,
				billing_currency: currency,
			}).success,
			true
		)
		assert.equal(
			modelResponseSchema.safeParse({
				success: true,
				data: row,
				billing_currency: currency,
			}).success,
			true
		)
	}
	for (const currency of [undefined, null, '', 'usd', 'US', 'USDD', 'USD!']) {
		assert.equal(
			modelListResponseSchema.safeParse({
				success: true,
				data: [],
				count: 0,
				billing_currency: currency,
			}).success,
			false
		)
		assert.equal(
			modelResponseSchema.safeParse({
				success: true,
				data: row,
				billing_currency: currency,
			}).success,
			false
		)
	}
})
