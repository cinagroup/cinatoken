/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	disposeDashScopeRealtimeClient,
	openDashScopeRealtimeClient,
} from './dashscope-realtime-client'

class Socket extends EventTarget {
	static CONNECTING = 0
	static OPEN = 1
	static CLOSING = 2
	static CLOSED = 3
	readyState = 0
	binaryType = ''
	sent: unknown[] = []
	protocols: string | string[] | undefined
	constructor(_url: string, protocols?: string | string[]) {
		super()
		this.protocols = protocols
	}
	send(value: unknown) {
		this.sent.push(value)
	}
	close() {
		this.readyState = 3
		const event = new Event('close')
		Object.assign(event, { code: 1000 })
		this.dispatchEvent(event)
	}
	open() {
		this.readyState = 1
		this.dispatchEvent(new Event('open'))
	}
	message(data: string) {
		this.dispatchEvent(new MessageEvent('message', { data }))
	}
}
function environment() {
	const keys = ['WebSocket', 'window', 'navigator'] as const,
		previous = keys.map((key) =>
			Object.getOwnPropertyDescriptor(globalThis, key)
		)
	Object.defineProperty(globalThis, 'WebSocket', {
		value: Socket,
		configurable: true,
	})
	Object.defineProperty(globalThis, 'window', {
		value: { setInterval, clearInterval },
		configurable: true,
	})
	return {
		navigator(value: unknown) {
			Object.defineProperty(globalThis, 'navigator', {
				value,
				configurable: true,
			})
		},
		restore() {
			keys.forEach((key, index) => {
				const descriptor = previous[index]
				if (descriptor) Object.defineProperty(globalThis, key, descriptor)
				else Reflect.deleteProperty(globalThis, key)
			})
		},
	}
}
const next = () => new Promise((done) => setImmediate(done))
test('disposing before a late microphone permission stops acquired tracks and suppresses all late callbacks', async () => {
	const globals = environment()
	try {
		let acquire: (stream: MediaStream) => void = () => undefined,
			stopped = 0,
			messages = 0
		globals.navigator({
			mediaDevices: {
				getUserMedia: () =>
					new Promise<MediaStream>((resolve) => {
						acquire = resolve
					}),
			},
		})
		const client = openDashScopeRealtimeClient({
			url: 'ws://local',
			operation: 'audio.transcriptions.realtime.session',
			initialMessage: '{"type":"session.update","session":{}}',
			audioInput: 'microphone',
			protocols: ['cinatoken-playground'],
			onMessage: () => messages++,
		})
		const socket = client as unknown as Socket
		socket.open()
		socket.message('{"type":"session.updated"}')
		disposeDashScopeRealtimeClient(client)
		acquire({
			getTracks: () => [
				{
					stop() {
						stopped++
					},
				},
			],
		} as unknown as MediaStream)
		await next()
		socket.message('{"type":"late"}')
		assert.equal(stopped, 1)
		assert.equal(messages, 1)
		assert.equal(socket.readyState, 3)
		assert.deepEqual(socket.protocols, ['cinatoken-playground'])
	} finally {
		globals.restore()
	}
})
test('a file read resolving after disposal cannot send frames or restart its timer', async () => {
	const globals = environment()
	try {
		let read: (buffer: ArrayBuffer) => void = () => undefined
		const file = {
			arrayBuffer: () =>
				new Promise<ArrayBuffer>((resolve) => {
					read = resolve
				}),
		} as File
		const client = openDashScopeRealtimeClient({
			url: 'ws://local',
			operation: 'audio.transcriptions.realtime.inference',
			initialMessage:
				'{"header":{"action":"run-task","task_id":"one"},"payload":{"input":{}}}',
			audioFile: file,
		})
		const socket = client as unknown as Socket
		socket.open()
		socket.message('{"header":{"event":"task-started"}}')
		disposeDashScopeRealtimeClient(client)
		read(new Uint8Array([1, 2, 3]).buffer)
		await next()
		assert.equal(socket.sent.length, 1)
		assert.equal(socket.readyState, 3)
	} finally {
		globals.restore()
	}
})
test('transport errors force close immediately and cannot report a second close as completion', () => {
	const globals = environment()
	try {
		let errors = 0,
			closes = 0
		const client = openDashScopeRealtimeClient({
			url: 'ws://local',
			operation: 'audio.transcriptions.realtime.session',
			initialMessage: '{"type":"session.update"}',
			onError: () => errors++,
			onClose: () => closes++,
		})
		const socket = client as unknown as Socket
		socket.dispatchEvent(new Event('error'))
		assert.equal(errors, 1)
		assert.equal(closes, 0)
		assert.equal(socket.readyState, 3)
		disposeDashScopeRealtimeClient(client)
		assert.equal(closes, 0)
	} finally {
		globals.restore()
	}
})
