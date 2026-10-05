/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	abortablePublicResponse,
	readPublicBrowserShell,
} from './response-cancellation'

test('aborted asset wait rejects and actually cancels a late response body', async () => {
	const controller = new AbortController()
	let resolve!: (response: Response) => void
	let cancelled = 0
	const task = abortablePublicResponse(
		new Promise<Response>((accept) => {
			resolve = accept
		}),
		controller.signal
	)
	controller.abort()
	await assert.rejects(task, /cancelled/)
	resolve(
		new Response(
			new ReadableStream({
				cancel() {
					cancelled++
				},
			})
		)
	)
	await new Promise<void>((accept) => queueMicrotask(accept))
	assert.equal(cancelled, 1)
})

test('stalled asset body releases its lock and aborts even when source cancel never settles', async () => {
	const controller = new AbortController()
	let cancelled = 0
	const body = new ReadableStream<Uint8Array>({
		cancel() {
			cancelled++
			return new Promise<void>(() => undefined)
		},
	})
	const task = readPublicBrowserShell(new Response(body), controller.signal)
	controller.abort()
	await assert.rejects(task)
	assert.equal(cancelled, 1)
	assert.equal(body.locked, false)
	assert.equal(
		await readPublicBrowserShell(
			new Response('<html>retry</html>'),
			new AbortController().signal
		),
		'<html>retry</html>'
	)
})

test('browser shell enforces bytes and fatal UTF-8 while cancelling rejected bodies', async () => {
	for (const bytes of [
		new Uint8Array(1024 * 1024 + 1),
		new Uint8Array([0xc3, 0x28]),
	]) {
		let cancelled = 0
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes)
			},
			cancel() {
				cancelled++
			},
		})
		await assert.rejects(
			readPublicBrowserShell(new Response(body), new AbortController().signal)
		)
		assert.equal(cancelled, 1)
		assert.equal(body.locked, false)
	}
})
