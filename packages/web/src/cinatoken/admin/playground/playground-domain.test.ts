/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeAssistantTextParts } from './browser-domain/merge-assistant-text'
import { buildPlaygroundSubjectProtocols } from './browser-domain/playground-subject'
import { RunOwner } from './browser-domain/run-owner'
import {
	playgroundContextSchema,
	validatePlaygroundSearch,
} from './playground-contracts'
import {
	bodyIsDirty,
	buildPlaygroundInput,
	llmFamily,
	needsAudioFile,
	PlaygroundInputFailure,
	routeTemplate,
} from './playground-domain'
import { fixtureContext, fixtureRoute } from './playground-fixtures'
import { playgroundMessages } from './playground-messages'

const search = validatePlaygroundSearch({ routeId: 'r-text' })
function rejectKey(operation: () => unknown, key: string) {
	assert.throws(
		operation,
		(error) => error instanceof PlaygroundInputFailure && error.key === key
	)
}
test('explicit routes mode wins over its default tool field; legacy tool deep link stays supported', () => {
	assert.equal(
		validatePlaygroundSearch({ ...search, tool: 'ai-detection' }).mode,
		'routes'
	)
	assert.equal(
		validatePlaygroundSearch({ tool: 'web-fetch', provider: 'jina' }).mode,
		'tools'
	)
	assert.equal(validatePlaygroundSearch({ routeId: 'bad\nvalue' }).routeId, '')
})
test('context schema strips provider secrets and accepts missing currency without inventing USD', () => {
	const context = fixtureContext()
	const checked = playgroundContextSchema.parse({
		...context,
		providers: [
			{ ...context.providers[0], api_key: 'private', base_url: 'private' },
		],
		raw_config: 'private',
	})
	assert.equal(checked.billing_currency, null)
	assert.equal(JSON.stringify(checked).includes('private'), false)
	assert.equal(checked.tools.flatMap((row) => row.providers).length, 10)
})
test('dirty comparison preserves whitespace inside user prompt strings', () => {
	assert.equal(bodyIsDirty('{ "text": "a  b" }', '{"text":"a b"}'), true)
	assert.equal(bodyIsDirty('{\n"text":"a"\n}', '{"text":"a"}'), false)
})
test('inactive route remains executable while unsupported operations do not silently become Chat', () => {
	const context = fixtureContext()
	assert.equal(
		'routeId' in
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'generations',
				'generateContent',
				{},
				'file'
			),
		true
	)
	context.routes[0] = fixtureRoute({ upstream_operation: 'embeddings' })
	assert.equal(llmFamily(context.routes[0]), null)
	rejectKey(
		() =>
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'generations',
				'generateContent',
				{},
				'file'
			),
		'operationUnsupported'
	)
})
test('image upload validates runtime total independently of per-file size; preview allows missing images', () => {
	const context = fixtureContext()
	context.models[0].kind = 'image'
	context.routes[0].upstream_operation = 'images.edits'
	const file = (size: number) =>
		({ name: 'reference.png', type: 'image/png', size }) as File
	rejectKey(
		() =>
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'edits',
				'generateContent',
				{},
				'file'
			),
		'referenceImagesRequired'
	)
	assert.ok(
		buildPlaygroundInput(
			context,
			search,
			'{}',
			'edits',
			'generateContent',
			{},
			'file',
			true
		)
	)
	context.limits.runtime = 'cloudflare'
	context.limits.image_total_bytes = 32 * 1024 * 1024
	context.limits.multipart_body_bytes = 36 * 1024 * 1024
	rejectKey(
		() =>
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'edits',
				'generateContent',
				{ images: [file(20 * 1024 * 1024), file(13 * 1024 * 1024)] },
				'file'
			),
		'uploadsTooLarge'
	)
	assert.ok(
		buildPlaygroundInput(
			context,
			search,
			'{}',
			'edits',
			'generateContent',
			{ images: [file(16 * 1024 * 1024), file(16 * 1024 * 1024)] },
			'file'
		)
	)
	rejectKey(
		() =>
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'edits',
				'generateContent',
				{ images: [{ ...file(1), type: 'image/svg+xml' } as File] },
				'file'
			),
		'fileInvalid'
	)
})
test('audio HTTP, async and realtime templates remain distinct; Node realtime is truthful', () => {
	const context = fixtureContext()
	context.models[0].kind = 'audio'
	context.routes[0] = fixtureRoute({
		upstream_protocol: 'dashscope',
		upstream_operation: 'audio.transcriptions.async',
		adapter: 'dashscope-asr-file-async',
	})
	assert.ok(routeTemplate(context, context.routes[0]).includes('file_url'))
	context.routes[0].upstream_operation = 'audio.transcriptions.multimodal'
	context.routes[0].adapter = 'passthrough'
	assert.ok(routeTemplate(context, context.routes[0]).includes('messages'))
	assert.equal(needsAudioFile(context.routes[0]), false)
	context.routes[0].adapter = 'dashscope-asr-fun-file'
	assert.equal(needsAudioFile(context.routes[0]), true)
	assert.ok(
		routeTemplate(context, context.routes[0]).includes('response_format')
	)
	context.routes[0].adapter = 'passthrough'
	context.routes[0].upstream_operation = 'audio.transcriptions.realtime.session'
	assert.equal(needsAudioFile(context.routes[0]), true)
	assert.equal(
		JSON.parse(routeTemplate(context, context.routes[0])).type,
		'session.update'
	)
	context.realtime_supported = false
	rejectKey(
		() =>
			buildPlaygroundInput(
				context,
				search,
				'{}',
				'generations',
				'generateContent',
				{},
				'microphone'
			),
		'realtimeUnavailable'
	)
})
test('tool requests cannot upload files; all four engine families retain raw envelope behavior', () => {
	const context = fixtureContext()
	for (const tool of context.tools)
		for (const provider of tool.providers) {
			const selection = validatePlaygroundSearch({
				mode: 'tools',
				tool: tool.toolId,
				provider: provider.provider,
			})
			assert.ok(
				'toolId' in
					buildPlaygroundInput(
						context,
						selection,
						'{}',
						'generations',
						'generateContent',
						{},
						'file'
					)
			)
			rejectKey(
				() =>
					buildPlaygroundInput(
						context,
						selection,
						'{}',
						'generations',
						'generateContent',
						{ audio: {} as File },
						'file'
					),
				'fileInvalid'
			)
		}
})
test('reasoning and body merge correctly for all four upstream protocols', () => {
	const samples = [
		{
			protocol: 'openai' as const,
			value: {
				choices: [
					{ message: { reasoning_content: 'think', content: 'answer' } },
				],
			},
		},
		{
			protocol: 'anthropic' as const,
			value: {
				content: [
					{ type: 'thinking', thinking: 'think' },
					{ type: 'text', text: 'answer' },
				],
			},
		},
		{
			protocol: 'gemini' as const,
			value: {
				candidates: [
					{
						content: {
							parts: [{ thought: true, text: 'think' }, { text: 'answer' }],
						},
					},
				],
			},
		},
		{ protocol: 'dashscope' as const, value: { output: { text: 'answer' } } },
	]
	for (const sample of samples) {
		const parts = mergeAssistantTextParts(
			JSON.stringify(sample.value),
			sample.protocol,
			'json'
		)
		assert.equal(parts.body, 'answer')
		if (sample.protocol !== 'dashscope') assert.equal(parts.reasoning, 'think')
	}
})
test('new run revokes old generation before transport disposal; stale completion cannot close the new run', () => {
	const owner = new RunOwner(),
		first = owner.start()
	let released = 0
	first.cleanups.add(() => {
		assert.equal(owner.owns(first), false)
		released++
	})
	const second = owner.start()
	assert.equal(released, 1)
	assert.equal(first.controller.signal.aborted, true)
	owner.finish(first)
	assert.equal(owner.owns(second), true)
	owner.cancel()
	owner.cancel()
	assert.equal(second.controller.signal.aborted, true)
})
test('WS subject is canonical subprotocol metadata rather than URL content', () => {
	const subject = '用户@example.com'
	const protocols = buildPlaygroundSubjectProtocols(subject)
	assert.equal(protocols[0], 'cinatoken-playground')
	assert.match(protocols[1], /^cinatoken-playground-subject\.[A-Za-z0-9_-]+$/)
	const decoded = Buffer.from(
		protocols[1].split('.')[1],
		'base64url'
	).toString()
	assert.equal(decoded, encodeURIComponent(subject))
})
test('all four message namespaces retain identical legacy keys and i18next interpolation', () => {
	const keys = Object.keys(playgroundMessages.en).sort()
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(playgroundMessages[locale]).sort(), keys)
		assert.ok(playgroundMessages[locale].subtitle.includes('{{product}}'))
		assert.equal(Object.keys(playgroundMessages[locale].placeholders).length, 4)
	}
	assert.ok(keys.length >= 200)
})
test('DashScope synchronous ASR validates encoded data URL size while native OpenAI retains its binary limit', () => {
	const context = fixtureContext()
	context.models[0].kind = 'audio'
	context.routes[0] = fixtureRoute({
		upstream_protocol: 'dashscope',
		upstream_operation: 'audio.transcriptions.multimodal',
		adapter: 'openai-audio-transcriptions-to-dashscope-multimodal',
	})
	context.limits.dashscope_sync_data_url_bytes = 100
	const audio = (size: number) =>
		({ name: 'speech.wav', type: 'audio/wav', size }) as File
	const invoke = (size: number) =>
		buildPlaygroundInput(
			context,
			search,
			'{}',
			'generations',
			'generateContent',
			{ audio: audio(size) },
			'file'
		)
	assert.equal('routeId' in invoke(57), true)
	rejectKey(() => invoke(60), 'fileInvalid')
	context.routes[0] = fixtureRoute({
		upstream_operation: 'audio.transcriptions',
	})
	assert.equal('routeId' in invoke(60), true)
})
