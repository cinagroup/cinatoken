/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	mcpInvocationIdentity,
	mcpInvocationSummary,
} from './mcp-invocation-domain'
import {
	changeToolInvocationSource,
	isToolInvocationSearchValid,
	toolInvocationMatchesSearch,
	toolInvocationsPath,
	toolRequestLogsHref,
	validateToolInvocationSearch,
} from './tool-invocation-domain'

test('legacy MCP links select only that provider and the exact server prefix; REST remains the default', () => {
	const rest = new URL(
		toolInvocationsPath(validateToolInvocationSearch({})),
		'https://example.test'
	)
	assert.equal(rest.searchParams.get('provider_id'), 'octafuse-tools')
	assert.equal(rest.searchParams.has('model_id_prefix'), false)
	const search = validateToolInvocationSearch({
		source: 'mcp',
		server: 'deep-wiki',
		tool: 'web-search',
		page: '2',
		status: 'error',
		start_date: '2026-10-01 00:00:00',
	})
	assert.equal(search.tool, '')
	for (const path of [
		toolInvocationsPath(search),
		toolRequestLogsHref(search),
	]) {
		const url = new URL(path, 'https://example.test')
		assert.equal(url.searchParams.get('provider_id'), 'octafuse-mcp')
		assert.equal(url.searchParams.get('model_id_prefix'), 'mcp:deep-wiki/')
		assert.equal(url.searchParams.has('model_id'), false)
		assert.equal(url.searchParams.get('status'), 'error')
		assert.equal(url.searchParams.get('start_date'), '2026-10-01 00:00:00')
	}
	const allMcp = new URL(
		toolInvocationsPath(validateToolInvocationSearch({ source: 'mcp' })),
		'https://example.test'
	)
	assert.equal(allMcp.searchParams.get('provider_id'), 'octafuse-mcp')
	assert.equal(allMcp.searchParams.has('model_id_prefix'), false)
})

test('source changes clear incompatible tool/server filters and pagination, keeping time and status', () => {
	const initial = validateToolInvocationSearch({
		tool: 'web-search',
		status: 'success',
		page: 8,
		end_date: '2026-10-01 00:00:00',
	})
	const mcp = changeToolInvocationSource(initial, 'mcp')
	assert.equal(mcp.source, 'mcp')
	assert.equal(mcp.tool, '')
	assert.equal(mcp.server, '')
	assert.equal(mcp.page, 1)
	assert.equal(mcp.status, 'success')
	assert.equal(mcp.end_date, initial.end_date)
	const rest = changeToolInvocationSource(
		{ ...mcp, server: 'deep-wiki', invalidFilter: true },
		'rest'
	)
	assert.equal(rest.source, 'rest')
	assert.equal(rest.server, '')
	assert.equal(rest.tool, '')
	assert.equal(rest.invalidFilter, undefined)
	assert.equal(isToolInvocationSearchValid(rest), true)
})

test('invalid explicit sources and server slugs fail closed instead of expanding history', () => {
	for (const server of [
		'DeepWiki',
		'a/b',
		'a&provider_id=x',
		'-a',
		'a-',
		'a'.repeat(41),
		'a\n',
		['a'],
		1,
	]) {
		const search = validateToolInvocationSearch({ source: 'mcp', server })
		assert.equal(search.invalidFilter, true)
		assert.equal(isToolInvocationSearchValid(search), false)
		assert.throws(() => toolInvocationsPath(search), TypeError)
		assert.throws(() => toolRequestLogsHref(search), TypeError)
		assert.equal(validateToolInvocationSearch(search).invalidFilter, true)
	}
	for (const source of ['future', ['mcp'], 1, null]) {
		const search = validateToolInvocationSearch({ source })
		assert.equal(search.invalidFilter, true)
		assert.throws(() => toolInvocationsPath(search), TypeError)
	}
	assert.equal(
		isToolInvocationSearchValid(
			validateToolInvocationSearch({ source: 'mcp', server: 'a'.repeat(40) })
		),
		true
	)
	assert.equal(
		isToolInvocationSearchValid({
			page: 1,
			tool: '',
			status: '',
			source: 'mcp',
			server: 'bad/slug',
		}),
		false
	)
})

