/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { SimulatorProtocol } from '../playground/browser-domain/invoke-kind'
import { buildSimulatorRequest, buildSimulatorTaskQuery } from './endpoint'
import { extractSimulatorAsyncTask } from './simulator-async-task'
import {
	simulatorContextSchema,
	type SimulatorContext,
} from './simulator-contracts'
import { adminSimulatorMessages } from './simulator-messages'
import {
	dashScopeSpeechPreview,
	safeAudioPreviewUrl,
} from './simulator-native-audio'
import {
	DEFAULT_SELECTION,
	initialSelection,
	isRealtimeSelection,
	needsSimulatorAudioFile,
	reconcileSelection,
	requestOperation,
	selectionTemplate,
	supportedSelection,
} from './simulator-selection'
import { executeSimulatorHttp } from './simulator-transport'
import {
	filterMatchingActiveRoutes,
	listSupportedClientSurfaces,
	listDashScopeAudioClientOperations,
	redactHeaders,
} from './simulator-utils'

const base = 'https://proxy.example.test'
const secret = 'sk-testSecret'
const token = 'opaque_payload.opaque_signature'
function catalog(
	kind: 'llm' | 'image' | 'audio',
	protocol: string,
	operation: string,
	adapter = 'passthrough',
	requestProtocol = protocol,
	requestOperation = operation
): SimulatorContext {
	return simulatorContextSchema.parse({
		success: true,
		data: {
			models: [
				{
					id: 'model',
					display_name: 'Model',
					vendor: 'Vendor',
					kind,
					audio_operation: operation.startsWith('audio.speech')
						? 'speech'
						: null,
					input_modalities: ['text'],
					output_modalities: [kind === 'image' ? 'image' : 'text'],
				},
			],
			routes: [
				{
					id: 'route',
					model_id: 'model',
					provider_id: 'provider',
					provider_name: 'Provider',
					provider_model_name: 'seedream-5.0-lite',
					status: 'active',
					priority: 1,
					route_group: 'default',
					upstream_protocol: protocol,
					upstream_operation: operation,
					adapter,
					surfaces: [
						{
							id: 'surface',
							request_protocol: requestProtocol,
							request_operation: requestOperation,
							status: 'active',
						},
					],
				},
			],
			billing_currency: 'CNY',
			realtime_supported: true,
			realtime_tts_supported: false,
			capabilities: { can_read_keys: true, can_read_logs: true },
			limits: {
				image_file_bytes: 20971520,
				image_count: 5,
				audio_file_bytes: 26214400,
			},
		},
	}).data
}

test('a mixed six-protocol and future catalog keeps existing routes usable', () => {
	const context = catalog('llm', 'openai', 'chat')
	const raw = {
		success: true,
		data: {
			...context,
			routes: context.routes.map((route) => ({
				...route,
				surfaces: JSON.parse(route.surfaces),
			})),
		},
	}
	for (const protocol of ['minimax', 'volcengine', 'future-protocol'])
		raw.data.routes.push({
			...raw.data.routes[0],
			id: protocol,
			surfaces: [
				{
					id: protocol,
					request_protocol: protocol,
					request_operation: 'images.generations',
					status: 'active',
				},
			],
		})
	const safe = simulatorContextSchema.parse(raw).data
	assert.equal(safe.routes.length, 4)
	assert.deepEqual(
		listSupportedClientSurfaces(safe.routes, 'model', '', 'llm').protocols,
		['openai']
	)
	assert.equal(
		filterMatchingActiveRoutes(
			safe.routes,
			'model',
			'',
			'future-protocol',
			'images.generations',
			'image'
		).length,
		0
	)
	assert.equal(initialSelection({ protocol: 'minimax' }).protocol, 'minimax')
})

