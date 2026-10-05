/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	chatRetryDelaySeconds,
	createPublicChatApi,
	PublicChatError,
} from './chat-api'
import {
	isValidAttachment,
	toChatApiMessages,
	toStoredChatSession,
	validateAttachmentFiles,
} from './chat-model'

const input = {
	model: 'vendor/model',
	messages: [{ role: 'user' as const, content: 'Hello' }],
}
const key = 'fixture-inference-key'
const errorIs =
	(code: PublicChatError['code'], status = 0) =>
	(error: unknown) =>
		error instanceof PublicChatError &&
		error.code === code &&
		error.status === status &&
		!error.message.includes(key)
test('Retry-After accepts bounded seconds and exact HTTP dates without reflecting arbitrary text', () => {
	assert.equal(chatRetryDelaySeconds('12'), 12)
	assert.equal(
		chatRetryDelaySeconds(
			'Sun, 27 Sep 2026 12:00:12 GMT',
			Date.parse('2026-09-27T12:00:00Z')
		),
		12
	)
	assert.equal(chatRetryDelaySeconds('1\r\nsecret'), null)
	assert.equal(chatRetryDelaySeconds(key), null)
	assert.equal(chatRetryDelaySeconds('999999'), null)
})

function stream(parts: string[]) {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const part of parts)
					controller.enqueue(new TextEncoder().encode(part))
				controller.close()
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	)
}

test('chat uses only inference Bearer on the fixed BFF and streams arbitrary UTF-8 boundaries', async () => {
	const encoded = new TextEncoder().encode(
		'data: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: [DONE]\n\n'
	)
	const updates: string[] = []
	const api = createPublicChatApi(async (path, init) => {
		assert.equal(path, '/api/public/chat')
		assert.equal(init?.credentials, 'omit')
		assert.equal(init?.cache, 'no-store')
		assert.equal(
			new Headers(init?.headers).get('authorization'),
			`Bearer ${key}`
		)
		assert.equal(new Headers(init?.headers).get('x-cinatoken-workspace'), null)
		assert.deepEqual(JSON.parse(String(init?.body)), { ...input, stream: true })
		return new Response(
			new ReadableStream({
				start(controller) {
					for (let index = 0; index < encoded.length; index++)
						controller.enqueue(encoded.slice(index, index + 1))
					controller.close()
				},
			}),
			{ headers: { 'content-type': 'text/event-stream' } }
		)
	})
	assert.equal(
		await api.send(key, input, { onText: (text) => updates.push(text) }),
		'你好'
	)
	assert.ok(updates.includes('你好'))
})

test('EOF without DONE preserves partial text but rejects a broken stream', async () => {
	const updates: string[] = []
	await assert.rejects(
		createPublicChatApi(async () =>
			stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])
		).send(key, input, { onText: (text) => updates.push(text) }),
		errorIs('interrupted')
	)
	assert.ok(updates.includes('partial'))
})

test('untrusted stream errors never echo credentials or become assistant text', async () => {
	const updates: string[] = []
	await assert.rejects(
		createPublicChatApi(async () =>
			stream([`data: {"error":{"message":"${key}"}}\n\n`])
		).send(key, input, { onText: (text) => updates.push(text) }),
		errorIs('invalid-response')
	)
	assert.deepEqual(updates, [])
})

test('valid partial replies survive an error independently of network chunk boundaries', async () => {
	const text = 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
	const error = `data: {"error":{"message":"${key}"}}\n\n`
	const ignored = 'data: {"choices":[{"delta":{"content":"ignored"}}]}\n\n'
	for (const parts of [[text + error + ignored], [text, error + ignored]]) {
		const updates: string[] = []
		await assert.rejects(
			createPublicChatApi(async () => stream(parts)).send(key, input, {
				onText: (value) => updates.push(value),
			}),
			errorIs('invalid-response')
		)
		assert.deepEqual(updates, ['partial'])
	}
})

test('HTTP inference errors retain status and bounded Retry-After without reading secret-echoing bodies', async () => {
	for (const status of [401, 403, 429, 503]) {
		await assert.rejects(
			createPublicChatApi(
				async () =>
					new Response(key, { status, headers: { 'retry-after': '12' } })
			).send(key, input, { onText: () => assert.fail() }),
			(error: unknown) =>
				errorIs('http', status)(error) &&
				(error as PublicChatError).retryAfter === '12'
		)
	}
})

