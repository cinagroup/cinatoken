/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { publicDocumentBody } from './document-stream'

const encoder = new TextEncoder()
function document(stream: ReadableStream<Uint8Array>) {
	let finishes = 0
	const aborts: unknown[] = []
	const body = publicDocumentBody(
		stream,
		encoder.encode('<root>'),
		encoder.encode('</root>'),
		() => finishes++,
		(reason) => aborts.push(reason)
	)
	return {
		body,
		aborts,
		get finishes() {
			return finishes
		},
	}
}

test('a complete app body keeps byte order and releases the owned reader once', async () => {
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(encoder.encode('app'))
			controller.close()
		},
	})
	const f = document(source)
	assert.equal(await new Response(f.body).text(), '<root>app</root>')
	assert.equal(source.locked, false)
	assert.equal(f.finishes, 1)
	assert.deepEqual(f.aborts, [])
})

test('cancellation releases the reader and request immediately even when upstream cancel is pending', async () => {
	let completeCancel!: () => void
	let calls = 0
	const source = new ReadableStream<Uint8Array>({
		cancel() {
			calls++
			return new Promise<void>((resolve) => {
				completeCancel = resolve
			})
		},
	})
	const f = document(source)
	const cancelled = f.body.cancel('disconnect')
	assert.equal(source.locked, false)
	assert.equal(f.finishes, 1)
	assert.deepEqual(f.aborts, ['disconnect'])
	assert.equal(calls, 1)
	completeCancel()
	await cancelled
})

test('cancel during a pending app read prevents a late pull from emitting a suffix or finishing twice', async () => {
	let reads = 0,
		cancels = 0
	const source = new ReadableStream<Uint8Array>(
		{
			pull() {
				reads++
			},
			cancel() {
				cancels++
			},
		},
		{ highWaterMark: 0 }
	)
	const f = document(source)
	const reader = f.body.getReader()
	assert.equal(new TextDecoder().decode((await reader.read()).value), '<root>')
	const pending = reader.read()
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.ok(reads > 0)
	await reader.cancel('stop')
	assert.equal((await pending).done, true)
	await new Promise((resolve) => setTimeout(resolve, 0))
	assert.equal(source.locked, false)
	assert.equal(cancels, 1)
	assert.equal(f.finishes, 1)
	assert.deepEqual(f.aborts, ['stop'])
	reader.releaseLock()
})

test('an app read failure preserves the error and releases request resources', async () => {
	const failure = new Error('synthetic app read failure')
	const source = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.error(failure)
			},
		},
		{ highWaterMark: 0 }
	)
	const f = document(source)
	await assert.rejects(
		new Response(f.body).text(),
		(error) => error === failure
	)
	assert.equal(source.locked, false)
	assert.equal(f.finishes, 1)
	assert.deepEqual(f.aborts, [failure])
})

test('a rejecting source cancel still releases its reader and request exactly once', async () => {
	const failure = new Error('synthetic source cancel failure')
	const source = new ReadableStream<Uint8Array>({
		cancel() {
			throw failure
		},
	})
	const f = document(source)
	await assert.rejects(f.body.cancel('stop'), (error) => error === failure)
	assert.equal(source.locked, false)
	assert.equal(f.finishes, 1)
	assert.deepEqual(f.aborts, ['stop'])
})