test('MCP response identity rejects a neighboring server, a REST row and mismatched status', () => {
	const search = validateToolInvocationSearch({
		source: 'mcp',
		server: 'deep-wiki',
		status: 'success',
	})
	const row = {
		provider_id: 'octafuse-mcp',
		model_id: 'mcp:deep-wiki/ask/docs',
		status: 'success',
	}
	assert.equal(toolInvocationMatchesSearch(row, search), true)
	for (const patch of [
		{ model_id: 'mcp:deep-wiki-other/ask' },
		{ model_id: 'mcp:deep-wiki2/ask' },
		{ model_id: 'mcp:deep-wiki/' },
		{ model_id: 'tool:web-search' },
		{ provider_id: 'octafuse-tools' },
		{ status: 'error' },
	])
		assert.equal(
			toolInvocationMatchesSearch({ ...row, ...patch }, search),
			false
		)
	assert.equal(
		toolInvocationMatchesSearch(row, validateToolInvocationSearch({})),
		false
	)
	assert.deepEqual(mcpInvocationIdentity('mcp:deep-wiki/ask/docs'), {
		slug: 'deep-wiki',
		tool: 'ask/docs',
	})
})

test('MCP arguments use the real name/arguments contract with bounded redacted nested values', () => {
	const summary = mcpInvocationSummary({
		model_id: 'mcp:deep-wiki/model-fallback',
		request_body: JSON.stringify({
			name: 'read_docs',
			arguments: {
				repo: 'cina/cinatoken',
				options: { access_token: 'private-nested', n: 1 },
				text: 'x'.repeat(200),
				ignored: 'fourth-argument',
			},
		}),
	})
	assert.equal(summary.slug, 'deep-wiki')
	assert.equal(summary.tool, 'read_docs')
	assert.equal(summary.label, 'deep-wiki / read_docs')
	assert.match(summary.argumentSummary ?? '', /repo=cina\/cinatoken/u)
	assert.match(summary.argumentSummary ?? '', /\[redacted\]/u)
	assert.doesNotMatch(
		summary.argumentSummary ?? '',
		/private-nested|fourth-argument/u
	)
	assert.ok((summary.argumentSummary?.length ?? 0) <= 485)
	const credentials = mcpInvocationSummary({
		request_body: JSON.stringify({
			arguments: {
				token: 'private',
				key: 'private-key',
				url: 'https://example.test/?token=private-url&q=safe',
			},
		}),
	})
	assert.doesNotMatch(credentials.argumentSummary ?? '', /private/u)
	assert.match(credentials.argumentSummary ?? '', /q=safe/u)
	const oversizedArguments = mcpInvocationSummary({
		request_body: JSON.stringify({
			arguments: {
				['first'.repeat(20)]: 'a'.repeat(200),
				['second'.repeat(20)]: 'b'.repeat(200),
				['third'.repeat(20)]: 'c'.repeat(200),
				ignored: 'fourth-argument',
			},
		}),
	})
	const bounded = oversizedArguments.argumentSummary ?? ''
	const parts = bounded.split(' ')
	assert.equal(parts.length, 3)
	for (const part of parts) {
		const separator = part.indexOf('=')
		assert.ok(separator > 0 && separator <= 80)
		assert.ok(part.slice(separator + 1).length <= 80)
	}
	assert.ok(bounded.length <= 3 * (80 + 1 + 80) + 2)
	assert.doesNotMatch(bounded, /fourth-argument/u)
})

