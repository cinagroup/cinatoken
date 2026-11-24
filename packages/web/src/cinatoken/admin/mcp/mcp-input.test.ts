/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpServerSchema } from './mcp-contracts'
import {
	McpInputError,
	applyMcpImport,
	emptyMcpServerDraft,
	mcpCreateInput,
	mcpPricingDraftFrom,
	mcpPricingFromDraft,
	mcpServerDraftFrom,
	mcpUpdateInput,
	parseMcpClientConfig,
} from './mcp-input'

const server = mcpServerSchema.parse({
	id: 'server-1',
	slug: 'deep-wiki',
	name: 'Docs',
	description: null,
	status: 'active',
	urlMasked: 'https://example.test/?key=***',
	authHeaderNames: ['Authorization', 'X-Token'],
	pricing: { v: 1, prices: { standard: 0, charged: 0.02, metered: 0.01 } },
	timeoutMs: 30_000,
	maxResponseBytes: 1_048_576,
	lastSyncedAt: null,
	lastSyncError: null,
})
function createDraft() {
	return {
		...emptyMcpServerDraft(),
		slug: 'deep-wiki',
		name: 'Docs',
		url: 'https://example.test/mcp',
	}
}
test('new MCP servers use native limits, HTTPS/loopback URLs and canonical pricing', () => {
	const parsed = mcpCreateInput(createDraft())
	assert.equal(parsed.timeoutMs, 30_000)
	assert.equal(parsed.maxResponseBytes, 1_048_576)
	assert.deepEqual(parsed.pricing, {
		v: 2,
		unit: 'request',
		standard: 0,
		chargedFactor: 0,
		meteredFactor: 1,
		config: {},
	})
	assert.equal(
		mcpCreateInput({ ...createDraft(), url: 'http://127.0.0.1:8787/mcp' }).url,
		'http://127.0.0.1:8787/mcp'
	)
	for (const url of [
		'http://remote.invalid/mcp',
		'https://user:pass@example.test/mcp',
		'javascript:alert(1)',
		'https://metadata.google.internal/mcp',
	])
		assert.throws(
			() => mcpCreateInput({ ...createDraft(), url }),
			McpInputError
		)
	for (const patch of [
		{ timeoutMs: '999' },
		{ maxResponseBytes: '8000001' },
		{ name: '' },
		{ slug: 'builtin' },
	])
		assert.throws(
			() => mcpCreateInput({ ...createDraft(), ...patch }),
			McpInputError
		)
})
test('unrelated edits omit blank URL, untouched headers and legacy or invalid stored prices', () => {
	const draft = mcpServerDraftFrom(server)
	assert.equal(draft.url, '')
	assert.deepEqual(draft.headers, [
		{ key: 'Authorization', value: '' },
		{ key: 'X-Token', value: '' },
	])
	assert.equal(draft.pricing.mode, 'v1')
	assert.deepEqual(mcpUpdateInput({ ...draft, name: 'Updated' }, server), {
		name: 'Updated',
	})
	assert.deepEqual(
		mcpUpdateInput(mcpServerDraftFrom({ ...server, pricing: null }), {
			...server,
			pricing: null,
		}),
		{}
	)
	assert.throws(
		() => mcpUpdateInput({ ...draft, slug: 'renamed' }, server),
		McpInputError
	)
})
test('header updates retain explicit same-name blanks, replace the key set, and clear only deliberately', () => {
	const draft = mcpServerDraftFrom(server)
	assert.deepEqual(
		mcpUpdateInput(
			{ ...draft, headers: [{ key: 'Authorization', value: '' }] },
			server
		),
		{ authHeaders: { Authorization: '' } }
	)
	assert.deepEqual(mcpUpdateInput({ ...draft, headers: [] }, server), {
		authHeaders: {},
	})
	assert.deepEqual(
		mcpUpdateInput(
			{
				...draft,
				headers: [{ key: 'Authorization', value: 'Bearer replacement' }],
			},
			server
		),
		{ authHeaders: { Authorization: 'Bearer replacement' } }
	)
	for (const headers of [
		[{ key: 'New', value: '' }],
		[{ key: 'Host', value: 'bad' }],
		[{ key: 'Authorization', value: 'bad\r\nInjected: true' }],
		[
			{ key: 'Token', value: 'one' },
			{ key: 'token', value: 'two' },
		],
	])
		assert.throws(
			() => mcpUpdateInput({ ...draft, headers }, server),
			McpInputError
		)
})
test('explicit v1 and v2 editing never silently turns independent prices into multipliers', () => {
	const legacy = mcpPricingDraftFrom(server.pricing)
	assert.deepEqual(mcpPricingFromDraft(legacy), server.pricing)
	assert.throws(
		() => mcpPricingFromDraft({ ...legacy, mode: 'v2' }),
		McpInputError
	)
	const factors = {
		...legacy,
		mode: 'v2' as const,
		standard: '0.1',
		chargedFactor: '1.5',
		meteredFactor: '0.5',
	}
	assert.deepEqual(mcpPricingFromDraft(factors), {
		v: 2,
		unit: 'request',
		standard: 0.1,
		chargedFactor: 1.5,
		meteredFactor: 0.5,
		config: {},
	})
	assert.throws(
		() => mcpPricingFromDraft({ ...factors, standard: '' }),
		McpInputError
	)
})
test('URL and client JSON imports support named maps, labels and mcp-remote bridges', () => {
	for (const input of [
		'https://example.test/mcp',
		JSON.stringify({
			mcpServers: {
				'Deep Wiki': {
					url: 'https://example.test/mcp',
					headers: { Authorization: 'Bearer secret' },
				},
			},
		}),
		JSON.stringify({
			servers: {
				bridge: {
					command: 'npx',
					args: ['mcp-remote', 'https://example.test/mcp'],
				},
			},
		}),
		JSON.stringify({
			server_url: 'https://example.test/mcp',
			server_label: 'Docs',
		}),
	]) {
		const result = parseMcpClientConfig(input)
		assert.equal(result.ok, true)
		if (result.ok) assert.equal(result.servers.length, 1)
	}
	const imported = parseMcpClientConfig(
		JSON.stringify({
			mcpServers: { 'Deep Wiki': { url: 'https://example.test/mcp' } },
		})
	)
	assert.ok(imported.ok)
	if (!imported.ok) return
	assert.equal(imported.servers[0].slug, 'deep-wiki')
	const draft = applyMcpImport(
		emptyMcpServerDraft(),
		imported.servers[0],
		'create'
	)
	assert.equal(draft.name, 'Deep Wiki')
	assert.equal(draft.slug, 'deep-wiki')
	const edited = applyMcpImport(
		mcpServerDraftFrom(server),
		{ ...imported.servers[0], name: 'Overwrite', slug: 'overwrite' },
		'edit'
	)
	assert.equal(edited.slug, server.slug)
	assert.equal(edited.name, server.name)
})
test('unsupported client transports and oversized imports report bounded reasons without secrets', () => {
	for (const [input, reason] of [
		[{ type: 'stdio', command: 'node', args: ['server.js'] }, 'stdio'],
		[{ type: 'sse', url: 'https://example.test/sse' }, 'sse'],
		[{ auth: { type: 'oauth' } }, 'oauth'],
		[{ url: 'https://user:private@example.test/mcp' }, 'invalid'],
	] as const)
		assert.deepEqual(parseMcpClientConfig(JSON.stringify(input)), {
			ok: false,
			reason,
		})
	assert.deepEqual(parseMcpClientConfig('x'.repeat(131_073)), {
		ok: false,
		reason: 'tooLarge',
	})
	assert.deepEqual(parseMcpClientConfig('   '), { ok: false, reason: 'empty' })
	const failure = (() => {
		try {
			mcpCreateInput({
				...createDraft(),
				url: 'https://user:PRIVATE@example.test/mcp',
			})
		} catch (error) {
			return error
		}
	})()
	assert.ok(failure instanceof McpInputError)
	assert.doesNotMatch(String(failure), /PRIVATE/u)
})
