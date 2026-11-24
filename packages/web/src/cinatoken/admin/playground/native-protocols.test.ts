/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	imageBodyTemplateFor,
	parseImagesGenerationsResponse,
	safeImagePreviewSource,
} from './browser-domain/image-generations'
import { mergeAssistantTextParts } from './browser-domain/merge-assistant-text'
import {
	MAX_PREVIEW_TEXT_CHARS,
	miniMaxSpeechAudioBlob,
} from './browser-domain/native-media'
import {
	playgroundContextSchema,
	validatePlaygroundSearch,
} from './playground-contracts'
import {
	buildPlaygroundInput,
	playgroundRouteSupported,
	routeTemplate,
	needsAudioFile,
	PlaygroundInputFailure,
} from './playground-domain'
import { fixtureContext, fixtureRoute } from './playground-fixtures'
import { playgroundMessages } from './playground-messages'

const search = validatePlaygroundSearch({ routeId: 'r-text' })
function media(
	kind: 'image' | 'audio',
	protocol: string,
	operation: string,
	adapter = 'passthrough'
) {
	const context = fixtureContext()
	context.models[0].kind = kind
	return playgroundContextSchema.parse({
		...context,
		routes: [
			fixtureRoute({
				upstream_protocol: protocol as 'openai',
				upstream_operation: operation,
				adapter,
			}),
		],
	})
}
function envelope(
	context: ReturnType<typeof fixtureContext>,
	body = '{}',
	operation: 'generations' | 'edits' = 'generations'
) {
	return buildPlaygroundInput(
		context,
		search,
		body,
		operation,
		'generateContent',
		{},
		'file'
	)
}
test('MiniMax, Volcengine, and future protocol rows cannot invalidate the whole context', () => {
	const context = fixtureContext()
	const parsed = playgroundContextSchema.parse({
		...context,
		routes: [
			context.routes[0],
			fixtureRoute({ id: 'mini', upstream_protocol: 'minimax' }),
			fixtureRoute({ id: 'volc', upstream_protocol: 'volcengine' }),
			{
				...context.routes[0],
				id: 'future',
				upstream_protocol: 'future-provider',
			},
		],
	})
	assert.deepEqual(
		parsed.routes.map((route) => route.upstream_protocol),
		['openai', 'minimax', 'volcengine', 'unsupported']
	)
	assert.ok('routeId' in envelope(parsed))
	assert.throws(
		() =>
			buildPlaygroundInput(
				parsed,
				{ ...search, routeId: 'future' },
				'{}',
				'generations',
				'generateContent',
				{},
				'file'
			),
		(error) =>
			error instanceof PlaygroundInputFailure &&
			error.key === 'operationUnsupported'
	)
})
test('native and conversion image templates match the backend input boundary', () => {
	for (const [protocol, adapter, expected] of [
		['minimax', 'passthrough', 'aspect_ratio'],
		['volcengine', 'passthrough', 'sequential_image_generation'],
		['gemini', 'passthrough', 'contents'],
		['dashscope', 'passthrough', 'input'],
		['minimax', 'minimax-image', 'prompt'],
		['gemini', 'gemini-image', 'prompt'],
		['volcengine', 'volcengine-image', 'prompt'],
	] as const) {
		let operation = 'images.generations'
		if (protocol === 'gemini') operation = 'models.generate'
		else if (protocol === 'dashscope')
			operation = 'images.generations.multimodal'
		const context = media('image', protocol, operation, adapter)
		const template = routeTemplate(context, context.routes[0])
		assert.ok(expected in JSON.parse(template), `${protocol}/${adapter}`)
		assert.ok('routeId' in envelope(context, template))
		assert.throws(
			() => envelope(context, template, 'edits'),
			(error) =>
				error instanceof PlaygroundInputFailure &&
				error.key === 'operationUnsupported'
		)
	}
	const pro = JSON.parse(
		imageBodyTemplateFor({
			protocol: 'volcengine',
			providerModelName: 'seedream-5.0-pro',
		})
	)
	assert.equal(pro.size, '1K')
	const lite = JSON.parse(
		imageBodyTemplateFor({
			protocol: 'volcengine',
			providerModelName: 'seedream-5.0-lite',
		})
	)
	assert.equal(lite.size, '2K')
})
test('unknown adapters and mismatched native model kinds cannot silently fall through to Chat', () => {
	for (const [kind, protocol, operation, adapter] of [
		['audio', 'volcengine', 'audio.speech', 'passthrough'],
		['audio', 'dashscope', 'audio.transcriptions.multimodal', 'future-asr'],
		['image', 'minimax', 'audio.speech', 'passthrough'],
		['image', 'volcengine', 'images.generations', 'future-adapter'],
		['audio', 'minimax', 'audio.speech', 'minimax-image'],
		['image', 'anthropic', 'messages', 'passthrough'],
	] as const) {
		const context = media(kind, protocol, operation, adapter)
		assert.equal(playgroundRouteSupported(context.routes[0], kind), false)
		assert.throws(
			() => envelope(context),
			(error) =>
				error instanceof PlaygroundInputFailure &&
				error.key === 'operationUnsupported'
		)
	}
})
test('DashScope SpeechSynthesizer keeps native input objects separate from the OpenAI conversion template', () => {
	for (const adapter of ['passthrough', 'dashscope-tts-speech']) {
		const context = media('audio', 'dashscope', 'audio.speech', adapter)
		context.routes[0].provider_model_name = 'cosyvoice-v2'
		const body = JSON.parse(routeTemplate(context, context.routes[0]))
		assert.equal(playgroundRouteSupported(context.routes[0], 'audio'), true)
		assert.equal(needsAudioFile(context.routes[0]), false)
		if (adapter === 'passthrough') {
			assert.equal(typeof body.input.text, 'string')
			assert.equal(body.input.voice, 'longxiaochun_v2')
			assert.equal(body.input.format, 'wav')
			assert.equal(body.input.rate, 1)
			assert.equal(body.voice, undefined)
			assert.equal(body.response_format, undefined)
			assert.equal(body.speed, undefined)
		} else {
			assert.equal(typeof body.input, 'string')
			assert.equal(body.voice, 'longxiaochun_v2')
			assert.equal(body.response_format, 'wav')
			assert.equal(body.speed, 1)
		}
		const request = envelope(context, JSON.stringify(body))
		assert.ok('routeId' in request)
		assert.deepEqual(request.body, body)
	}
})
test('MiniMax speech uses native text/voice settings or OpenAI input/voice according to its adapter', () => {
	for (const adapter of ['passthrough', 'minimax-tts']) {
		const context = media('audio', 'minimax', 'audio.speech', adapter)
		const body = JSON.parse(routeTemplate(context, context.routes[0]))
		assert.equal(needsAudioFile(context.routes[0]), false)
		if (adapter === 'passthrough') {
			assert.equal(typeof body.text, 'string')
			assert.equal(typeof body.voice_setting.voice_id, 'string')
			assert.equal(body.stream, false)
			assert.equal(body.input, undefined)
		} else {
			assert.equal(typeof body.input, 'string')
			assert.equal(typeof body.voice, 'string')
			assert.equal(body.text, undefined)
		}
		assert.ok('routeId' in envelope(context, JSON.stringify(body)))
	}
	const asr = media('audio', 'minimax', 'audio.transcriptions')
	assert.equal(needsAudioFile(asr.routes[0]), true)
	assert.throws(
		() => envelope(asr),
		(error) =>
			error instanceof PlaygroundInputFailure &&
			error.key === 'audioFileRequired'
	)
	const asyncAsr = media('audio', 'dashscope', 'audio.transcriptions.async')
	assert.deepEqual(
		JSON.parse(routeTemplate(asyncAsr, asyncAsr.routes[0])).input.file_urls,
		['https://example.com/sample.wav']
	)
})
test('native image previews handle MiniMax URL/base64, DashScope, Gemini and Volcengine complete SSE events', () => {
	const native = [
		{
			data: {
				image_urls: ['https://images.test/mini.png'],
				image_base64: ['QUJDRA=='],
			},
		},
		{
			output: {
				choices: [
					{ message: { content: [{ image: 'https://images.test/dash.png' }] } },
				],
			},
		},
		{
			candidates: [
				{
					content: {
						parts: [
							{
								thought: true,
								inlineData: { mimeType: 'image/png', data: 'c2VjcmV0' },
							},
							{ inlineData: { mimeType: 'image/webp', data: 'QUJDRA==' } },
						],
					},
				},
			],
		},
	]
	assert.deepEqual(
		native.map(
			(body) => parseImagesGenerationsResponse(JSON.stringify(body)).count
		),
		[2, 1, 1]
	)
	const wire =
		'data: ' +
		JSON.stringify({
			type: 'image_generation.partial_succeeded',
			url: 'https://images.test/volc.png',
		}) +
		'\n\n'
	assert.equal(parseImagesGenerationsResponse(wire + wire).count, 1)
	assert.equal(
		parseImagesGenerationsResponse(
			JSON.stringify({
				data: {
					image_urls: [
						'javascript:alert(1)',
						'https://user:secret@images.test/private',
					],
				},
				debug: { url: 'https://images.test/unrelated' },
			})
		).count,
		0
	)
	assert.equal(
		safeImagePreviewSource('data:image/svg+xml;base64,QUJDRA=='),
		false
	)
})
test('MiniMax speech SSE aggregate audio is decoded once and invalid or error payloads remain raw only', async () => {
	const event = (body: unknown) => 'data: ' + JSON.stringify(body) + '\n\n'
	const audio = miniMaxSpeechAudioBlob(
		event({ data: { audio: '48', status: 1 } }) +
			event({
				data: { audio: '4869', status: 2 },
				extra_info: { audio_format: 'wav' },
			})
	)
	assert.equal(audio?.type, 'audio/wav')
	assert.equal(await audio?.text(), 'Hi')
	assert.equal(
		await miniMaxSpeechAudioBlob(
			event({ data: { audio: '48', status: 1 } }) +
				event({ data: { audio: '69', status: 1 } })
		)?.text(),
		'Hi'
	)
	assert.equal(
		miniMaxSpeechAudioBlob(
			event({ base_resp: { status_code: 1004 }, data: { audio: '4869' } })
		),
		null
	)
	assert.equal(miniMaxSpeechAudioBlob('{"data":{"audio":"oops"}}'), null)
	assert.deepEqual(
		mergeAssistantTextParts('{"text":"transcribed"}', 'minimax', 'json'),
		{ reasoning: '', body: 'transcribed' }
	)
})
test('unsupported route guidance is available in all four locales', () => {
	for (const messages of Object.values(playgroundMessages)) {
		assert.ok(messages.unsupportedRoute.length > 10)
		assert.ok(messages.nativeMediaHint.length > 10)
	}
})

