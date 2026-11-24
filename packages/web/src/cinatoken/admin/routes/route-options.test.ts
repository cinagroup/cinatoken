/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adminModelSchema } from '../model-contracts'
import { adminProviderSchema } from '../provider-contracts'
import { routeAdapterDescriptor } from './route-adapter-catalog'
import { emptyRouteDraft } from './route-domain'
import {
	applyDashScopePreset,
	configuredProviderCapabilities,
	reconcileRouteDraft,
	requestOperationsForModel,
	topologyAvailable,
	upstreamOperationsForProviderModel,
	type DashScopePreset,
} from './route-options'

function model(output: string) {
	return adminModelSchema.parse({
		id: 'model',
		display_name: 'Example',
		vendor: 'openai',
		context_window: null,
		max_tokens: null,
		pricing_profile: null,
		input_modalities: '["text"]',
		output_modalities: JSON.stringify([output]),
		released_at: null,
		description: null,
		metadata: null,
		route_policy: null,
		created_at: '2026-10-01T00:00:00Z',
		routes_count: 0,
		active_routes_count: 0,
		tags: [],
	})
}
const provider = adminProviderSchema.parse({
	id: 'provider',
	name: 'Provider',
	vendor_key: 'other',
	icon_key: 'other',
	api_key: '***',
	status: 'active',
	description: null,
	created_at: '2026-10-01T00:00:00Z',
	has_pending_key: false,
	routes_count: 0,
	active_routes_count: 0,
	endpoints: JSON.stringify({
		dashscope: { base: 'https://example.invalid' },
		openai: { base: 'https://example.invalid' },
		gemini: {
			endpoints: { streamGenerateContent: 'https://example.invalid/{model}' },
		},
	}),
})

test('request operations constrain image, embeddings, rerank, ASR, TTS and text modalities', () => {
	assert.deepEqual(requestOperationsForModel(model('image'), 'openai'), [
		'images.generations',
		'images.edits',
	])
	assert.deepEqual(requestOperationsForModel(model('image'), 'anthropic'), [])
	assert.deepEqual(requestOperationsForModel(model('embeddings'), 'openai'), [
		'embeddings',
	])
	assert.deepEqual(requestOperationsForModel(model('rerank'), 'openai'), [
		'rerank',
	])
	assert.deepEqual(requestOperationsForModel(model('text'), 'openai'), [
		'chat',
		'responses',
	])
	assert.deepEqual(requestOperationsForModel(model('speech'), 'dashscope'), [
		'audio.speech.realtime.inference',
		'audio.speech',
		'audio.speech.stream',
		'audio.speech.multimodal',
		'audio.speech.realtime.session',
	])
	assert.deepEqual(requestOperationsForModel(model('text'), 'dashscope'), [])
	assert.deepEqual(requestOperationsForModel(model('text'), 'minimax'), [])
	assert.equal(
		requestOperationsForModel(model('transcription'), 'dashscope').includes(
			'audio.transcriptions'
		),
		false
	)
	assert.equal(
		requestOperationsForModel(model('transcription'), 'dashscope').includes(
			'audio.transcriptions.async'
		),
		true
	)
	assert.equal(requestOperationsForModel(undefined, 'openai').length, 0)
	assert.equal(
		requestOperationsForModel(
			model('transcription'),
			'dashscope',
			'qwen3-asr-flash'
		).includes('audio.transcriptions.realtime.session'),
		false
	)
})

test('native TTS transport choices map to endpoint capabilities rather than operation names', () => {
	const partial = {
		...provider,
		endpoints: JSON.stringify({
			dashscope: {
				endpoints: { 'audio.speech': 'https://example.invalid/speech' },
			},
		}),
	}
	assert.deepEqual(
		upstreamOperationsForProviderModel(partial, model('speech'), 'dashscope'),
		['audio.speech', 'audio.speech.stream']
	)
	const session = {
		...provider,
		endpoints: JSON.stringify({
			dashscope: {
				endpoints: {
					'audio.realtime.session': 'wss://example.invalid/session',
				},
			},
		}),
	}
	assert.deepEqual(
		upstreamOperationsForProviderModel(session, model('speech'), 'dashscope'),
		['audio.speech.realtime.session']
	)
	const transcription = model('transcription')
	assert.equal(
		requestOperationsForModel(
			transcription,
			'dashscope',
			'qwen3-asr-flash-realtime'
		).includes('audio.transcriptions.realtime.inference'),
		false
	)
	assert.equal(
		requestOperationsForModel(
			transcription,
			'dashscope',
			'qwen3-asr-flash-realtime'
		).includes('audio.transcriptions.realtime.session'),
		true
	)
})

