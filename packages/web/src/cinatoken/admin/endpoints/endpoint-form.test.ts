/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { adminEndpointSchema } from '../endpoint-contracts'
import {
	audioMeterKinds,
	endpointFormDefaults,
	endpointFormInput,
	endpointFormSchema,
	newAudioOperation,
} from './endpoint-form'

const row = adminEndpointSchema.parse({
	id: 'image/one',
	model_id: 'model/one',
	provider_id: 'provider/one',
	provider_slug: 'image-provider',
	tag: 'image-provider',
	endpoint_class: null,
	region: null,
	context_length: null,
	max_prompt_tokens: null,
	max_completion_tokens: null,
	quantization: null,
	supported_parameters: [],
	pricing: null,
	supports_implicit_caching: null,
	supports_voice_cloning: null,
	supports_tool_choice: {
		auto: null,
		function: null,
		none: null,
		required: null,
	},
	image_capabilities: {
		provider_slug: 'image-provider',
		provider_tag: null,
		supports_streaming: false,
		supported_parameters: {
			quality: { type: 'enum', values: ['quality:high', 'draft.fast'] },
			size: { type: 'range', min: 256, max: 4096 },
		},
		allowed_passthrough_parameters: ['seed'],
		pricing: [
			{
				billable: 'output_image',
				unit: 'image',
				cost_usd: '0.03',
				variant: 'high',
			},
		],
	},
	audio_capabilities: null,
	evidence_url: 'https://example.test/evidence',
	verified_by: 'admin',
	verified_at: '2026-09-27T10:00:00.000Z',
	expires_at: '2026-10-27T10:00:00.000Z',
	status: 'verified',
	created_at: '2026-09-27T00:00:00.000Z',
	updated_at: '2026-09-27T10:00:00.000Z',
	route_target_ids: ['route/one'],
})

test('unchanged verified evidence with nullable class produces no destructive patch', () => {
	const draft = endpointFormDefaults(row)
	assert.equal(draft.endpoint_class, '')
	assert.deepEqual(draft.image.parameters[0]!.values, [
		'quality:high',
		'draft.fast',
	])
	assert.equal(endpointFormSchema(row).safeParse(draft).success, true)
	assert.deepEqual(endpointFormInput(draft, row), {})
})

test('editing a single image enum value preserves other values and evidence', () => {
	const draft = endpointFormDefaults(row)
	draft.image.parameters[0]!.values[0] = 'quality:ultra-high'
	const patch = endpointFormInput(draft, row)
	assert.deepEqual(Object.keys(patch), ['image_capabilities'])
	assert.deepEqual(patch.image_capabilities?.supported_parameters.quality, {
		type: 'enum',
		values: ['quality:ultra-high', 'draft.fast'],
	})
	assert.deepEqual(
		patch.image_capabilities?.pricing,
		row.image_capabilities?.pricing
	)
})

test('create remains draft-only and field errors never publish implicitly', () => {
	const draft = endpointFormDefaults()
	draft.model_id = row.model_id
	draft.provider_id = row.provider_id
	draft.provider_slug = row.provider_slug
	draft.tag = row.tag
	assert.equal(endpointFormSchema().safeParse(draft).success, true)
	assert.equal(endpointFormInput(draft).status, 'draft')
	draft.status = 'verified'
	assert.equal(endpointFormSchema().safeParse(draft).success, false)
})

test('valid audio meters and speech evidence survive an unchanged edit', () => {
	const audioRow = adminEndpointSchema.parse({
		...row,
		image_capabilities: null,
		supports_voice_cloning: true,
		pricing: {
			currency: 'USD',
			prompt: '0.000001',
			completion: '0.000002',
			web_search: '0.01',
		},
		audio_capabilities: {
			v: 1,
			pricing_by_operation: {
				'audio.transcriptions': {
					currency: 'USD',
					meter: {
						kind: 'tokens',
						unit: 'token',
						require_authoritative_breakdown: true,
						rates: {
							input_audio: '0.01',
							input_text: '0.02',
							output_text: '0.03',
							output_audio: '0.04',
							input_audio_cache: '0.005',
						},
					},
				},
				'audio.speech': {
					currency: 'USD',
					meter: {
						kind: 'characters',
						unit: 'unicode_code_point',
						price: '0.01',
						minimum_units: 0,
						increment_units: 1,
					},
				},
			},
			speech_by_operation: {
				'audio.speech': {
					supports_default_voice: true,
					reference_audio_media_types: ['audio/wav'],
					reference_audio_default_media_type: 'audio/wav',
				},
			},
		},
	})
	const draft = endpointFormDefaults(audioRow)
	assert.equal(endpointFormSchema(audioRow).safeParse(draft).success, true)
	assert.deepEqual(endpointFormInput(draft, audioRow), {})
	assert.deepEqual(audioMeterKinds('audio.speech'), ['characters'])
	assert.deepEqual(audioMeterKinds('audio.transcriptions'), [
		'duration',
		'tokens',
	])
	assert.equal(newAudioOperation('audio.speech').kind, 'characters')
})
