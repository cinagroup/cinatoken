/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	filterMcpClientCatalog,
	mcpClientResponseView,
	paginateMcpClientCatalog,
} from './mcp-client-catalog'

const servers = [{ slug: 'docs', name: 'Reference Library' }]
const entry = {
	name: 'docs__read',
	uri: 'https://example.invalid/guide',
	title: 'Getting Started',
	description: 'Installation instructions',
}

test('returned catalog searches server name, slug and every supported entry field with trimmed case-insensitive text', () => {
	for (const query of [
		' LIBRARY ',
		'DOCS',
		'__READ',
		'/GUIDE',
		'STARTED',
		'INSTALLATION',
	]) {
		const result = filterMcpClientCatalog(
			[entry],
			'tools/list',
			'',
			servers,
			query
		)
		assert.equal(result.total, 1)
		assert.equal(result.matched, 1)
		assert.equal(result.groups[0].name, 'Reference Library')
		assert.equal(result.groups[0].entries[0], entry)
	}
	assert.equal(
		filterMcpClientCatalog([entry], 'tools/list', '', servers, 'not-present')
			.matched,
		0
	)
})

test('returned catalog ignores non-string metadata and does not search arbitrary JSON fields', () => {
	const value = {
		name: 'docs__read',
		title: 123,
		description: { value: 'hidden' },
		privateMetadata: 'hidden',
	}
	for (const query of ['123', 'hidden', '[object Object]']) {
		assert.equal(
			filterMcpClientCatalog([value], 'tools/list', '', servers, query).matched,
			0
		)
	}
})

test('returned catalog retains existing namespace grouping and scoped or unidentified fallbacks', () => {
	const entries = [
		{
			uri: 'octafuse://docs/https%3A%2F%2Fexample.invalid%2Fguide',
			name: 'Guide',
		},
		{ uri: 'https://foreign.invalid/resource', name: 'Foreign' },
	]
	const result = filterMcpClientCatalog(
		entries,
		'resources/list',
		'fallback',
		servers,
		''
	)
	assert.deepEqual(
		result.groups.map((group) => [group.slug, group.name]),
		[
			['docs', 'Reference Library'],
			['fallback', null],
		]
	)
	assert.equal(
		filterMcpClientCatalog([{ name: 'plain' }], 'prompts/list', '', servers, '')
			.groups[0].slug,
		''
	)
})

test('returned catalog filtering and pagination preserve inputs, order and entry references', () => {
	const first = Object.freeze({ name: 'docs__a' })
	const second = Object.freeze({ name: 'other__b' })
	const third = Object.freeze({ name: 'docs__c' })
	const entries = [first, second, third]
	const before = JSON.stringify(entries)
	const result = filterMcpClientCatalog(
		entries,
		'tools/list',
		'',
		Object.freeze(servers),
		'  '
	)
	assert.deepEqual(
		result.groups.map((group) => group.entries.map((item) => item.name)),
		[['docs__a', 'docs__c'], ['other__b']]
	)
	const page = paginateMcpClientCatalog(result.groups, 1)
	assert.equal(page.groups[0].entries[0], first)
	assert.equal(JSON.stringify(entries), before)
	assert.equal(entries[1], second)
})

test('returned catalog limits a single large group to fifty entries per page and finds matches beyond the first page', () => {
	const entries = Array.from({ length: 121 }, (_, index) => ({
		name: `docs__item-${index}`,
	}))
	const result = filterMcpClientCatalog(entries, 'tools/list', '', servers, '')
	for (const [requested, count, first] of [
		[1, 50, 0],
		[2, 50, 50],
		[3, 21, 100],
	]) {
		const page = paginateMcpClientCatalog(result.groups, requested)
		assert.equal(page.groups[0].entries.length, count)
		assert.equal(page.groups[0].entries[0], entries[first])
		assert.equal(page.pages, 3)
	}
	const filtered = filterMcpClientCatalog(
		entries,
		'tools/list',
		'',
		servers,
		'ITEM-120'
	)
	assert.equal(filtered.matched, 1)
	assert.equal(filtered.total, 121)
	assert.equal(paginateMcpClientCatalog(filtered.groups, 3).page, 1)
})

test('returned catalog page budgets span groups without losing or duplicating entries', () => {
	const entries = Array.from({ length: 65 }, (_, index) => ({
		name: `${index < 35 ? 'first' : 'second'}__item-${index}`,
	}))
	const result = filterMcpClientCatalog(entries, 'tools/list', '', [], '')
	const one = paginateMcpClientCatalog(result.groups, 1)
	const two = paginateMcpClientCatalog(result.groups, 2)
	assert.deepEqual(
		one.groups.map((group) => group.entries.length),
		[35, 15]
	)
	assert.deepEqual(
		two.groups.map((group) => group.entries.length),
		[15]
	)
	assert.deepEqual(
		[...one.groups, ...two.groups].flatMap((group) => group.entries),
		entries
	)
	assert.deepEqual([one.from, one.to, two.from, two.to], [1, 50, 51, 65])
	for (const invalid of [0, -1, NaN, Infinity, 1.5])
		assert.equal(paginateMcpClientCatalog(result.groups, invalid).page, 1)
	assert.equal(paginateMcpClientCatalog(result.groups, 999).page, 2)
})

test('empty returned catalogs stay distinct from populated catalogs with no search matches', () => {
	const empty = filterMcpClientCatalog([], 'tools/list', '', servers, 'x')
	const filtered = filterMcpClientCatalog(
		[entry],
		'tools/list',
		'',
		servers,
		'x-no-match'
	)
	assert.deepEqual(
		[empty.total, empty.matched, filtered.total, filtered.matched],
		[0, 0, 1, 0]
	)
	assert.deepEqual(paginateMcpClientCatalog(empty.groups, 1), {
		groups: [],
		page: 1,
		pages: 1,
		from: 0,
		to: 0,
	})
})

test('a grouped preference falls back to raw for initialize or error responses but keeps valid empty catalogs grouped', () => {
	assert.equal(mcpClientResponseView('grouped', null), 'raw')
	assert.equal(mcpClientResponseView('grouped', []), 'grouped')
	assert.equal(mcpClientResponseView('raw', [entry]), 'raw')
})
