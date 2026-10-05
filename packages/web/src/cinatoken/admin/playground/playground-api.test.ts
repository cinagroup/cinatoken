/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	createPlaygroundApi,
	PlaygroundError,
	playgroundFormData,
} from './playground-api'
import { fixtureContext } from './playground-fixtures'

const signal = () => new AbortController().signal
const envelope = { routeId: 'r-text', body: { stream: true } }
const preview = {
	mode: 'tool',
	upstream_url: 'engine://web-search/bocha',
	request_body_json: '{}',
	preview_only: true,
	truncated: false,
	wire_format: 'engine-envelope',
	ready: true,
}
test('Admin context uses no-store same-origin and a canonical Console subject; safe DTO strips unknown fields', async () => {
	let requests = 0
	const api = createPlaygroundApi(async (path, init) => {
		requests++
		assert.equal(path, '/api/admin/playground/context')
		assert.equal(init?.credentials, 'same-origin')
		assert.equal(init?.redirect, 'error')
		assert.equal(init?.cache, 'no-store')
		assert.equal(
			new Headers(init?.headers).get('X-CinaToken-Expected-Console-Subject'),
			encodeURIComponent('用户@example.com')
		)
		return Response.json({
			success: true,
			data: { ...fixtureContext(), secret: 'private' },
		})
	}, '用户@example.com')
	assert.equal(
		JSON.stringify(await api.context(signal())).includes('private'),
		false
	)
	assert.equal(requests, 1)
})
test('Tools preview omits uploadManifest; route preview describes files without uploading bytes', async () => {
	const bodies: Record<string, unknown>[] = []
	const api = createPlaygroundApi(async (_path, init) => {
		assert.equal(init?.method, 'POST')
		bodies.push(JSON.parse(String(init?.body)))
		return Response.json({ success: true, data: preview })
	})
	await api.preview(
		{ toolId: 'web-search', provider: 'bocha', body: { query: 'q' } },
		{},
		signal()
	)
	assert.equal('uploadManifest' in bodies[0], false)
	await api.preview(
		envelope,
		{
			images: [
				new File(['private pixels'], 'image.png', { type: 'image/png' }),
			],
		},
		signal()
	)
	assert.equal(JSON.stringify(bodies[1]).includes('private pixels'), false)
	assert.deepEqual(bodies[1].uploadManifest, {
		images: [{ name: 'image.png', type: 'image/png', size: 14 }],
	})
})
test('multipart preserves repeated image bytes, body and operation, without data URL conversion', async () => {
	const files = [
		new File(['one'], 'one.png', { type: 'image/png' }),
		new File(['two'], 'two.png', { type: 'image/png' }),
	]
	const form = playgroundFormData(
		{ ...envelope, imageOperation: 'edits' },
		{ images: files }
	)
	assert.equal(form.get('routeId'), 'r-text')
	assert.deepEqual(JSON.parse(String(form.get('body'))), envelope.body)
	assert.equal(form.getAll('image').length, 2)
	assert.equal(await (form.getAll('image')[1] as File).text(), 'two')
	assert.throws(
		() =>
			playgroundFormData(
				{ toolId: 'web-search', provider: 'bocha', body: {} },
				{ images: files }
			),
		PlaygroundError
	)
})
test('upstream 401 is a local diagnostic result, while Console 403 is an access error and never retried', async () => {
	let calls = 0
	const upstream = createPlaygroundApi(async () => {
		calls++
		return new Response('{"error":"provider unauthorized"}', {
			status: 401,
			headers: {
				'x-playground-mode': 'route',
				'content-type': 'application/json',
				'x-playground-latency-scope': 'upstream_headers',
				'x-playground-upstream-status': '401',
			},
		})
	})
	const result = await upstream.execute(
		envelope,
		{},
		{ signal: signal(), onMeta: () => undefined, onRaw: () => undefined }
	)
	assert.equal(result.meta.status, 401)
	assert.equal(result.meta.latencyScope, 'upstream_headers')
	assert.ok(result.raw.includes('provider unauthorized'))
	const denied = createPlaygroundApi(async () => {
		calls++
		return Response.json({ success: false, message: 'Denied' }, { status: 403 })
	})
	await assert.rejects(
		denied.execute(
			envelope,
			{},
			{
				signal: signal(),
				onMeta: () => assert.fail(),
				onRaw: () => assert.fail(),
			}
		),
		(error) => error instanceof PlaygroundError && error.code === 'access'
	)
	assert.equal(calls, 2)
})
test('pre-cancelled requests never call transport; late fetch response is cancelled without invoking callbacks', async () => {
	const cancelled = new AbortController()
	cancelled.abort()
	let called = 0
	const early = createPlaygroundApi(async () => {
		called++
		return Response.json({})
	})
	await assert.rejects(
		early.execute(
			envelope,
			{},
			{
				signal: cancelled.signal,
				onMeta: () => assert.fail(),
				onRaw: () => assert.fail(),
			}
		)
	)
	assert.equal(called, 0)
	let resolve: (response: Response) => void = () => undefined
	const pending = new Promise<Response>((done) => {
		resolve = done
	})
	const late = createPlaygroundApi(async () => pending),
		controller = new AbortController()
	let bodyCancelled = false
	const execution = late.execute(
		envelope,
		{},
		{
			signal: controller.signal,
			onMeta: () => assert.fail(),
			onRaw: () => assert.fail(),
		}
	)
	controller.abort()
	await assert.rejects(
		execution,
		(error) => error instanceof PlaygroundError && error.code === 'cancelled'
	)
	resolve(
		new Response(
			new ReadableStream({
				cancel() {
					bodyCancelled = true
				},
			})
		)
	)
	await new Promise((done) => setImmediate(done))
	assert.equal(bodyCancelled, true)
})
test('headers cancellation releases stalled reader and preserves only the true partial response', async () => {
	const controller = new AbortController()
	let cancelled = false,
		streamController: ReadableStreamDefaultController<Uint8Array> | undefined
	const stream = new ReadableStream<Uint8Array>({
		start(current) {
			streamController = current
			current.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n'))
		},
		cancel() {
			cancelled = true
		},
	})
	let chunks = 0
	const api = createPlaygroundApi(
		async () =>
			new Response(stream, {
				headers: {
					'x-playground-mode': 'route',
					'content-type': 'text/event-stream',
				},
			})
	)
	const execution = api.execute(
		envelope,
		{},
		{
			signal: controller.signal,
			onMeta: () => undefined,
			onRaw: (raw) => {
				chunks++
				assert.ok(raw.startsWith('data:'))
				controller.abort()
			},
		}
	)
	await assert.rejects(
		execution,
		(error) => error instanceof PlaygroundError && error.code === 'cancelled'
	)
	assert.equal(chunks, 1)
	assert.equal(cancelled, true)
	assert.equal(stream.locked, false)
	assert.throws(() => streamController?.enqueue(new Uint8Array(1)))
})
test('binary speech remains a Blob rather than a fabricated JSON success', async () => {
	const api = createPlaygroundApi(
		async () =>
			new Response(new Uint8Array([1, 2, 3]), {
				headers: { 'x-playground-mode': 'route', 'content-type': 'audio/wav' },
			})
	)
	const response = await api.execute(
		envelope,
		{},
		{ signal: signal(), onMeta: () => undefined, onRaw: () => assert.fail() }
	)
	assert.equal(response.raw, '')
	assert.equal(response.audio?.type, 'audio/wav')
	assert.deepEqual(
		new Uint8Array(await response.audio!.arrayBuffer()),
		new Uint8Array([1, 2, 3])
	)
})
