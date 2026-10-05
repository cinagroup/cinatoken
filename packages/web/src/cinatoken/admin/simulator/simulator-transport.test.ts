/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { DashScopeRealtimeClientOptions } from '../playground/browser-domain/dashscope-realtime-client'
import { RunOwner } from '../playground/browser-domain/run-owner'
import {
	executeSimulatorHttp,
	executeSimulatorRealtime,
	type SimulatorTransportResult,
} from './simulator-transport'

const secret = 'sk-' + 'K'.repeat(32)
const request = {
	url: 'https://proxy.example.test/v1/chat/completions',
	headers: {
		Authorization: 'Bearer ' + secret,
		'Content-Type': 'application/json',
	},
	bodyText: '{"model":"chat"}',
}
test('HTTP goes directly to Proxy without cookies, follows no redirects, makes no retry and preserves SSE', async () => {
	let calls = 0
	const payload =
		'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'
	const progress: SimulatorTransportResult[] = []
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value),
		fetch: async (url, init) => {
			calls++
			assert.equal(url, request.url)
			assert.equal(init?.credentials, 'omit')
			assert.equal(init?.redirect, 'error')
			assert.equal(init?.cache, 'no-store')
			assert.equal(
				new Headers(init?.headers).get('Authorization'),
				'Bearer ' + secret
			)
			return new Response(payload, {
				headers: {
					'content-type': 'text/event-stream',
					'x-generation-id': 'gen-1',
				},
			})
		},
	})
	assert.equal(calls, 1)
	assert.equal(result.raw, payload)
	assert.equal(result.meta.outcome, 'complete')
	assert.equal(result.meta.generationId, 'gen-1')
	assert.ok(progress.length >= 2)
})
test('budget errors remain Proxy business errors without session invalidation or retries', async () => {
	for (const status of [402, 403]) {
		let calls = 0
		const result = await executeSimulatorHttp({
			request,
			secret,
			signal: new AbortController().signal,
			onProgress: () => undefined,
			fetch: async () => {
				calls++
				return Response.json(
					{ error: { code: 'budget_exceeded', message: 'Budget exceeded' } },
					{ status }
				)
			},
		})
		assert.equal(calls, 1)
		assert.equal(result.meta.status, status)
		assert.equal(result.meta.outcome, 'failed')
		assert.match(result.raw, /budget_exceeded/)
	}
})
test('network or redirect rejection produces an unknown billed outcome and no retry', async () => {
	let calls = 0
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: () => undefined,
		fetch: async () => {
			calls++
			throw new TypeError('redirect or connection lost')
		},
	})
	assert.equal(calls, 1)
	assert.equal(result.meta.status, null)
	assert.equal(result.meta.outcome, 'unknown')
})
test('a Proxy error inside an HTTP 200 SSE stream is a failed request with its raw error preserved', async () => {
	const payload = 'data: {"error":{"code":"budget_exceeded"}}\n\n'
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: () => undefined,
		fetch: async () =>
			new Response(payload, {
				headers: { 'content-type': 'text/event-stream' },
			}),
	})
	assert.equal(result.meta.status, 200)
	assert.equal(result.meta.outcome, 'failed')
	assert.equal(result.raw, payload)
})
test('Stop immediately cancels the reader and releases a pending read without late progress', async () => {
	const controller = new AbortController()
	let cancelled = 0
	let headersReceived: (() => void) | undefined
	const ready = new Promise<void>((resolve) => {
		headersReceived = resolve
	})
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled++
		},
	})
	const progress: SimulatorTransportResult[] = []
	const pending = executeSimulatorHttp({
		request,
		secret,
		signal: controller.signal,
		onProgress: (value) => {
			progress.push(value)
			headersReceived?.()
		},
		fetch: async () =>
			new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
	})
	await ready
	controller.abort()
	const result = await pending
	assert.ok(cancelled >= 1)
	assert.equal(result.meta.outcome, 'cancelled')
	assert.equal(body.locked, false)
	assert.equal(progress.length, 1)
})
test('an echoed secret split across stream chunks never reaches published progress or result', async () => {
	const progress: SimulatorTransportResult[] = []
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		start(stream) {
			stream.enqueue(encoder.encode('echo ' + secret.slice(0, 12)))
			stream.enqueue(encoder.encode(secret.slice(12)))
			stream.close()
		},
	})
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: (value) => progress.push(value),
		fetch: async () =>
			new Response(body, {
				headers: { 'content-type': 'text/plain', 'x-generation-id': secret },
			}),
	})
	assert.equal(result.raw, 'echo [redacted]')
	assert.equal(result.meta.generationId, '[redacted]')
	assert.equal(
		progress.some(
			(value) =>
				JSON.stringify(value).includes(secret) ||
				value.raw.includes(secret.slice(0, 12))
		),
		false
	)
})
test('successful speech is preserved as audio bytes instead of being decoded as text', async () => {
	const bytes = new Uint8Array([1, 2, 3, 255])
	const result = await executeSimulatorHttp({
		request,
		secret,
		signal: new AbortController().signal,
		onProgress: () => undefined,
		fetch: async () =>
			new Response(bytes, { headers: { 'content-type': 'audio/wav' } }),
	})
	assert.equal(result.raw, '')
	assert.equal(result.audio?.type, 'audio/wav')
	assert.deepEqual(new Uint8Array(await result.audio!.arrayBuffer()), bytes)
})
function realtimeFixture() {
	let callbacks: DashScopeRealtimeClientOptions | undefined
	let disposals = 0
	const controller = new AbortController()
	const progress: SimulatorTransportResult[] = []
	const socket = {} as WebSocket
	const pending = executeSimulatorRealtime({
		url: 'wss://proxy.example.test/v1/dashscope/realtime?model=asr',
		operation: 'audio.transcriptions.realtime.inference',
		secret,
		initialMessage: '{}',
		audioFile: null,
		audioInput: 'microphone',
		signal: controller.signal,
		onProgress: (value) => progress.push(value),
		open: (options) => {
			callbacks = options
			return socket
		},
		dispose: () => {
			disposals++
		},
	})
	return {
		callbacks: callbacks!,
		controller,
		progress,
		pending,
		disposals: () => disposals,
	}
}
test('rejected WebSocket handshake cannot invent an HTTP 101', async () => {
	const fixture = realtimeFixture()
	fixture.callbacks.onError?.(new Event('error'))
	const result = await fixture.pending
	assert.equal(result.meta.status, null)
	assert.equal(result.meta.latencyMs, null)
	assert.equal(result.meta.outcome, 'failed')
	assert.equal(fixture.disposals(), 1)
})
test('only actual WebSocket open publishes 101 and every late callback is ignored after Stop', async () => {
	const fixture = realtimeFixture()
	fixture.callbacks.onOpen?.()
	fixture.callbacks.onMessage?.('{"header":{"event":"task-started"}}')
	fixture.controller.abort()
	const result = await fixture.pending
	const count = fixture.progress.length
	fixture.callbacks.onOpen?.()
	fixture.callbacks.onMessage?.('late')
	fixture.callbacks.onAudioChunk?.(new ArrayBuffer(1))
	fixture.callbacks.onClose?.({ code: 1000 } as CloseEvent)
	assert.equal(result.meta.status, 101)
	assert.equal(result.meta.outcome, 'cancelled')
	assert.equal(fixture.progress.length, count)
	assert.ok(fixture.disposals() >= 1)
})
test('run ownership rejects old generations and disposes all resources even if one cleanup throws', () => {
	const owner = new RunOwner()
	const first = owner.start()
	let cleaned = 0
	first.cleanups.add(() => {
		throw new Error('cleanup failed')
	})
	first.cleanups.add(() => {
		cleaned++
	})
	const second = owner.start()
	assert.equal(first.controller.signal.aborted, true)
	assert.equal(owner.owns(first), false)
	assert.equal(owner.owns(second), true)
	assert.equal(cleaned, 1)
	owner.cancel()
	assert.equal(second.controller.signal.aborted, true)
	assert.equal(owner.owns(second), false)
})
