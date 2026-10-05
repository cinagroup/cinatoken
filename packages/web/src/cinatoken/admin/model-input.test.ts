import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	createModelInput,
	modelImportIds,
	normalizeModelPricingInput,
	updateModelInput,
	ModelInputError,
	type CreateModelInput,
	type UpdateModelInput,
} from './model-input'

const tiers = { tiers: [{ upto: null, input_price: 1, output_price: 3 }] }

test('create preserves server defaults instead of inventing context/max limits or supplier routes', () => {
	assert.deepEqual(
		createModelInput({ id: 'text/model', pricing_profile: tiers }),
		{
			id: 'text/model',
			pricing_profile: JSON.stringify(tiers),
		}
	)
	const input = createModelInput({
		id: 'rerank',
		pricing_profile: tiers,
		vendor: ' DeepSeek ',
		context_window: 32_768,
		max_tokens: null,
		output_modalities: ['rerank'],
		tags: ['ranking', ' ranking ', ''],
	})
	assert.equal(input.vendor, 'deepseek')
	assert.equal(input.context_window, 32_768)
	assert.equal(input.max_tokens, null)
	assert.deepEqual(input.output_modalities, ['rerank'])
	assert.deepEqual(input.tags, ['ranking'])
	assert.equal(
		createModelInput({
			id: 'custom',
			pricing_profile: tiers,
			vendor: 'unknown-vendor',
		}).vendor,
		'other'
	)
	assert.equal('provider_id' in input, false)
})

test('image/audio models preserve null token limits and all supported input/output modalities', () => {
	const input = createModelInput({
		id: 'image',
		pricing_profile: {
			image_billing_mode: 'per_image',
			image: { default: 0.05 },
		},
		context_window: null,
		max_tokens: null,
		input_modalities: ['text', 'image', 'audio', 'video', 'file'],
		output_modalities: [
			'image',
			'audio',
			'video',
			'speech',
			'transcription',
			'embeddings',
			'rerank',
			'text',
		],
	})
	assert.equal(input.context_window, null)
	assert.equal(input.max_tokens, null)
	assert.deepEqual(input.input_modalities, [
		'text',
		'image',
		'audio',
		'video',
		'file',
	])
	assert.deepEqual(
		updateModelInput({ input_modalities: [], output_modalities: null }),
		{ input_modalities: null, output_modalities: null }
	)
})

test('PATCH omission, zero and explicit clearing remain distinct and cannot rename model identity', () => {
	assert.deepEqual(
		updateModelInput({
			max_tokens: 0,
			pricing_profile: '',
			metadata: null,
			tags: [],
		}),
		{ max_tokens: 0, pricing_profile: null, metadata: null, tags: [] }
	)
	for (const input of [
		{},
		{ display_name: undefined },
		{ id: 'other' },
		{ provider_id: 'supplier' },
		{ max_tokens: -1 },
		{ context_window: 1.5 },
	])
		assert.throws(
			() => updateModelInput(input as UpdateModelInput),
			ModelInputError
		)
	for (const input of [
		{ id: 'model' },
		{ id: 'model', pricing_profile: null },
		{ id: 'model', pricing_profile: tiers, route_policy: '{}' },
	])
		assert.throws(
			() => createModelInput(input as CreateModelInput),
			ModelInputError
		)
})

test('pricing input matches server per-image canonicalization and rejects conflicting image dimensions', () => {
	const input = {
		image_billing_mode: 'per_image',
		image: {
			default: 0.05,
			by_quality_size: { 'high:1024x1024': 0.1 },
			input: { default: 0.01 },
			uncertain_result_policy: 'requested',
		},
		tiers: [
			{ upto: null, input_price: 0, output_price: 0, image_output_price: 0 },
		],
	}
	assert.deepEqual(JSON.parse(normalizeModelPricingInput(input)!), {
		image_billing_mode: 'per_image',
		image: {
			default: 0.05,
			by_quality_size: { 'high:1024x1024': 0.1 },
			input: { default: 0.01 },
		},
	})
	for (const invalid of [
		{ image_billing_mode: 'token', image: { default: 0.1 }, ...tiers },
		{
			image_billing_mode: 'per_image',
			image: { default: 0.1 },
			tiers: [
				{ upto: null, input_price: 0, output_price: 0, image_input_price: 1 },
			],
		},
		{ image_billing_mode: 'per_image', image: { default: -1 } },
		{
			tiers: [
				{ upto: null, input_price: 1, output_price: 2 },
				{ upto: null, input_price: 3, output_price: 4 },
			],
		},
	])
		assert.throws(() => normalizeModelPricingInput(invalid), ModelInputError)
})

test('pricing uses Core finite token/cache parsing rather than inventing a stricter legacy billing policy', () => {
	const raw = {
		tiers: [
			{ upto: null, input_price: -1, output_price: 0, cache_read_price: -0.1 },
		],
	}
	assert.equal(normalizeModelPricingInput(raw), JSON.stringify(raw))
	assert.throws(
		() =>
			normalizeModelPricingInput({
				tiers: [{ upto: null, input_price: Infinity, output_price: 1 }],
			}),
		ModelInputError
	)
})

test('release dates and metadata validate exact endpoint selectors while preserving unrelated operator metadata', () => {
	assert.equal(
		updateModelInput({ released_at: '2024-02-29' }).released_at,
		'2024-02-29'
	)
	assert.throws(
		() => updateModelInput({ released_at: '2025-02-29' }),
		ModelInputError
	)
	const metadata = {
		note: 'operator context',
		public_catalog_top_provider: {
			endpoint_tag: 'global/fast',
			is_moderated: false,
		},
	}
	assert.equal(
		updateModelInput({ metadata }).metadata,
		JSON.stringify(metadata)
	)
	for (const metadata of [
		'[]',
		'false',
		'{invalid',
		{
			public_catalog_top_provider: {
				endpoint_tag: 'global',
				is_moderated: 'true',
			},
		},
		{
			public_catalog_top_provider: {
				provider_id: 'p1',
				endpoint_tag: 'global',
				is_moderated: true,
			},
		},
	])
		assert.throws(
			() => updateModelInput({ metadata } as UpdateModelInput),
			ModelInputError
		)
})

test('route policy uses the exact Core capability alias normalizer and stays PATCH-only', () => {
	const result = updateModelInput({
		route_policy: {
			strategy: 'WEIGHTED_RANDOM',
			rules: { 'openai.chat:default': { strategy: 'weight_priority' } },
		},
	})
	assert.deepEqual(JSON.parse(result.route_policy!), {
		strategy: 'weighted_random',
		rules: { 'openai.chat:default': { strategy: 'weight_priority' } },
	})
	assert.equal(updateModelInput({ route_policy: null }).route_policy, null)
	assert.throws(
		() => updateModelInput({ route_policy: { strategy: 'roundrobin-guess' } }),
		ModelInputError
	)
	assert.throws(
		() =>
			updateModelInput({
				route_policy: {
					rules: { 'anthropic.images:default': { strategy: 'hash_affinity' } },
				},
			}),
		ModelInputError
	)
})

test('import selection requires valid nonempty identities and deduplicates without changing request order', () => {
	assert.deepEqual(modelImportIds(['a', 'b', 'a']), ['a', 'b'])
	for (const ids of [[], [''], ['a\n'], [' a']])
		assert.throws(() => modelImportIds(ids), ModelInputError)
})