const imagePaths: Array<[SimulatorProtocol, string, string]> = [
	['openai', 'images.generations', '/v1/images/generations'],
	['gemini', 'models.generate', '/v1beta/models/model%3Aedge:generateContent'],
	[
		'dashscope',
		'images.generations.multimodal',
		'/v1/dashscope/services/aigc/multimodal-generation/generation',
	],
	['minimax', 'images.generations', '/v1/minimax/image_generation'],
	['volcengine', 'images.generations', '/v1/volcengine/images/generations'],
]
for (const [protocol, operation, path] of imagePaths)
	test(`${protocol} image selection, template, candidates and exact Proxy wire path agree`, () => {
		const context = catalog('image', protocol, operation)
		const selection = reconcileSelection(
			{
				...DEFAULT_SELECTION,
				kind: 'image',
				modelId: 'model',
				protocol,
				imageOperation: 'edits',
			},
			context
		)
		assert.equal(selection.protocol, protocol)
		assert.equal(selection.imageOperation, 'generations')
		assert.equal(requestOperation(selection), operation)
		assert.equal(supportedSelection(selection), true)
		assert.equal(
			filterMatchingActiveRoutes(
				context.routes,
				'model',
				'',
				protocol,
				operation,
				'image'
			).length,
			1
		)
		assert.deepEqual(
			listSupportedClientSurfaces(
				context.routes,
				'model',
				'',
				'image',
				protocol
			).imageOperations,
			['generations']
		)
		const body = JSON.parse(selectionTemplate(selection, context))
		if (protocol === 'gemini') assert.ok(body.contents)
		if (protocol === 'dashscope') assert.ok(body.input.messages)
		if (protocol === 'minimax') assert.ok(body.aspect_ratio)
		if (protocol === 'volcengine') assert.equal(body.size, '2K')
		const request = buildSimulatorRequest({
			baseUrl: base,
			kind: 'image',
			protocol,
			modelForRouting: 'model:edge',
			body,
			apiKey: secret,
			imageOperation: 'generations',
			geminiAction: 'streamGenerateContent',
		})
		assert.equal(request.url, base + path)
		assert.equal(request.formData, undefined)
		if (protocol !== 'gemini')
			assert.equal(JSON.parse(request.bodyText).model, 'model:edge')
		if (protocol !== 'openai')
			assert.throws(() =>
				buildSimulatorRequest({
					baseUrl: base,
					kind: 'image',
					protocol,
					modelForRouting: 'model',
					body,
					apiKey: secret,
					imageOperation: 'edits',
				})
			)
	})

test('MiniMax native ASR preserves file and scalar form fields without exposing synthetic multipart Content-Type', () => {
	const file = new File([new Uint8Array([1, 2, 3])], 'sample.wav', {
		type: 'audio/wav',
	})
	const context = catalog('audio', 'minimax', 'audio.transcriptions')
	const selection = reconcileSelection(
		{
			...DEFAULT_SELECTION,
			kind: 'audio',
			modelId: 'model',
			protocol: 'minimax',
		},
		context
	)
	assert.equal(needsSimulatorAudioFile(selection, {}), true)
	const request = buildSimulatorRequest({
		baseUrl: base,
		kind: 'audio',
		protocol: 'minimax',
		modelForRouting: 'model',
		audioOperation: 'transcriptions',
		audioFile: file,
		apiKey: secret,
		body: {
			language: 'zh',
			timestamp_level: 'sentence',
			enable_itn: true,
			temperature: 0,
		},
	})
	assert.equal(request.url, base + '/v1/minimax/speech_to_text')
	assert.equal(request.headers['Content-Type'], undefined)
	assert.equal((request.formData?.get('file') as File).name, 'sample.wav')
	assert.equal(request.formData?.get('enable_itn'), 'true')
	assert.equal(request.formData?.get('temperature'), '0')
	assert.equal(request.formData?.get('timestamp_level'), 'sentence')
})

test('MiniMax native and OpenAI conversion speech each receive the right body shape and voice', () => {
	for (const adapter of ['passthrough', 'minimax-tts']) {
		const protocol = adapter === 'passthrough' ? 'minimax' : 'openai'
		const context = catalog(
			'audio',
			'minimax',
			'audio.speech',
			adapter,
			protocol,
			'audio.speech'
		)
		const selection = reconcileSelection(
			{ ...DEFAULT_SELECTION, kind: 'audio', modelId: 'model', protocol },
			context
		)
		const body = JSON.parse(selectionTemplate(selection, context))
		if (protocol === 'minimax') {
			assert.equal(typeof body.text, 'string')
			assert.equal(body.voice_setting.voice_id, 'male-qn-qingse')
		} else {
			assert.equal(typeof body.input, 'string')
			assert.equal(body.voice, 'male-qn-qingse')
		}
		const request = buildSimulatorRequest({
			baseUrl: base,
			kind: 'audio',
			protocol,
			modelForRouting: 'model',
			audioOperation: 'speech',
			body,
			apiKey: secret,
		})
		assert.equal(
			request.url,
			base +
				(protocol === 'minimax' ? '/v1/minimax/t2a_v2' : '/v1/audio/speech')
		)
	}
})

