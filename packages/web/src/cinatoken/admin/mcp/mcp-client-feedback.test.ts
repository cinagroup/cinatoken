/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	buildMcpClientRequest,
	executeMcpClient,
	McpClientError,
} from './mcp-client'
import {
	mcpClientFailureMessage,
	mcpClientResultMessage,
} from './mcp-client-feedback'

const request = buildMcpClientRequest({
	base: 'https://proxy.invalid',
	slug: '',
	method: 'tools/list',
	version: '2025-06-18',
	id: 1,
})
test('client feedback distinguishes HTTP failure from RPC failure and invalid envelopes', async () => {
	for (const [status, body, expected] of [
		[200, { jsonrpc: '2.0', id: 1, result: { tools: [] } }, null],
		[502, { jsonrpc: '2.0', id: 1, result: { tools: [] } }, 'clientHttpError'],
		[
			429,
			{ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'Limited' } },
			'clientHttpError',
		],
		[
			200,
			{
				jsonrpc: '2.0',
				id: 1,
				error: { code: -32603, message: 'Unavailable' },
			},
			'clientRpcError',
		],
		[200, { jsonrpc: '2.0', id: 2, result: { tools: [] } }, 'clientInvalid'],
	] as const) {
		const result = await executeMcpClient(
			request,
			'sk-diagnostic-fixture-secret',
			{ fetch: async () => new Response(JSON.stringify(body), { status }) }
		)
		assert.equal(mcpClientResultMessage(result), expected)
	}
})
test('transport failures have actionable localized keys and explicit cancellation wins', () => {
	for (const [code, key] of Object.entries({
		timeout: 'clientTimeout',
		network: 'clientNetwork',
		tooLarge: 'clientTooLarge',
		invalid: 'clientInvalid',
		cancelled: 'cancelled',
	})) {
		const error = new McpClientError(code as McpClientError['code'])
		assert.equal(mcpClientFailureMessage(error), key)
		assert.equal(mcpClientFailureMessage(error, true), 'cancelled')
	}
	assert.equal(
		mcpClientFailureMessage(new Error('private detail')),
		'clientFailed'
	)
})