test('native asynchronous ASR requires submission and task query endpoints together', () => {
	for (const capabilities of [
		['audio.transcriptions'],
		['audio.transcriptions.tasks'],
		['audio.transcriptions', 'audio.transcriptions.tasks'],
	]) {
		const partial = {
			...provider,
			endpoints: JSON.stringify({
				dashscope: {
					endpoints: Object.fromEntries(
						capabilities.map((capability) => [
							capability,
							'https://example.invalid/' +
								capability +
								(capability === 'audio.transcriptions.tasks'
									? '/{task_id}'
									: ''),
						])
					),
				},
			}),
		}
		const draft = {
			...emptyRouteDraft,
			requestProtocol: 'dashscope',
			requestOperation: 'audio.transcriptions.async',
			upstreamProtocol: 'dashscope',
			upstreamOperation: 'audio.transcriptions.async',
			adapter: 'passthrough',
			providerModelName: 'paraformer-v2',
		}
		assert.equal(
			topologyAvailable(draft, model('transcription'), partial),
			capabilities.length === 2
		)
	}
})

test('capability discovery fails closed for absent/redacted config and requires the complete async lifecycle', () => {
	assert.deepEqual(
		upstreamOperationsForProviderModel(
			{ ...provider, endpointsState: 'redacted' },
			model('text'),
			'openai'
		),
		[]
	)
	const partial = {
		...provider,
		endpoints: JSON.stringify({
			dashscope: {
				endpoints: { 'audio.transcriptions': 'https://example.invalid' },
			},
		}),
	}
	assert.equal(
		upstreamOperationsForProviderModel(
			partial,
			model('transcription'),
			'dashscope',
			'paraformer-v2'
		).includes('audio.transcriptions.async'),
		false
	)
	assert.deepEqual(configuredProviderCapabilities(provider, 'gemini'), [
		'models.generate',
	])
	assert.equal(
		upstreamOperationsForProviderModel(
			provider,
			model('image'),
			'openai'
		).includes('chat'),
		false
	)
})

test('seven presets preserve identity/pricing/custom fields and require both model and provider capabilities', () => {
	const original = {
		...emptyRouteDraft,
		modelId: 'model',
		providerId: 'provider',
		providerModelName: 'qwen3-asr-flash',
		customParams: '{"language":"en"}',
		priority: '20',
		chargedFactor: '1.5',
	}
	for (const preset of [
		'flash-convert',
		'flash-passthrough',
		'filetrans',
		'nonrealtime',
		'realtime',
		'image-qwen',
		'image-wan',
	] as DashScopePreset[]) {
		const draft = applyDashScopePreset(original, preset)
		assert.equal(draft.customParams, original.customParams)
		assert.equal(draft.priority, original.priority)
		assert.equal(draft.chargedFactor, original.chargedFactor)
		let modality = 'transcription'
		if (['nonrealtime', 'realtime'].includes(preset)) modality = 'speech'
		if (preset.startsWith('image-')) modality = 'image'
		assert.equal(
			topologyAvailable(draft, model(modality), provider),
			true,
			preset
		)
		assert.equal(
			topologyAvailable(draft, model('text'), provider),
			false,
			preset
		)
		assert.equal(
			topologyAvailable(draft, model(modality), {
				...provider,
				endpointsState: 'redacted',
			}),
			false,
			preset
		)
	}
})

test('adapter guide resolves the full topology and modality without guessing legacy surfaces', () => {
	const draft = {
		...emptyRouteDraft,
		requestProtocol: 'gemini',
		requestOperation: 'models.generate',
		upstreamProtocol: 'gemini',
		upstreamOperation: 'models.generate',
		adapter: 'passthrough',
	}
	assert.equal(
		routeAdapterDescriptor(draft, model('image'))?.optionKey,
		'passthrough:gemini:models.generate:image'
	)
	assert.equal(routeAdapterDescriptor(draft, model('text'))?.modelKind, 'llm')
	assert.equal(
		routeAdapterDescriptor({ ...draft, requestOperation: '*' }, model('image')),
		null
	)
	assert.equal(
		routeAdapterDescriptor({ ...draft, adapter: 'unknown' }, model('image')),
		null
	)
	assert.equal(routeAdapterDescriptor(draft, undefined), null)
	const image = routeAdapterDescriptor(
		applyDashScopePreset(emptyRouteDraft, 'image-qwen'),
		model('image')
	)
	assert.deepEqual(image?.protectedUpstreamPaths, ['parameters.n'])
	assert.deepEqual(image?.extraBodyExample, {
		parameters: { negative_prompt: 'blurry', seed: 42 },
	})
	assert.ok(image?.lossyFeatures?.includes('background'))
	assert.equal(
		routeAdapterDescriptor(
			{
				...draft,
				requestProtocol: 'dashscope',
				requestOperation: 'audio.transcriptions',
				upstreamProtocol: 'dashscope',
				upstreamOperation: 'audio.transcriptions',
			},
			model('transcription')
		),
		null
	)
})

test('dependent choices reconcile together when model/provider modality changes', () => {
	const image = model('image')
	const draft = reconcileRouteDraft(
		{ ...emptyRouteDraft, modelId: image.id, providerId: provider.id },
		[image],
		[provider]
	)
	assert.equal(draft.requestOperation, 'images.generations')
	assert.equal(draft.upstreamOperation, 'images.generations')
	assert.equal(draft.adapter, 'passthrough')
	assert.equal(
		reconcileRouteDraft(
			draft,
			[image],
			[{ ...provider, endpointsState: 'redacted' }]
		).upstreamOperation,
		''
	)
})
