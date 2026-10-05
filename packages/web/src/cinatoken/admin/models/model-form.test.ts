import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminModelSchema } from '../model-contracts'
import { normalizeModelPricingInput } from '../model-input'
import {
	DEFAULT_MODEL_FILTERS,
	emptyTier,
	filterModels,
	modelFormDefaults,
	modelFormInput,
	pricingDefaults,
	pricingInput,
} from './model-form'

const tokenProfile = JSON.stringify({
	tiers: [
		{
			upto: 20000,
			input_price: 1,
			output_price: 4,
			cache_read_price: 0.1,
			cache_write_price: 0.5,
			image_input_price: 2,
			image_input_cache_price: 0.2,
			image_output_price: 8,
		},
		{ upto: 50000, input_price: 3, output_price: 12 },
	],
})
function row(overrides: Record<string, unknown> = {}) {
	return adminModelSchema.parse({
		id: 'text/model',
		display_name: 'Alpha',
		vendor: 'openai',
		context_window: 32000,
		max_tokens: 8192,
		pricing_profile: tokenProfile,
		input_modalities: '["text","image","audio","video","file"]',
		output_modalities: '["text"]',
		released_at: '2026-09-27',
		description: 'Multimodal reasoning',
		metadata: '{"note":"operator"}',
		route_policy: '{"strategy":"weighted_random"}',
		created_at: '2026-09-27T00:00:00.000Z',
		routes_count: 2,
		active_routes_count: 1,
		tags: ['reasoning'],
		...overrides,
	})
}
test('editing metadata preserves exact legacy, missing and invalid prices and policy until explicit replacement', () => {
	for (const pricing_profile of [tokenProfile, null, '{old malformed']) {
		const values = modelFormDefaults(
			row({ pricing_profile, metadata: '{old metadata' })
		)
		values.description = 'New description'
		const input = modelFormInput(values, true)
		assert.equal(Object.hasOwn(input, 'pricing_profile'), false)
		assert.equal(Object.hasOwn(input, 'metadata'), false)
		assert.equal(Object.hasOwn(input, 'route_policy'), false)
		assert.equal(Object.hasOwn(input, 'id'), false)
		assert.equal(input.description, 'New description')
		assert.deepEqual(input.input_modalities, [
			'audio',
			'file',
			'image',
			'text',
			'video',
		])
	}
})
test('tier editing retains finite terminal boundaries and every cache/image unit without conversions', () => {
	const draft = pricingDefaults(row())
	assert.equal(draft.tiers[1].upto, '50000')
	const value = JSON.parse(normalizeModelPricingInput(pricingInput(draft))!)
	assert.deepEqual(value, {
		...JSON.parse(tokenProfile),
		image_billing_mode: 'token',
	})
	draft.tiers[1].upto = ''
	assert.equal(
		JSON.parse(normalizeModelPricingInput(pricingInput(draft))!).tiers[1].upto,
		null
	)
	draft.tiers[0].upto = ''
	assert.throws(() => normalizeModelPricingInput(pricingInput(draft)))
})
test('blank optional prices stay omitted, explicit zero persists and the Core legacy text/cache policy is retained', () => {
	const draft = pricingDefaults()
	draft.tiers[0].input_price = '-1'
	draft.tiers[0].output_price = '0'
	draft.tiers[0].cache_read_price = '-0.2'
	assert.deepEqual(
		JSON.parse(normalizeModelPricingInput(pricingInput(draft))!),
		{
			tiers: [
				{
					upto: null,
					input_price: -1,
					output_price: 0,
					cache_read_price: -0.2,
				},
			],
		}
	)
	draft.tiers[0].image_output_price = '-1'
	assert.throws(() => pricingInput(draft))
	draft.tiers[0].image_output_price = ''
	draft.tiers[0].input_price = ''
	assert.throws(() => pricingInput(draft))
})
test('per-image replacement round-trips output/reference maps and zero policy in exact image units', () => {
	const profile = {
		image_billing_mode: 'per_image',
		image: {
			default: 0.06,
			by_quality: { high: 0.1 },
			by_size: { '1024x1024': 0.08 },
			by_quality_size: { 'high:1024x1024': 0.2 },
			input: { default: 0.01, by_quality: { high: 0.03 } },
			uncertain_result_policy: 'zero',
		},
	}
	const draft = pricingDefaults(
		row({
			pricing_profile: JSON.stringify(profile),
			output_modalities: '["image"]',
		})
	)
	assert.equal(draft.mode, 'per_image')
	assert.deepEqual(
		JSON.parse(normalizeModelPricingInput(pricingInput(draft))!),
		profile
	)
	draft.image.by_quality.push({ key: ' HIGH ', price: '0.4' })
	assert.throws(() => pricingInput(draft))
	draft.image.by_quality.pop()
	draft.image.by_size[0].price = '-1'
	assert.throws(() => pricingInput(draft))
	draft.image.by_size[0].price = '0.08'
	draft.reference.default = ''
	assert.throws(() => pricingInput(draft))
})
test('audio second, character and token profiles retain exact units, minimums and zero values', () => {
	for (const profile of [
		{
			audio_billing_mode: 'per_second',
			audio: { price_per_second: 0.0001, minimum_seconds: 1.5 },
		},
		{
			audio_billing_mode: 'per_character',
			audio: { price_per_character: 0, minimum_characters: 0 },
		},
		{
			audio_billing_mode: 'token',
			tiers: [{ upto: null, input_price: 1.25, output_price: 5 }],
		},
	]) {
		const draft = pricingDefaults(
			row({
				pricing_profile: JSON.stringify(profile),
				input_modalities: '["audio"]',
				output_modalities: '["transcription"]',
			})
		)
		assert.deepEqual(
			JSON.parse(normalizeModelPricingInput(pricingInput(draft))!),
			profile
		)
	}
	const draft = pricingDefaults()
	draft.mode = 'per_character'
	draft.audioPrice = '0.002'
	draft.minimum = '1.5'
	assert.throws(() => pricingInput(draft))
	draft.minimum = ''
	draft.audioPrice = '-1'
	assert.throws(() => pricingInput(draft))
})
test('clear is distinct from keep, and a new model cannot be created without prices', () => {
	const values = modelFormDefaults(row())
	values.pricingAction = 'clear'
	values.metadataAction = 'clear'
	values.routePolicyAction = 'clear'
	const input = modelFormInput(values, true)
	assert.equal(input.pricing_profile, null)
	assert.equal(input.metadata, null)
	assert.equal('route_policy' in input && input.route_policy, null)
	const created = modelFormDefaults()
	created.id = 'new'
	assert.throws(() => modelFormInput(created, false))
	created.pricing.tiers = [
		{ ...emptyTier(), input_price: '0', output_price: '1' },
	]
	const newInput = modelFormInput(created, false)
	assert.equal('id' in newInput && newInput.id, 'new')
	assert.equal(Object.hasOwn(newInput, 'route_policy'), false)
})
test('metadata replacement validates an exact endpoint selector without dropping unrelated fields', () => {
	const values = modelFormDefaults(row())
	values.metadataAction = 'replace'
	values.topProviderEnabled = true
	values.endpointTag = 'global/fast'
	values.isModerated = true
	assert.deepEqual(
		JSON.parse(modelFormInput(values, true).metadata as string),
		{
			note: 'operator',
			public_catalog_top_provider: {
				endpoint_tag: 'global/fast',
				is_moderated: true,
			},
		}
	)
	values.endpointTag = ''
	assert.throws(() => modelFormInput(values, true))
	values.topProviderEnabled = false
	assert.deepEqual(
		JSON.parse(modelFormInput(values, true).metadata as string),
		{ note: 'operator' }
	)
	values.metadata = '[]'
	assert.throws(() => modelFormInput(values, true))
})
test('advanced profiles, PATCH-only policy, invalid dates and limits use actual server validation', () => {
	const values = modelFormDefaults(row())
	values.pricingAction = 'replace'
	values.pricing.advanced = true
	values.pricing.raw = tokenProfile
	assert.equal(modelFormInput(values, true).pricing_profile, tokenProfile)
	values.routePolicyAction = 'replace'
	values.routePolicy = '{"strategy":"WEIGHTED_RANDOM"}'
	assert.equal(
		'route_policy' in modelFormInput(values, true) &&
			(modelFormInput(values, true) as { route_policy: string }).route_policy,
		'{"strategy":"weighted_random"}'
	)
	for (const released_at of ['2025-02-29', 'bad date']) {
		values.released_at = released_at
		assert.throws(() => modelFormInput(values, true))
	}
	values.released_at = ''
	values.max_tokens = '-1'
	assert.throws(() => modelFormInput(values, true))
})
test('filters preserve source order and distinguish no routes from disabled linked routes', () => {
	const rows = [
		row(),
		row({
			id: 'unrouted',
			vendor: 'other',
			routes_count: 0,
			active_routes_count: 0,
		}),
		row({
			id: 'disabled-image',
			routes_count: 1,
			active_routes_count: 0,
			output_modalities: '["image"]',
		}),
	]
	assert.deepEqual(
		filterModels(rows, { ...DEFAULT_MODEL_FILTERS, q: ' REASONING ' }).map(
			(item) => item.id
		),
		rows.map((item) => item.id)
	)
	assert.deepEqual(
		filterModels(rows, {
			...DEFAULT_MODEL_FILTERS,
			availability: 'callable',
		}).map((item) => item.id),
		['text/model']
	)
	assert.deepEqual(
		filterModels(rows, {
			...DEFAULT_MODEL_FILTERS,
			availability: 'unrouted',
		}).map((item) => item.id),
		['unrouted']
	)
	assert.deepEqual(
		filterModels(rows, { ...DEFAULT_MODEL_FILTERS, kind: 'image' }).map(
			(item) => item.id
		),
		['disabled-image']
	)
	assert.deepEqual(
		filterModels(rows, { ...DEFAULT_MODEL_FILTERS, vendor: 'other' }).map(
			(item) => item.id
		),
		['unrouted']
	)
	assert.equal(rows.length, 3)
})
