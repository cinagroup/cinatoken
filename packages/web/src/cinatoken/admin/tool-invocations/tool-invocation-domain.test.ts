/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	defaultToolInvocationSearch,
	safeResultHref,
	safeToolRaw,
	safeToolText,
	toolEngine,
	toolInvocationsPath,
	toolProfitPresentation,
	toolRequestLogsHref,
	toolRequestSummary,
	toolResponseSummary,
	validateToolInvocationSearch,
} from './tool-invocation-domain'

test('UTC today fallback is a calendar day and not a rolling 24 hours', () => {
	const search = validateToolInvocationSearch({})
	const now = new Date('2026-09-29T00:15:00.000Z')
	assert.deepEqual(defaultToolInvocationSearch(search, null, now), {
		...search,
		start_date: '2026-09-29 00:00:00',
		end_date: '2026-09-29 00:15:00',
	})
	assert.deepEqual(defaultToolInvocationSearch(search, 'Asia/Singapore', now), {
		...search,
		start_date: '2026-09-28 16:00:00',
		end_date: '2026-09-29 00:15:00',
	})
})

test('all tools and one tool issue mutually exclusive request-log filters and preserve deep-link time/status', () => {
	const all = validateToolInvocationSearch({
		page: '2',
		status: 'error',
		start_date: '2026-09-28 00:00:00',
	})
	const allUrl = new URL(toolInvocationsPath(all), 'https://example.test')
	assert.equal(allUrl.searchParams.get('provider_id'), 'octafuse-tools')
	assert.equal(allUrl.searchParams.has('model_id'), false)
	assert.equal(allUrl.searchParams.get('page_size'), '50')
	assert.equal(allUrl.searchParams.get('page'), '2')
	assert.equal(allUrl.searchParams.get('status'), 'error')
	assert.equal(allUrl.searchParams.get('start_date'), '2026-09-28 00:00:00')
	assert.equal(allUrl.searchParams.has('end_date'), false)
	const one = validateToolInvocationSearch({
		tool: 'tool:ai-detection',
		status: 'success',
		end_date: '2026-09-29 23:59:59',
	})
	const oneUrl = new URL(toolInvocationsPath(one), 'https://example.test')
	assert.equal(one.tool, 'ai-detection')
	assert.equal(oneUrl.searchParams.get('model_id'), 'tool:ai-detection')
	assert.equal(oneUrl.searchParams.has('provider_id'), false)
	const drilldown = new URL(toolRequestLogsHref(one), 'https://example.test')
	assert.equal(drilldown.pathname, '/admin/request-logs')
	assert.equal(drilldown.searchParams.get('model_id'), 'tool:ai-detection')
	assert.equal(drilldown.searchParams.get('status'), 'success')
	assert.equal(drilldown.searchParams.get('end_date'), '2026-09-29 23:59:59')
	assert.equal(
		validateToolInvocationSearch({ tool: 'unknown', status: 'cancelled' }).tool,
		''
	)
})

test('query falls back to URL and engine avoids legacy tool model name', () => {
	assert.deepEqual(
		toolRequestSummary(
			'{"url":"https://example.test/page","provider":"tavily"}'
		),
		{
			query: 'https://example.test/page',
			provider: 'tavily',
		}
	)
	assert.equal(
		toolRequestSummary('{"query":"cats","url":"https://example.test"}').query,
		'cats'
	)
	assert.equal(toolRequestSummary('{broken').query, null)
	assert.equal(
		toolEngine({ model_id: 'tool:web-search', provider_model_name: 'bocha' }),
		'bocha'
	)
	assert.equal(
		toolEngine({
			model_id: 'tool:web-search',
			provider_model_name: 'tool:web-search',
			request_body: '{"provider":"tavily"}',
		}),
		'tavily'
	)
	assert.equal(
		toolEngine({
			model_id: 'tool:web-search',
			pricing_audit: '{"provider":"firecrawl"}',
		}),
		'firecrawl'
	)
})

