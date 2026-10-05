/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
	buildSimulatorRequest,
	buildSimulatorDashScopeRealtimeUrl,
} from './endpoint'
import { simulatorContextSchema } from './simulator-contracts'
import { adminSimulatorMessages } from './simulator-messages'
import {
	simulatorResponseView,
	snapshotLogsHref,
	safeImageSource,
} from './simulator-response'
import { validateSimulatorSearch } from './simulator-search'
import {
	DEFAULT_SELECTION,
	isRealtimeSelection,
	parseSimulatorBody,
	reconcileSelection,
	selectionNeedsNewTemplate,
	selectionTemplate,
} from './simulator-selection'
import {
	filterMatchingActiveRoutes,
	listSupportedClientSurfaces,
	listDashScopeAudioClientOperations,
	redactHeaders,
	tryParseProxyBaseUrl,
} from './simulator-utils'
import type { SimulatorSnapshot } from './use-simulator'

const base = 'https://proxy.example.test'
const secret = 'sk-' + 'K'.repeat(32)
const rawModel = {
	id: 'chat-model',
	display_name: 'Chat',
	vendor: 'vendor',
	kind: 'llm',
	input_modalities: ['text'],
	output_modalities: ['text'],
}
const rawRoute = {
	id: 'route-1',
	model_id: 'chat-model',
	provider_id: 'provider-1',
	provider_name: 'Provider',
	provider_model_name: 'upstream-model',
	priority: 1,
	status: 'active',
	route_group: 'default',
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	adapter: 'passthrough',
	route_pool_id: null,
	pool_name: null,
	surfaces: [
		{
			id: 'surface-chat',
			request_protocol: 'openai',
			request_operation: 'chat',
			status: 'active',
		},
	],
}
function context(
	models: unknown[] = [rawModel],
	routes: unknown[] = [rawRoute]
) {
	return simulatorContextSchema.parse({
		success: true,
		data: {
			models,
			routes,
			billing_currency: null,
			realtime_supported: true,
			realtime_tts_supported: false,
			capabilities: { can_read_keys: true, can_read_logs: true },
			limits: {
				image_file_bytes: 20 * 1024 * 1024,
				image_count: 5,
				audio_file_bytes: 25 * 1024 * 1024,
			},
		},
	}).data
}
const input = {
	baseUrl: base,
	protocol: 'openai' as const,
	modelForRouting: 'chat-model:edge',
	body: { model: 'must-be-overwritten', messages: [] },
	apiKey: secret,
}
test('safe context validates array modalities and surfaces and strips unexpected provider credentials/config', () => {
	const safe = context(
		[{ ...rawModel, metadata: { password: secret } }],
		[
			{
				...rawRoute,
				endpoint: 'https://secret.example.test',
				api_key: secret,
				custom_params: '{"private":"value"}',
			},
		]
	)
	assert.equal(JSON.stringify(safe).includes(secret), false)
	assert.equal(JSON.stringify(safe).includes('custom_params'), false)
	assert.equal(JSON.parse(safe.routes[0].surfaces)[0].request_operation, 'chat')
})
test('active public surfaces bound protocols, operation buttons and matching candidate routes by group', () => {
	const routes = context(
		[rawModel],
		[
			{
				...rawRoute,
				surfaces: [
					...rawRoute.surfaces,
					{
						id: 'responses',
						request_protocol: 'openai',
						request_operation: 'responses',
						status: 'active',
					},
					{
						id: 'anthropic',
						request_protocol: 'anthropic',
						request_operation: 'messages',
						status: 'disabled',
					},
					{
						id: 'gemini',
						request_protocol: 'gemini',
						request_operation: 'generateContent',
						status: 'active',
					},
				],
			},
			{ ...rawRoute, id: 'edge-route', route_group: 'edge' },
			{ ...rawRoute, id: 'disabled-route', status: 'disabled' },
		]
	).routes
	const surfaces = listSupportedClientSurfaces(routes, rawModel.id, '')
	assert.deepEqual(surfaces.protocols, ['openai', 'gemini'])
	assert.deepEqual(surfaces.openaiLlmOperations, ['chat', 'responses'])
	assert.equal(surfaces.geminiActions.length, 2)
	assert.deepEqual(
		filterMatchingActiveRoutes(
			routes,
			rawModel.id,
			'',
			'gemini',
			'models.generate'
		).map((row) => row.id),
		['route-1']
	)
	assert.deepEqual(
		filterMatchingActiveRoutes(
			routes,
			rawModel.id,
			'edge',
			'openai',
			'chat'
		).map((row) => row.id),
		['edge-route']
	)
	assert.equal(
		filterMatchingActiveRoutes(routes, rawModel.id, '', 'anthropic', 'messages')
			.length,
		0
	)
})
test('legacy empty public surfaces retain a consistent upstream-protocol fallback', () => {
	const routes = context([rawModel], [{ ...rawRoute, surfaces: [] }]).routes
	assert.deepEqual(
		listSupportedClientSurfaces(routes, rawModel.id, '').protocols,
		['openai']
	)
	assert.equal(
		filterMatchingActiveRoutes(routes, rawModel.id, '', 'openai', 'chat')
			.length,
		1
	)
	assert.equal(
		filterMatchingActiveRoutes(routes, rawModel.id, '', 'anthropic', 'messages')
			.length,
		0
	)
})
test('OpenAI Chat/Responses and Anthropic requests overwrite selected routing model; Gemini changes path and SSE query', () => {
	assert.equal(buildSimulatorRequest(input).url, base + '/v1/chat/completions')
	assert.equal(
		JSON.parse(buildSimulatorRequest(input).bodyText).model,
		'chat-model:edge'
	)
	assert.equal(
		buildSimulatorRequest({ ...input, llmOperation: 'responses' }).url,
		base + '/v1/responses'
	)
	assert.equal(
		buildSimulatorRequest({ ...input, protocol: 'anthropic' }).url,
		base + '/v1/messages'
	)
	const stream = buildSimulatorRequest({
		...input,
		protocol: 'gemini',
		geminiAction: 'streamGenerateContent',
	})
	assert.equal(
		stream.url,
		base + '/v1beta/models/chat-model%3Aedge:streamGenerateContent?alt=sse'
	)
	assert.equal(JSON.parse(stream.bodyText).model, 'must-be-overwritten')
	assert.equal(
		new URL(
			buildSimulatorRequest({
				...input,
				protocol: 'gemini',
				geminiAction: 'generateContent',
			}).url
		).search,
		''
	)
})
test('image edits and transcription uploads produce multipart with real files and no synthetic Content-Type', () => {
	const image = new File([new Uint8Array([1, 2])], 'reference.png', {
		type: 'image/png',
	})
	const edits = buildSimulatorRequest({
		...input,
		kind: 'image',
		imageOperation: 'edits',
		editImages: [image],
		body: { prompt: 'Edit', n: 1 },
	})
	assert.equal(edits.url, base + '/v1/images/edits')
	assert.equal(edits.headers['Content-Type'], undefined)
	assert.equal(edits.formData?.get('model'), input.modelForRouting)
	assert.equal((edits.formData?.get('image') as File).name, 'reference.png')
	const audio = new File([new Uint8Array([3, 4])], 'audio.wav', {
		type: 'audio/wav',
	})
	const asr = buildSimulatorRequest({
		...input,
		kind: 'audio',
		audioOperation: 'transcriptions',
		audioFile: audio,
		body: { language: 'zh', temperature: 0, file_url: '' },
	})
	assert.equal(asr.url, base + '/v1/audio/transcriptions')
	assert.equal(asr.headers['Content-Type'], undefined)
	assert.equal(asr.formData?.get('temperature'), '0')
	assert.equal((asr.formData?.get('file') as File).name, 'audio.wav')
	const speech = buildSimulatorRequest({
		...input,
		kind: 'audio',
		audioOperation: 'speech',
		body: { input: 'hello', voice: 'alloy' },
	})
	assert.equal(speech.url, base + '/v1/audio/speech')
	assert.equal(speech.formData, undefined)
})
test('DashScope multimodal ASR uses HTTP while each realtime lifecycle uses an authenticated WS path', () => {
	const model = {
		...rawModel,
		id: 'asr',
		kind: 'audio',
		input_modalities: ['audio'],
		output_modalities: ['text'],
	}
	const route = {
		...rawRoute,
		model_id: 'asr',
		upstream_protocol: 'dashscope',
		upstream_operation: 'audio.transcriptions.multimodal',
		surfaces: [
			{
				id: 'http',
				request_protocol: 'dashscope',
				request_operation: 'audio.transcriptions.multimodal',
				status: 'active',
			},
			{
				id: 'inference',
				request_protocol: 'dashscope',
				request_operation: 'audio.transcriptions.realtime.inference',
				status: 'active',
			},
			{
				id: 'session',
				request_protocol: 'dashscope',
				request_operation: 'audio.transcriptions.realtime.session',
				status: 'active',
			},
		],
	}
	const safe = context([model], [route])
	const operations = listDashScopeAudioClientOperations(
		safe.routes,
		'asr',
		'',
		'transcriptions'
	)
	assert.deepEqual(operations, [
		'audio.transcriptions.multimodal',
		'audio.transcriptions.realtime.inference',
		'audio.transcriptions.realtime.session',
	])
	const selection = reconcileSelection(
		{
			...DEFAULT_SELECTION,
			kind: 'audio',
			modelId: 'asr',
			protocol: 'dashscope',
		},
		safe
	)
	assert.equal(selection.dashscopeOperation, 'audio.transcriptions.multimodal')
	assert.equal(isRealtimeSelection(selection), false)
	assert.equal(
		buildSimulatorRequest({
			...input,
			kind: 'audio',
			protocol: 'dashscope',
			dashscopeRequestOperation: selection.dashscopeOperation,
		}).url,
		base + '/v1/dashscope/services/aigc/multimodal-generation/generation'
	)
	const ws = new URL(
		buildSimulatorDashScopeRealtimeUrl({
			baseUrl: base,
			modelForRouting: 'asr:edge',
			operation: operations[1],
		})
	)
	assert.equal(ws.protocol, 'wss:')
	assert.equal(ws.searchParams.get('model'), 'asr:edge')
	assert.equal(ws.searchParams.has('key'), false)
})
test('all four tools use their registered true Proxy endpoint and template with no model override', () => {
	for (const toolId of [
		'web-search',
		'web-fetch',
		'web-deep-search',
		'ai-detection',
	] as const) {
		const selection = { ...DEFAULT_SELECTION, kind: 'tool' as const, toolId }
		const body = parseSimulatorBody(selectionTemplate(selection))!
		const result = buildSimulatorRequest({
			...input,
			kind: 'tool',
			toolId,
			body,
		})
		assert.equal(result.url, base + '/v1/tools/' + toolId)
		assert.deepEqual(JSON.parse(result.bodyText), body)
		assert.equal('model' in body, false)
	}
})
test('request-body edits survive LLM model/group/Gemini URL changes, while wire-format changes reset templates', () => {
	assert.equal(
		selectionNeedsNewTemplate(DEFAULT_SELECTION, {
			...DEFAULT_SELECTION,
			modelId: 'other',
			routeGroup: 'edge',
		}),
		false
	)
	assert.equal(
		selectionNeedsNewTemplate(
			{ ...DEFAULT_SELECTION, protocol: 'gemini' },
			{
				...DEFAULT_SELECTION,
				protocol: 'gemini',
				geminiAction: 'generateContent',
			}
		),
		false
	)
	assert.equal(
		selectionNeedsNewTemplate(DEFAULT_SELECTION, {
			...DEFAULT_SELECTION,
			llmOperation: 'responses',
		}),
		true
	)
	assert.equal(
		selectionNeedsNewTemplate(DEFAULT_SELECTION, {
			...DEFAULT_SELECTION,
			protocol: 'anthropic',
		}),
		true
	)
	assert.equal(parseSimulatorBody('[]'), null)
	assert.equal(parseSimulatorBody('null'), null)
	assert.deepEqual(parseSimulatorBody('{"stream":true}'), { stream: true })
})
test('safe audio operation preserves Core speech/transcription profile fallbacks without exposing pricing profiles', () => {
	const model = {
		...rawModel,
		id: 'speech-model',
		kind: 'audio',
		output_modalities: [],
		audio_operation: 'speech',
	}
	const route = {
		...rawRoute,
		model_id: model.id,
		upstream_operation: 'audio.speech',
		surfaces: [
			{
				id: 'speech',
				request_protocol: 'openai',
				request_operation: 'audio.speech',
				status: 'active',
			},
		],
	}
	const safe = context([model], [route])
	const selection = reconcileSelection(
		{ ...DEFAULT_SELECTION, kind: 'audio', modelId: model.id },
		safe
	)
	assert.equal(selection.audioOperation, 'speech')
	assert.match(selectionTemplate(selection, safe), /"voice"/)
	assert.equal(JSON.stringify(safe).includes('pricing_profile'), false)
	const legacy = context([{ ...model, audio_operation: undefined }], [route])
	assert.equal(
		reconcileSelection(
			{ ...DEFAULT_SELECTION, kind: 'audio', modelId: model.id },
			legacy
		).audioOperation,
		'speech'
	)
})
test('Proxy URLs reject credential-bearing URLs, query/fragment and unsupported schemes for both HTTP and WS builders', () => {
	for (const url of [
		'https://user:password@proxy.example.test',
		base + '?key=bad',
		base + '#fragment',
		'file:///tmp/proxy',
	]) {
		assert.equal(tryParseProxyBaseUrl(url).ok, false)
		assert.throws(() => buildSimulatorRequest({ ...input, baseUrl: url }))
		assert.throws(() =>
			buildSimulatorDashScopeRealtimeUrl({
				baseUrl: url,
				modelForRouting: 'model',
				operation: 'audio.transcriptions.realtime.inference',
			})
		)
	}
	assert.deepEqual(redactHeaders({ Authorization: 'Bearer ' + secret }), {
		Authorization: 'Bearer ***',
	})
})
const snapshot: SimulatorSnapshot = {
	keyId: 'key-1',
	ownerId: 'user-1',
	workspaceId: 'personal:user-1',
	proxy: base,
	selection: {
		...DEFAULT_SELECTION,
		modelId: 'sent-model',
		routeGroup: 'edge',
		llmOperation: 'responses',
	},
	requestBody: {},
	wire: {
		method: 'POST',
		url: base + '/v1/responses',
		headers: { Authorization: 'Bearer ***' },
		bodyText: '{}',
	},
}
test('response reasoning/body/usage and log links derive from the actual immutable send snapshot', () => {
	const raw =
		'data: {"choices":[{"delta":{"reasoning_content":"think","content":"hello"}}]}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}}\n\ndata: [DONE]\n\n'
	const view = simulatorResponseView({
		snapshot,
		raw,
		audio: null,
		meta: {
			status: 200,
			latencyMs: '12',
			contentType: 'text/event-stream',
			requestUrl: snapshot.wire.url,
			generationId: 'gen-1',
			outcome: 'complete',
		},
	})
	assert.equal(view.reasoning, 'think')
	assert.equal(view.body, 'hello')
	assert.match(view.usage ?? '', /total: 5/)
	const url = new URL(snapshotLogsHref(snapshot), 'https://admin.example.test')
	assert.equal(url.searchParams.get('api_key_id'), 'key-1')
	assert.equal(url.searchParams.get('model_id'), 'sent-model')
	assert.equal(url.searchParams.get('route_group'), 'edge')
	assert.equal(
		snapshotLogsHref({
			...snapshot,
			selection: {
				...snapshot.selection,
				kind: 'tool',
				toolId: 'ai-detection',
			},
		}),
		'/admin/tools/invocations?tool=ai-detection'
	)
})
test('image previews cannot activate javascript/SVG or credential-bearing URLs', () => {
	for (const src of [
		'javascript:alert(1)',
		'data:image/svg+xml;base64,abcd',
		'https://user:pass@images.example.test/a.png',
		'file:///image.png',
	])
		assert.equal(safeImageSource(src), false)
	assert.equal(safeImageSource('https://images.example.test/a.png'), true)
	assert.equal(safeImageSource('data:image/png;base64,YWJj'), true)
})
test('deep links reject secret/hash material and invalid protocol while accepting immutable safe selection', () => {
	assert.deepEqual(
		validateSimulatorSearch({
			kind: 'tool',
			tool: 'web-search',
			key_id: 'key-1',
		}),
		{ kind: 'tool', tool: 'web-search', key_id: 'key-1' }
	)
	for (const key_id of [
		secret,
		'sk-…',
		'hashref:sha256:' + 'a'.repeat(64),
		'sha256:' + 'a'.repeat(64),
	])
		assert.equal(validateSimulatorSearch({ key_id }).invalidTarget, true)
	assert.equal(
		validateSimulatorSearch({ protocol: 'unsupported' }).invalidTarget,
		true
	)
	assert.equal(
		validateSimulatorSearch({ model_id: 'line\nbreak' }).invalidTarget,
		true
	)
})
function leafKeys(value: object, prefix = ''): string[] {
	return Object.entries(value)
		.flatMap(([key, entry]) =>
			typeof entry === 'string'
				? [prefix + key]
				: leafKeys(entry as object, prefix + key + '.')
		)
		.sort()
}
test('all four language resources contain the same full key tree and every static Screen copy key exists', () => {
	const baseline = leafKeys(adminSimulatorMessages.en)
	for (const locale of ['zh', 'ja', 'ko'] as const)
		assert.deepEqual(leafKeys(adminSimulatorMessages[locale]), baseline)
	for (const file of [
		'SimulatorScreen.tsx',
		'SimulatorSetup.tsx',
		'SimulatorRouting.tsx',
		'SimulatorRequest.tsx',
		'SimulatorResponse.tsx',
		'use-simulator.ts',
	]) {
		const source = readFileSync(new URL(file, import.meta.url), 'utf8')
		for (const match of source.matchAll(
			/['"]cinatoken\.adminSimulator\.([A-Za-z0-9_.]+)['"]/g
		))
			if (!match[1].endsWith('.'))
				assert.ok(baseline.includes(match[1]), file + ': ' + match[1])
	}
})