test('truncated and malformed MCP payloads retain only the model identity, with no fabricated result summary', () => {
	for (const raw of [
		'{broken',
		'{"name":"leak","arguments":{"token":"secret...[truncated]',
		'[]',
		'null',
	]) {
		const summary = mcpInvocationSummary({
			model_id: 'mcp:deep-wiki/echo',
			request_body: raw,
		})
		assert.equal(summary.label, 'deep-wiki / echo')
		assert.equal(summary.argumentSummary, null)
	}
	const oversizedName = mcpInvocationSummary({
		model_id: 'mcp:deep-wiki/echo',
		request_body: JSON.stringify({ name: 'x'.repeat(1000) }),
	})
	assert.ok(oversizedName.tool && oversizedName.tool.length <= 256)
	assert.match(oversizedName.tool ?? '', /^x+…$/u)
})

test('all sources preserve time/status, reset incompatible scope, and link to the same provider set', () => {
	const before = validateToolInvocationSearch({
			source: 'mcp',
			server: 'docs',
			page: 4,
			status: 'error',
			start_date: '2026-10-23 00:00:00',
			end_date: '2026-10-23 12:00:00',
		}),
		all = changeToolInvocationSource(before, 'all')
	assert.equal(all.page, 1)
	assert.equal(all.tool, '')
	assert.equal(all.server, '')
	assert.equal(all.status, 'error')
	assert.equal(all.start_date, before.start_date)
	assert.equal(all.end_date, before.end_date)
	for (const path of [toolInvocationsPath(all), toolRequestLogsHref(all)]) {
		const p = new URL(path, 'https://example.test').searchParams
		assert.equal(p.get('provider_ids'), 'octafuse-mcp,octafuse-tools')
		assert.equal(p.has('provider_id'), false)
		assert.equal(p.has('model_id_prefix'), false)
		assert.equal(p.has('model_id'), false)
		assert.equal(p.get('status'), 'error')
	}
	for (const source of ['rest', 'mcp'] as const)
		assert.equal(
			new URL(
				toolInvocationsPath(changeToolInvocationSource(all, source)),
				'https://example.test'
			).searchParams.has('provider_ids'),
			false
		)
	assert.equal(validateToolInvocationSearch({}).source, 'rest')
})

test('MCP compact summaries retain large integers, decimal tails and exponent tokens', () => {
	const summary = mcpInvocationSummary({
		model_id: 'mcp:docs/fallback',
		request_body:
			'{"name":"exact","arguments":{"id":9007199254740993,"price":0.123456789012345678901,"large":1E+400}}',
	})
	assert.equal(summary.label, 'docs / exact')
	assert.equal(
		summary.argumentSummary,
		'id=9007199254740993 price=0.123456789012345678901 large=1E+400'
	)
})

test('MCP nested argument summaries preserve types and ordinary raw-shaped objects', () => {
	const summary = mcpInvocationSummary({
		request_body:
			'{"arguments":{"nested":{"n":9007199254740993,"s":"9007199254740993"},"array":[-0,1e400,"1e400"],"raw":{"raw":"1e400"}}}',
	})
	assert.equal(
		summary.argumentSummary,
		'nested={"n":9007199254740993,"s":"9007199254740993"} array=[-0,1e400,"1e400"] raw={"raw":"1e400"}'
	)
})

test('MCP summaries redact numeric credentials while preserving neighboring exact values', () => {
	const summary = mcpInvocationSummary({
		request_body:
			'{"arguments":{"token":9007199254740993,"options":{"password":9007199254740994,"count":9007199254740995},"url":"https://example.test/?token=private-value&q=safe"}}',
	})
	assert.doesNotMatch(
		summary.argumentSummary ?? '',
		/9007199254740993|9007199254740994|private-value/u
	)
	assert.match(summary.argumentSummary ?? '', /9007199254740995/u)
	assert.match(summary.argumentSummary ?? '', /\[redacted\]/u)
	assert.match(summary.argumentSummary ?? '', /q=safe/u)
})

test('MCP summaries do not interpret numeric roots or numeric arguments as objects', () => {
	for (const request_body of [
		'1e400',
		'9007199254740993',
		'{"name":9007199254740993,"arguments":1e400}',
	]) {
		const summary = mcpInvocationSummary({
			model_id: 'mcp:docs/fallback',
			request_body,
		})
		assert.equal(summary.label, 'docs / fallback')
		assert.equal(summary.argumentSummary, null)
	}
})