test('results and AI detection score/segments remain available without inventing a result count', () => {
	const search = toolResponseSummary(
		'{"result_count":2,"results":[{"title":"one","url":"https://example.test"}]}'
	)
	assert.equal(search.resultCount, 2)
	assert.equal(search.results[0].title, 'one')
	const fetch = toolResponseSummary(
		'{"title":"page","url":"https://example.test/page","content_preview":"preview"}'
	)
	assert.equal(fetch.resultCount, 1)
	assert.equal(fetch.results[0].snippet, 'preview')
	const ai = toolResponseSummary(
		'{"overall_score":0.8,"segment_count":2,"segments":[{"index":0,"chars":120,"score":0.9},{"index":1,"chars":80,"score":0.7}]}'
	)
	assert.equal(ai.resultCount, null)
	assert.equal(ai.overallScore, 0.8)
	assert.equal(ai.segmentCount, 2)
	assert.deepEqual(
		ai.segments.map((segment) => segment.score),
		[0.9, 0.7]
	)
})

test('raw text/copy fallback redacts secrets; only http(s) result URLs open', () => {
	const raw = safeToolRaw(
		'{"api_key":"private-api","token":"private-root","nested":{"id_token":"private-id"},"input_tokens":42,"url":"https://example.test/?token=private-query&id_token=private-query-id&key=private-key&q=safe"}'
	)
	for (const secret of [
		'private-api',
		'private-root',
		'private-id',
		'private-query',
		'private-query-id',
		'private-key',
	])
		assert.doesNotMatch(raw ?? '', new RegExp(secret, 'u'))
	assert.match(raw ?? '', /"input_tokens": 42/u)
	assert.match(raw ?? '', /q=safe/u)
	assert.equal(
		safeToolRaw('{"token":"private-unclosed...[truncated]'),
		'[redacted: truncated log]'
	)
	assert.equal(safeToolRaw('Bearer secret'), '[redacted: malformed log]')
	const summary = toolResponseSummary(
		'{"results":[{"title":"safe","url":"https://example.test/?key=private-link&q=safe","snippet":"preview {\\"token\\":\\"private-snippet\\",\\"id_token\\":\\"private-snippet-id\\"}"}]}'
	)
	assert.doesNotMatch(summary.results[0].snippet ?? '', /private-snippet/u)
	assert.doesNotMatch(summary.results[0].url ?? '', /private-link/u)
	assert.match(summary.results[0].url ?? '', /q=safe/u)
	assert.doesNotMatch(
		safeToolText(
			'https://example.test/?id_token=private-id&token_value=private-value&key=private-key&q=safe&input_tokens=42'
		),
		/private-id|private-value|private-key/u
	)
	assert.match(
		safeToolText('https://example.test/?input_tokens=42&q=safe'),
		/input_tokens=42&q=safe/u
	)
	assert.doesNotMatch(
		safeToolText(
			'https://example.test/?%6Bey=private-encoded-key&%74oken=private-encoded-token&q=safe'
		),
		/private-encoded/u
	)
	assert.equal(
		safeResultHref(summary.results[0].url),
		'https://example.test/?key=[redacted]&q=safe'
	)
	assert.equal(
		safeResultHref(
			'https://example.test/?id_token=private-href&key=private-key&q=safe'
		),
		'https://example.test/?id_token=[redacted]&key=[redacted]&q=safe'
	)
	assert.doesNotMatch(
		safeResultHref(
			'https://example.test/?%6Bey=private-encoded-key&%74oken=private-encoded-token&q=safe'
		) ?? '',
		/private-encoded/u
	)
	assert.equal(
		safeResultHref('https://example.test/page'),
		'https://example.test/page'
	)
	assert.equal(safeResultHref('javascript:alert(1)'), null)
	assert.equal(safeResultHref('data:text/html,hello'), null)
	assert.equal(safeResultHref('https://user:pass@example.test/'), null)
})

test('hidden currency never leaks profit sign through tone or row color', () => {
	assert.deepEqual(toolProfitPresentation(-3, null), { tone: '', row: '' })
	assert.deepEqual(toolProfitPresentation(3, null), { tone: '', row: '' })
	assert.equal(toolProfitPresentation(-3, 'USD').row, 'bg-amber-500/5')
	assert.match(toolProfitPresentation(3, 'CNY').tone, /emerald/u)
})
