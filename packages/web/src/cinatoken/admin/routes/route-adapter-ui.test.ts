/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { adminModelSchema } from '../model-contracts'
import { RouteAdapterPreview } from './RouteAdapterPreview'
import { routeMessages } from './messages'
import { emptyRouteDraft, type RouteDraft } from './route-domain'
import { applyDashScopePreset } from './route-options'

function model(modality: string) {
	return adminModelSchema.parse({
		id: 'catalog/model',
		display_name: 'Model',
		vendor: 'other',
		context_window: null,
		max_tokens: null,
		pricing_profile: null,
		input_modalities: '["text"]',
		output_modalities: JSON.stringify([modality]),
		released_at: null,
		description: null,
		metadata: null,
		route_policy: null,
		created_at: '2026-10-16T00:00:00Z',
		routes_count: 0,
		active_routes_count: 0,
		tags: [],
	})
}
async function render(
	locale: keyof typeof routeMessages,
	draft: RouteDraft,
	modality: string
) {
	const i18n = createInstance()
	await i18n.init({
		lng: locale,
		interpolation: { escapeValue: false },
		resources: {
			[locale]: {
				translation: { cinatoken: { adminRoutes: routeMessages[locale] } },
			},
		},
	})
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(RouteAdapterPreview, { draft, model: model(modality) })
		)
	)
}

test('image adapter guide exposes supported extra_body structure and managed fields in all four languages', async () => {
	const draft = applyDashScopePreset(
		{ ...emptyRouteDraft, providerModelName: 'qwen-image-plus' },
		'image-qwen'
	)
	for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
		const html = await render(locale, draft, 'image')
		for (const key of [
			'adapterGuide',
			'adapterGuideProtected',
			'adapterGuideProtectedHint',
			'adapterGuideUnsupported',
			'adapterGuideExample',
			'adapterGuideCopy',
		] as const)
			assert.ok(html.includes(routeMessages[locale][key]!))
		for (const text of [
			'parameters.n',
			'negative_prompt',
			'background',
			'/v1/images/generations',
		])
			assert.ok(html.includes(text))
		assert.equal(html.includes('cinatoken.adminRoutes.'), false)
		assert.equal(
			html.includes(routeMessages[locale].adapterGuideModelMismatch!),
			false
		)
	}
})

test('native task guidance differs from the OpenAI conversion that waits for upstream completion', async () => {
	const converted = await render(
		'en',
		applyDashScopePreset(emptyRouteDraft, 'filetrans'),
		'transcription'
	)
	assert.ok(converted.includes(routeMessages.en.adapterGuideConvertedTask!))
	assert.equal(converted.includes('/v1/dashscope/tasks/'), false)
	const native = await render(
		'en',
		{
			...emptyRouteDraft,
			requestProtocol: 'dashscope',
			requestOperation: 'audio.transcriptions.async',
			modelId: 'public/model name',
			upstreamProtocol: 'dashscope',
			upstreamOperation: 'audio.transcriptions.async',
			adapter: 'passthrough',
		},
		'transcription'
	)
	assert.ok(
		native.includes(
			'GET /dashscope/api/v1/tasks/:taskId?model=public%2Fmodel%20name'
		)
	)
	assert.ok(native.includes('same Gateway Key'))
	assert.equal(
		native.includes(routeMessages.en.adapterGuideConvertedTask!),
		false
	)
})

test('WebSocket guide uses catalog model ID and selected operation while unknown adapters expose no guessed guide', async () => {
	const draft = {
		...emptyRouteDraft,
		modelId: 'public/model name',
		providerModelName: 'qwen3-tts-realtime',
		requestProtocol: 'dashscope',
		requestOperation: 'audio.speech.realtime.session',
		upstreamProtocol: 'dashscope',
		upstreamOperation: 'audio.speech.realtime.session',
		adapter: 'passthrough',
	}
	const html = await render('en', draft, 'speech')
	assert.ok(
		html.includes('/dashscope/api-ws/v1/realtime?model=public%2Fmodel%20name')
	)
	assert.ok(html.includes('audio.speech.realtime.session'))
	assert.equal(
		await render('en', { ...draft, adapter: 'future-adapter' }, 'speech'),
		''
	)
})