test('preview helpers enforce source, text, item and incomplete-event bounds', () => {
	const tooLarge = 'A'.repeat(MAX_PREVIEW_TEXT_CHARS + 1)
	assert.equal(miniMaxSpeechAudioBlob(tooLarge), null)
	assert.equal(parseImagesGenerationsResponse(tooLarge).count, 0)
	assert.equal(
		safeImagePreviewSource('data:image/png;base64,' + tooLarge),
		false
	)
	assert.equal(
		safeImagePreviewSource('https://images.test/' + 'x'.repeat(16_384)),
		false
	)
	assert.equal(safeImagePreviewSource('file:///etc/passwd'), false)
	assert.equal(
		safeImagePreviewSource('data:text/html;base64,PHNjcmlwdD4='),
		false
	)
	assert.equal(safeImagePreviewSource('data:image/png;base64,QUJDRA=='), true)
	const rows = Array.from({ length: 101 }, (_, index) => ({
		url: `https://images.test/${index}.png`,
	}))
	assert.equal(
		parseImagesGenerationsResponse(JSON.stringify({ data: rows })).count,
		100
	)
	assert.equal(
		parseImagesGenerationsResponse(
			'data: {"data":[{"url":"https://images.test/pending.png"}]}'
		).count,
		0
	)
	assert.equal(
		miniMaxSpeechAudioBlob('data: {"data":{"audio":"4869","status":2}}'),
		null
	)
})
