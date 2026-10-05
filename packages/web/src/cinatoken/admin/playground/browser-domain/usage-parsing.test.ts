/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeAssistantTextParts } from './merge-assistant-text'
import { parseLastStreamUsage } from './usage-parsing'

test('OpenAI Responses usage in completed response is displayed from its nested envelope', () => {
	const raw =
		'data: ' +
		JSON.stringify({
			type: 'response.completed',
			response: {
				usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 },
			},
		}) +
		'\n\n'
	assert.equal(
		parseLastStreamUsage(raw, 'openai'),
		'prompt/input: 12 · completion/output: 3 · total: 15'
	)
})
test('NDJSON usage accepts JSON lines and DashScope task payloads without pretending to be SSE', () => {
	const raw = JSON.stringify({
		header: { event: 'task-finished' },
		payload: { usage: { duration: 1.5 } },
	})
	assert.equal(parseLastStreamUsage(raw, 'dashscope'), 'duration: 1.5s')
})
test('NDJSON deltas retain readable text for OpenAI, Anthropic and Gemini', () => {
	const packets = [
		{
			protocol: 'openai' as const,
			body: {
				choices: [{ delta: { reasoning_content: 'think', content: 'answer' } }],
			},
		},
		{
			protocol: 'anthropic' as const,
			body: {
				type: 'content_block_delta',
				delta: { type: 'text_delta', text: 'answer' },
			},
		},
		{
			protocol: 'gemini' as const,
			body: { candidates: [{ content: { parts: [{ text: 'answer' }] } }] },
		},
	]
	for (const packet of packets)
		assert.equal(
			mergeAssistantTextParts(
				JSON.stringify(packet.body) + '\n',
				packet.protocol,
				'ndjson'
			).body,
			'answer'
		)
})
