/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpCatalogItemSchema, mcpServerSummarySchema } from './mcp-contracts'
import {
	effectiveMcpPricing,
	filterMcpItems,
	filterMcpServers,
	mcpInvocationHref,
	mcpItemDescription,
	mcpPricingAmounts,
	newMcpItemIds,
	safeMcpJson,
	validateMcpSearch,
} from './mcp-domain'

const server = mcpServerSummarySchema.parse({
	id: 'server-1',
	slug: 'deep-wiki',
	name: 'Docs',
	description: 'Remote docs',
	status: 'active',
	urlMasked: 'https://example.test/',
	authHeaderNames: [],
	pricing: { v: 2, standard: 1, chargedFactor: 0.2, meteredFactor: 0.1 },
	timeoutMs: 30_000,
	maxResponseBytes: 1_048_576,
	lastSyncedAt: null,
	lastSyncError: null,
	enabledCount: 1,
	pendingCount: 1,
})
const item = mcpCatalogItemSchema.parse({
	id: 'item-1',
	serverId: server.id,
	kind: 'tool',
	upstreamKey: 'ask',
	exposedName: 'deep-wiki__ask',
	definition: { description: 'Search documentation' },
	pendingDefinition: null,
	reviewState: 'new',
	status: 'disabled',
	pricing: null,
})
test('enable new catalog entries excludes reviewed, changed, removed, enabled and other kinds', () => {
	const rows = [
		item,
		{ ...item, id: 'reviewed', reviewState: 'none' as const },
		{ ...item, id: 'changed', reviewState: 'changed' as const },
		{ ...item, id: 'removed', status: 'removed' as const },
		{ ...item, id: 'enabled', status: 'enabled' as const },
		{ ...item, id: 'prompt', kind: 'prompt' as const },
		{ ...item, id: 'resource', kind: 'resource' as const },
	]
	assert.deepEqual(newMcpItemIds(rows, 'tool'), [item.id])
	assert.deepEqual(newMcpItemIds(rows, 'prompt'), ['prompt'])
	assert.deepEqual(newMcpItemIds(rows, 'resource'), ['resource'])
	assert.deepEqual(newMcpItemIds([], 'tool'), [])
})
test('enable new catalog entries includes items beyond the visible page without mutating or duplicating IDs', () => {
	const rows = Object.freeze(
		Array.from({ length: 45 }, (_, index) =>
			Object.freeze({ ...item, id: `new-${index}` })
		)
	)
	const visible = filterMcpItems([...rows], {
		kind: 'tool',
		itemFilter: 'enabled',
		itemQuery: 'no matching item',
	})
	assert.deepEqual(visible, [])
	assert.deepEqual(
		newMcpItemIds([...rows, rows[0]], 'tool'),
		rows.map((row) => row.id)
	)
	assert.equal(rows[44].status, 'disabled')
	assert.equal(rows[44].reviewState, 'new')
})
test('search validation retains opaque server identity and isolates invalid targets', () => {
	assert.equal(
		validateMcpSearch({
			server: 'server-1',
			kind: 'resource',
			itemFilter: 'removed',
		}).server,
		'server-1'
	)
	assert.equal(validateMcpSearch({ server: ['server-1'] }).invalidTarget, true)
	assert.equal(validateMcpSearch({ server: 'a\n' }).invalidTarget, true)
	assert.equal(validateMcpSearch({ q: 'x'.repeat(400) }).q.length, 200)
})
test('server and catalog filters keep removed entries out of default and pending views', () => {
	const search = validateMcpSearch({ q: 'DOC', filter: 'pending' })
	assert.deepEqual(filterMcpServers([server], search), [server])
	assert.deepEqual(
		filterMcpServers([{ ...server, status: 'disabled' }], {
			q: '',
			filter: 'active',
		}),
		[]
	)
	const removed = { ...item, id: 'removed', status: 'removed' as const }
	assert.deepEqual(
		filterMcpItems(
			[item, removed],
			validateMcpSearch({ itemQuery: 'documentation' })
		),
		[item]
	)
	assert.deepEqual(
		filterMcpItems(
			[item, removed],
			validateMcpSearch({ itemFilter: 'removed' })
		),
		[removed]
	)
	assert.deepEqual(
		filterMcpItems(
			[item, removed],
			validateMcpSearch({ itemFilter: 'pending' })
		),
		[item]
	)
	assert.equal(
		mcpItemDescription({ definition: { description: 12, title: 'fallback' } }),
		'fallback'
	)
	assert.equal(mcpItemDescription({ definition: ['future'] }), '')
})
test('unknown JSON display is bounded, redacts secrets and never manufactures markup', () => {
	const shown = safeMcpJson({
		html: '<script>provider</script>',
		token: 'private',
		nested: { api_key: 'private-key' },
	})
	assert.doesNotMatch(shown, /private/u)
	assert.match(shown, /<script>/u) // Text only; React is responsible for escaping the returned string.
	assert.match(safeMcpJson('x'.repeat(262_145)), /unavailable/u)
	let deep: unknown = null
	for (let index = 0; index < 22; index++) deep = { child: deep }
	assert.match(safeMcpJson(deep), /unavailable/u)
	const circular: Record<string, unknown> = {}
	circular.self = circular
	assert.match(safeMcpJson(circular), /unavailable/u)
	assert.match(safeMcpJson(Array(20_001).fill(null)), /unavailable/u)
})
test('effective tool pricing inherits explicitly and invocation links preserve server scope', () => {
	assert.equal(effectiveMcpPricing(item, server), null)
	assert.equal(
		effectiveMcpPricing({ ...item, pricingState: 'inherit' }, server),
		server.pricing
	)
	assert.equal(
		effectiveMcpPricing({ ...item, pricingState: 'invalid' }, server),
		null
	)
	assert.equal(effectiveMcpPricing(item, { ...server, pricing: null }), null)
	assert.deepEqual(mcpPricingAmounts(server.pricing), {
		standard: 1,
		charged: 0.2,
		metered: 0.1,
	})
	assert.equal(mcpPricingAmounts(null), null)
	const url = new URL(mcpInvocationHref('deep-wiki'), 'https://example.test')
	assert.equal(url.searchParams.get('source'), 'mcp')
	assert.equal(url.searchParams.get('server'), 'deep-wiki')
	assert.throws(() => mcpInvocationHref('bad/slug'))
})