for (const operation of [
	'audio.transcriptions.multimodal',
	'audio.transcriptions.async',
	'audio.speech',
	'audio.speech.stream',
	'audio.speech.multimodal',
]) {
	test(`DashScope ${operation} remains HTTP with native fields and exact headers`, () => {
		const context = catalog('audio', 'dashscope', operation)
		const selection = reconcileSelection(
			{
				...DEFAULT_SELECTION,
				kind: 'audio',
				modelId: 'model',
				protocol: 'dashscope',
			},
			context
		)
		assert.equal(selection.dashscopeOperation, operation)
		assert.equal(isRealtimeSelection(selection), false)
		assert.equal(needsSimulatorAudioFile(selection, {}), false)
		assert.deepEqual(
			listDashScopeAudioClientOperations(
				context.routes,
				'model',
				'',
				selection.audioOperation
			),
			[operation]
		)
		const body = JSON.parse(selectionTemplate(selection, context))
		if (operation === 'audio.transcriptions.async')
			assert.ok(body.input.file_urls)
		if (operation.startsWith('audio.speech'))
			assert.equal(typeof body.input.text, 'string')
		const request = buildSimulatorRequest({
			baseUrl: base,
			kind: 'audio',
			protocol: 'dashscope',
			modelForRouting: 'model',
			audioOperation: selection.audioOperation,
			dashscopeRequestOperation: operation,
			body,
			apiKey: secret,
		})
		let path = '/v1/dashscope/services/aigc/multimodal-generation/generation'
		if (operation === 'audio.transcriptions.async')
			path = '/v1/dashscope/services/audio/asr/transcription'
		if (operation === 'audio.speech' || operation === 'audio.speech.stream')
			path = '/v1/dashscope/services/audio/tts/SpeechSynthesizer'
		assert.equal(request.url, base + path)
		assert.equal(request.formData, undefined)
		assert.equal(request.headers['Content-Type'], 'application/json')
		assert.equal(JSON.parse(request.bodyText).model, 'model')
		assert.equal(
			request.headers['X-DashScope-SSE'],
			operation === 'audio.speech.stream' ? 'enable' : undefined
		)
		assert.equal(
			request.headers['X-DashScope-Async'],
			operation === 'audio.transcriptions.async' ? 'enable' : undefined
		)
	})
}

test('unsupported protocol/kind/operation/adapter cannot become a billable fallback request', () => {
	for (const [kind, protocol] of [
		['llm', 'minimax'],
		['audio', 'volcengine'],
		['image', 'anthropic'],
	] as const) {
		assert.throws(() =>
			buildSimulatorRequest({
				baseUrl: base,
				kind,
				protocol,
				modelForRouting: 'model',
				body: {},
				apiKey: secret,
			})
		)
	}
	const context = catalog(
		'image',
		'minimax',
		'images.generations',
		'future-adapter'
	)
	assert.deepEqual(
		listSupportedClientSurfaces(context.routes, 'model', '', 'image', 'minimax')
			.protocols,
		[]
	)
	assert.equal(
		filterMatchingActiveRoutes(
			context.routes,
			'model',
			'',
			'minimax',
			'images.generations',
			'image'
		).length,
		0
	)
	const legacy = catalog('audio', 'dashscope', 'audio.transcriptions.async')
	legacy.routes[0].surfaces = '[]'
	assert.deepEqual(
		listDashScopeAudioClientOperations(
			legacy.routes,
			'model',
			'',
			'transcriptions'
		),
		['audio.transcriptions.async']
	)
	assert.throws(() =>
		buildSimulatorRequest({
			baseUrl: base,
			kind: 'audio',
			protocol: 'dashscope',
			modelForRouting: 'model',
			audioOperation: 'transcriptions',
			dashscopeRequestOperation: 'future-operation',
			body: {},
			apiKey: secret,
		})
	)
})

test('DashScope URL/base64 audio previews validate schemes, credentials, MIME and complete SSE boundaries', async () => {
	assert.equal(safeAudioPreviewUrl('javascript:alert(1)'), null)
	assert.equal(safeAudioPreviewUrl('https://user:pass@audio.test/a.wav'), null)
	assert.equal(
		safeAudioPreviewUrl('https://audio.test/' + 'x'.repeat(16384)),
		null
	)
	const preview = dashScopeSpeechPreview(
		'data: {"output":{"audio":{"data":"SGk="}}}\n\n',
		{ input: { format: 'wav' } }
	)
	assert.equal(preview.audio?.type, 'audio/wav')
	assert.equal(await preview.audio?.text(), 'Hi')
	assert.equal(
		dashScopeSpeechPreview('data: {"output":{"audio":{"data":"SGk="}}}', {})
			.audio,
		null
	)
	assert.equal(
		dashScopeSpeechPreview(
			'{"output":{"audio":{"url":"https://audio.test/speech.wav"}}}',
			{}
		).url,
		'https://audio.test/speech.wav'
	)
	assert.equal(
		dashScopeSpeechPreview('{"output":{"audio":{"data":"<svg/>"}}}', {}).audio,
		null
	)
	const deltas =
		'data: {"output":{"audio":{"data":"SA=="}}}\n\ndata: {"output":{"audio":{"data":"aQ=="}}}\n\n'
	assert.equal(
		await dashScopeSpeechPreview(deltas, {
			input: { format: 'wav' },
		}).audio?.text(),
		'Hi'
	)
})

