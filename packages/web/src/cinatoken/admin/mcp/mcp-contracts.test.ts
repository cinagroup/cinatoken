/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { parseMcpPricingRule } from '@octafuse/core/mcp/pricing'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	mcpCatalogItemSchema,
	mcpCreateResponseSchema,
	mcpDeleteResponseSchema,
	mcpDetailResponseSchema,
	mcpIdSchema,
	mcpListResponseSchema,
	mcpPricingSchema,
	mcpServerSchema,
	mcpSlugSchema,
} from './mcp-contracts'

const server = {
	id: 'server-1',
	slug: 'deep-wiki',
	name: 'Docs',
	description: null,
	status: 'active',
	urlMasked: 'https://example.test/mcp?key=***',
	authHeaderNames: ['Authorization'],
	pricing: null,
	timeoutMs: 30_000,
	maxResponseBytes: 1_048_576,
	lastSyncedAt: null,
	lastSyncError: null,
}
test('MCP list and detail project different count contracts and discard connection secrets', () => {
	const list = mcpListResponseSchema.parse({
		success: true,
		data: [
			{
				...server,
				enabledCount: 3,
				pendingCount: 2,
				url: 'private-url',
				authHeaders: 'private-headers',
			},
		],
	})
	assert.equal(list.data[0].enabledCount, 3)
	assert.equal('url' in list.data[0], false)
	assert.equal('authHeaders' in list.data[0], false)
	const detail = mcpDetailResponseSchema.parse({
		success: true,
		data: { server, items: [] },
	})
	assert.equal('enabledCount' in detail.data.server, false)
	assert.equal(detail.data.server.pricing, null)
})
test('stored synchronization failures never expose raw upstream credentials', () => {
	const parsed = mcpServerSchema.parse({
		...server,
		lastSyncError:
			'Fetch https://upstream.invalid/?private=SECRET failed: Authorization PRIVATE',
	})
	assert.ok(parsed.lastSyncError)
	assert.doesNotMatch(parsed.lastSyncError ?? '', /SECRET|PRIVATE|upstream/u)
})
test('MCP pricing shares Core request-only parsing and preserves legacy independent prices', () => {
	for (const pricing of [
		{ v: 1, prices: { standard: 0, charged: 0.02, metered: 0.01 } },
		{ v: 2, standard: '0.1234567', chargedFactor: 1.25, meteredFactor: 0.5 },
	])
		assert.deepEqual(
			mcpPricingSchema.parse(pricing),
			parseMcpPricingRule(pricing)
		)
	for (const pricing of [
		{ v: 3 },
		{ v: 2, standard: -1 },
		{ v: 2, standard: 1, unit: 'page' },
		{ v: 2, standard: 1, chargedFactor: Infinity },
		{ v: 2, standard: 1, config: { credits: 1 } },
	])
		assert.equal(mcpPricingSchema.safeParse(pricing).success, false)
})
test('unknown catalog definitions remain inspectable without assuming object shape', () => {
	for (const definition of [
		null,
		1,
		['future'],
		'<script>provider text</script>',
		{ title: 123, future: {} },
	]) {
		const item = mcpCatalogItemSchema.parse({
			id: 'item-1',
			serverId: 'server-1',
			kind: 'resource',
			upstreamKey: 'file:///doc',
			exposedName: 'octafuse://deep-wiki/file',
			definition,
			pendingDefinition: null,
			reviewState: 'none',
			status: 'enabled',
			pricing: null,
			privateHash: 'discard',
		})
		assert.deepEqual(item.definition, definition)
		assert.equal('privateHash' in item, false)
	}
})
test('MCP identity and success schemas reject unsafe slugs, false and incomplete acknowledgements', () => {
	for (const id of ['.', '..', 'server\n', '\u200bserver'])
		assert.equal(mcpIdSchema.safeParse(id).success, false)
	for (const slug of ['builtin', 'DeepWiki', 'a/b', 'a\n', '-a', 'a-'])
		assert.equal(mcpSlugSchema.safeParse(slug).success, false)
	assert.equal(
		mcpCreateResponseSchema.safeParse({
			success: true,
			data: { id: 'server-1' },
		}).success,
		false
	)
	assert.equal(
		mcpDeleteResponseSchema.safeParse({ success: false }).success,
		false
	)
	assert.equal(
		mcpDeleteResponseSchema.safeParse({
			success: true,
			data: { id: 'unrelated' },
		}).success,
		false
	)
})

test('catalog definition and pending-definition are required even when their JSON shape is unknown', () => {
	const item = {
		id: 'item-1',
		serverId: 'server-1',
		kind: 'tool',
		upstreamKey: 'ask',
		exposedName: 'deep-wiki__ask',
		definition: {},
		pendingDefinition: null,
		reviewState: 'none',
		status: 'disabled',
		pricing: null,
	}
	assert.equal(mcpCatalogItemSchema.safeParse(item).success, true)
	for (const field of ['definition', 'pendingDefinition'] as const) {
		const missing = { ...item, [field]: undefined }
		assert.equal(mcpCatalogItemSchema.safeParse(missing).success, false)
	}
})