test('server search includes the public masked connection URL and keeps status filters', () => {
	const remote = {
		...server,
		urlMasked: 'https://docs.example.test/v2/mcp?token=***',
	}
	const disabled = { ...remote, id: 'disabled', status: 'disabled' as const }
	assert.deepEqual(
		filterMcpServers([remote, disabled], {
			q: ' DOCS.EXAMPLE.TEST/V2 ',
			filter: 'all',
		}),
		[remote, disabled]
	)
	assert.deepEqual(
		filterMcpServers([remote, disabled], { q: '/v2/mcp', filter: 'active' }),
		[remote]
	)
	assert.deepEqual(
		filterMcpServers([remote, disabled], { q: '/v2/mcp', filter: 'disabled' }),
		[disabled]
	)
	assert.deepEqual(
		filterMcpServers([remote], { q: 'private-credential', filter: 'all' }),
		[]
	)
	assert.equal(remote.urlMasked, 'https://docs.example.test/v2/mcp?token=***')
})

test('catalog search independently matches title and description including empty descriptions', () => {
	const row = {
		...item,
		definition: { title: 'Title Needle', description: 'Description Needle' },
	}
	for (const query of [' TITLE NEEDLE ', 'description needle'])
		assert.deepEqual(
			filterMcpItems([row], validateMcpSearch({ itemQuery: query })),
			[row]
		)
	const empty = {
		...row,
		definition: { title: 'Title Needle', description: '' },
	}
	assert.deepEqual(
		filterMcpItems([empty], validateMcpSearch({ itemQuery: 'title needle' })),
		[empty]
	)
})
test('catalog search handles unknown structures without searching nested or pending definitions', () => {
	for (const definition of [
		null,
		false,
		1,
		'private-needle',
		['private-needle'],
		{ title: 12, description: {}, nested: { title: 'private-needle' } },
	]) {
		const row = {
			...item,
			definition,
			pendingDefinition: { title: 'private-needle' },
		}
		assert.deepEqual(
			filterMcpItems([row], validateMcpSearch({ itemQuery: 'private-needle' })),
			[]
		)
		assert.deepEqual(
			filterMcpItems([row], validateMcpSearch({ itemQuery: item.upstreamKey })),
			[row]
		)
	}
})
test('catalog search covers complete sanitized text beyond the display limit without exposing credentials', () => {
	const row = {
		...item,
		definition: {
			title: 'A'.repeat(9000) + ' LateTitle',
			description:
				'B'.repeat(9000) +
				' LateDescription Bearer PRIVATE_SEARCH_SECRET https://example.invalid?token=HIDDEN_QUERY_SECRET',
		},
	}
	for (const query of ['latetitle', 'latedescription'])
		assert.deepEqual(
			filterMcpItems([row], validateMcpSearch({ itemQuery: query })),
			[row]
		)
	for (const query of ['PRIVATE_SEARCH_SECRET', 'HIDDEN_QUERY_SECRET'])
		assert.deepEqual(
			filterMcpItems([row], validateMcpSearch({ itemQuery: query })),
			[]
		)
	assert.equal(mcpItemDescription(row).length, 8192)
	assert.ok(row.definition.description.includes('PRIVATE_SEARCH_SECRET'))
})
test('title search intersects kind and review filters while preserving removed semantics', () => {
	const rows = [
		{ ...item, id: 'new', definition: { title: 'Needle' } },
		{
			...item,
			id: 'changed',
			definition: { title: 'Needle' },
			reviewState: 'changed' as const,
			status: 'enabled' as const,
		},
		{
			...item,
			id: 'reviewed',
			definition: { title: 'Needle' },
			reviewState: 'none' as const,
		},
		{
			...item,
			id: 'removed',
			definition: { title: 'Needle' },
			status: 'removed' as const,
		},
		{
			...item,
			id: 'prompt',
			definition: { title: 'Needle' },
			kind: 'prompt' as const,
		},
	]
	for (const [filter, ids] of [
		['all', ['new', 'changed', 'reviewed']],
		['pending', ['new', 'changed']],
		['enabled', ['changed']],
		['disabled', ['new', 'reviewed']],
		['removed', ['removed']],
	] as const)
		assert.deepEqual(
			filterMcpItems(
				rows,
				validateMcpSearch({ itemQuery: 'needle', itemFilter: filter })
			).map((row) => row.id),
			ids
		)
	assert.deepEqual(
		filterMcpItems(
			rows,
			validateMcpSearch({ kind: 'prompt', itemQuery: 'needle' })
		).map((row) => row.id),
		['prompt']
	)
})
test('catalog filtering searches all loaded pages and retains order and record identity', () => {
	const rows = Array.from({ length: 82 }, (_, index) =>
		Object.freeze({
			...item,
			id: `row-${index}`,
			definition: { title: index >= 40 ? 'Beyond First Page' : 'Initial' },
		})
	)
	const original = JSON.stringify(rows)
	const matched = filterMcpItems(
		rows,
		validateMcpSearch({ itemQuery: 'beyond first page' })
	)
	assert.equal(matched.length, 42)
	assert.equal(matched[0], rows[40])
	assert.equal(matched[41], rows[81])
	assert.equal(JSON.stringify(rows), original)
})