test('async submission captures a private receipt once and excludes it from progress and displayed raw', async () => {
	let calls = 0
	const progress: string[] = []
	const request = buildSimulatorRequest({
		baseUrl: base,
		kind: 'audio',
		protocol: 'dashscope',
		modelForRouting: 'model',
		audioOperation: 'transcriptions',
		dashscopeRequestOperation: 'audio.transcriptions.async',
		body: { input: { file_urls: ['https://audio.test/a.wav'] } },
		apiKey: secret,
	})
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		captureAsyncTask: true,
		onProgress: (value) => progress.push(value.raw),
		fetch: async (_url, init) => {
			calls++
			assert.equal(init?.method, 'POST')
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			return Response.json({
				output: { task_id: 'task-1', task_status: 'PENDING' },
				gateway_task_receipt: token,
			})
		},
	})
	assert.equal(calls, 1)
	assert.deepEqual(result.task, { id: 'task-1', receipt: token })
	assert.ok(!result.raw.includes(token))
	assert.ok(!result.raw.includes('gateway_task_receipt'))
	assert.ok(progress.every((value) => !value.includes(token)))
	assert.equal(result.meta.outcome, 'complete')
	const invalidTask = extractSimulatorAsyncTask(
		JSON.stringify({
			output: { task_id: '../bad' },
			gateway_task_receipt: token,
		})
	)
	assert.equal(invalidTask.task, undefined)
	assert.ok(!invalidTask.raw.includes(token))
})

test('manual task queries send one GET with receipt in a header and no body, cookies or retry', async () => {
	const request = buildSimulatorTaskQuery({
		baseUrl: base,
		taskId: 'task-1',
		modelForRouting: 'model:edge',
		receipt: token,
		apiKey: secret,
	})
	assert.equal(
		request.url,
		base + '/v1/dashscope/tasks/task-1?model=model%3Aedge'
	)
	assert.equal(request.url.includes(token), false)
	assert.equal(
		redactHeaders(request.headers)['X-CinaToken-Task-Receipt'],
		'***'
	)
	let calls = 0
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: () => undefined,
		fetch: async (url, init) => {
			calls++
			assert.equal(url, request.url)
			assert.equal(init?.method, 'GET')
			assert.equal(init?.body, undefined)
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.equal(
				new Headers(init?.headers).get('X-CinaToken-Task-Receipt'),
				token
			)
			return Response.json(
				{ output: { task_status: 'SUCCEEDED' }, echo: token },
				{
					headers: {
						'X-CinaToken-Request-Id': 'gen-original',
						'X-CinaToken-Settlement-Basis': 'reserved',
					},
				}
			)
		},
	})
	assert.equal(calls, 1)
	assert.equal(result.meta.generationId, 'gen-original')
	assert.equal(result.meta.settlementBasis, 'reserved')
	assert.ok(!result.raw.includes(token))
	assert.throws(() =>
		buildSimulatorTaskQuery({
			baseUrl: base,
			taskId: '../other',
			modelForRouting: 'model',
			receipt: token,
			apiKey: secret,
		})
	)
})

test('native guidance and manual query copy exist in all four locales', () => {
	for (const messages of Object.values(adminSimulatorMessages)) {
		assert.ok(messages.nativeHttpHint)
		assert.ok(messages.asyncTaskHint)
		assert.ok(messages.queryTask)
	}
})

test('native provider errors and failed jobs remain failures even with HTTP 200', async () => {
	for (const body of [
		{ base_resp: { status_code: 1004, status_msg: 'denied' } },
		{ code: 'InvalidParameter', message: 'bad input' },
		{ output: { task_status: 'FAILED' } },
	]) {
		const result = await executeSimulatorHttp({
			request: buildSimulatorRequest({
				baseUrl: base,
				kind: 'audio',
				protocol: 'minimax',
				audioOperation: 'speech',
				modelForRouting: 'model',
				body: { text: 'hello' },
				apiKey: secret,
			}),
			secret,
			signal: new AbortController().signal,
			onProgress: () => undefined,
			fetch: async () => Response.json(body),
		})
		assert.equal(result.meta.outcome, 'failed')
	}
})