test('a non-stream JSON completion is supported, while HTML and empty assistant responses are rejected', async () => {
	const api = createPublicChatApi(async () =>
		Response.json({ choices: [{ message: { content: 'answer' } }] })
	)
	assert.equal(
		await api.send(key, input, {
			onText: (text) => assert.equal(text, 'answer'),
		}),
		'answer'
	)
	for (const response of [
		new Response('<html>wrong route</html>'),
		Response.json({ choices: [] }),
		stream(['data: [DONE]\n\n']),
	])
		await assert.rejects(
			createPublicChatApi(async () => response).send(key, input, {
				onText: () => undefined,
			}),
			errorIs('invalid-response')
		)
})

test('timeout settles ignored fetch abort promptly and never retries a write', async () => {
	let calls = 0
	await assert.rejects(
		createPublicChatApi(async () => {
			calls++
			return new Promise<Response>(() => undefined)
		}).send(key, input, { timeoutMs: 5, onText: () => assert.fail() }),
		errorIs('timeout')
	)
	assert.equal(calls, 1)
})

test('stop settles a hanging reader promptly and does not publish late data', async () => {
	const controller = new AbortController()
	let calls = 0
	const response = new Response(
		new ReadableStream({
			pull() {
				return new Promise(() => undefined)
			},
		}),
		{ headers: { 'content-type': 'text/event-stream' } }
	)
	const pending = createPublicChatApi(async () => {
		calls++
		return response
	}).send(key, input, {
		signal: controller.signal,
		onText: () => assert.fail(),
	})
	setTimeout(() => controller.abort(), 5)
	await assert.rejects(pending, errorIs('cancelled'))
	assert.equal(calls, 1)
})

test('invalid key and request boundaries fail before network', async () => {
	const api = createPublicChatApi(async () => assert.fail())
	for (const invalid of ['', 'short', 'space key', 'a'.repeat(513)])
		await assert.rejects(
			api.send(invalid, input, { onText: () => undefined }),
			errorIs('input')
		)
	await assert.rejects(
		api.send(key, { ...input, messages: [] }, { onText: () => undefined }),
		errorIs('input')
	)
})

test('local history projection saves text/model only and drops API keys, image URLs and empty assistants', () => {
	const image = {
		id: 'image',
		name: 'fixture.png',
		size: 8,
		dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
	}
	const messages = [
		{ id: '1', role: 'user' as const, content: '', attachments: [image] },
		{ id: '2', role: 'assistant' as const, content: '' },
	]
	assert.equal(isValidAttachment(image), true)
	assert.deepEqual(
		toStoredChatSession('model', messages, (count) => `[${count} omitted]`),
		{
			version: 1,
			modelId: 'model',
			messages: [{ role: 'user', content: '[1 omitted]' }],
		}
	)
	assert.equal(
		JSON.stringify(
			toStoredChatSession('model', messages, () => 'image omitted')
		).includes('data:image'),
		false
	)
	assert.equal(toChatApiMessages(messages).length, 1)
})

test('image limits apply to the complete conversation and payload signatures are validated', () => {
	assert.equal(
		validateAttachmentFiles([{ type: 'image/png', size: 1 }], [], false),
		'imagesUnsupported'
	)
	assert.equal(
		validateAttachmentFiles(
			Array.from({ length: 5 }, () => ({ type: 'image/png', size: 1 })),
			[],
			true
		),
		'tooManyAttachments'
	)
	assert.equal(
		validateAttachmentFiles([{ type: 'image/svg+xml', size: 1 }], [], true),
		'unsupportedAttachment'
	)
	assert.equal(
		validateAttachmentFiles(
			[{ type: 'image/png', size: 4 * 1024 * 1024 + 1 }],
			[],
			true
		),
		'attachmentTooLarge'
	)
	assert.equal(
		validateAttachmentFiles(
			Array.from({ length: 3 }, () => ({
				type: 'image/png',
				size: 3 * 1024 * 1024,
			})),
			[],
			true
		),
		'attachmentsTooLarge'
	)
	assert.equal(
		isValidAttachment({
			id: '',
			name: '',
			size: 1,
			dataUrl: 'data:image/png;base64,ZXZpbA==',
		}),
		false
	)
})
