/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSimulatorAsyncTask } from './simulator-async-task'
import { executeSimulatorHttp } from './simulator-transport'

const receipt = 'private_payload.private_signature'
const secret = 'sk-' + 'a'.repeat(48)
test('invalid receipt-bearing responses never enter the displayed raw result', () => {
	for (const raw of [
		'{"gateway_task_receipt":"' + receipt + '",',
		JSON.stringify(receipt),
		JSON.stringify([{ gateway_task_receipt: receipt }]),
	]) {
		assert.deepEqual(extractSimulatorAsyncTask(raw), { raw: '' })
	}
})

test('an async submission without a usable receipt stays unknown and never streams private raw text', async () => {
	for (const raw of [
		'{"gateway_task_receipt":"' + receipt + '",',
		JSON.stringify({ output: { task_id: 'task-qa', task_status: 'PENDING' } }),
		JSON.stringify({
			output: { task_id: 'task-qa' },
			gateway_task_receipt: 'invalid receipt',
		}),
	]) {
		const progress: string[] = []
		const result = await executeSimulatorHttp({
			request: {
				url: 'https://proxy.example/v1/dashscope/services/audio/asr/transcription',
				headers: { Authorization: 'Bearer ' + secret },
				bodyText: '{}',
			},
			secret,
			signal: new AbortController().signal,
			captureAsyncTask: true,
			onProgress: (value) => progress.push(value.raw),
			fetch: async () =>
				new Response(raw, { headers: { 'content-type': 'application/json' } }),
		})
		assert.equal(result.meta.outcome, 'unknown')
		assert.equal(result.task, undefined)
		assert.ok(!result.raw.includes('gateway_task_receipt'))
		assert.ok(!result.raw.includes(receipt))
		assert.ok(progress.every((value) => value === ''))
	}
})
