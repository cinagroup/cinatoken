/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminToolInvocationsApi } from './tool-invocation-api'
import { toolInvocationsResponseSchema } from './tool-invocation-contracts'
import { validateToolInvocationSearch } from './tool-invocation-domain'

const row = {
	id: 'tool-log-1',
	provider_id: 'octafuse-tools',
	model_id: 'tool:web-search',
	provider_model_name: 'bocha',
	request_body: '{"query":"cats"}',
	raw_usage: '{"result_count":1}',
	pricing_audit: null,
	user_email: 'u@example.test',
	status: 'success',
	standard_cost: '0.500000',
	charged_cost: '0.400000',
	metered_cost: '0.200000',
	latency_ms: 100,
	error_message: null,
	created_at: '2026-09-28 02:05:06',
	private_db_column: 'drop',
}
function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}
function fixture(reply: (path: string) => Response) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const cookie = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	})
	const api = createAdminToolInvocationsApi({
		send: (path, schema, init, options) =>
			cookie.send(path, schema, init, options),
		invalidResponse: (message) => {
			throw new CinaTokenApiError(message ?? 'Invalid', 200, 'invalid-response')
		},
		sanitizeError: (error) =>
			error instanceof CinaTokenApiError
				? new CinaTokenApiError('Console read failed', error.status, error.code)
				: new Error('Console read failed'),
	})
	return { api, calls }
}

test('tool DTO projects private request-log extras, normalizes decimals/SQL UTC and rejects invalid costs', () => {
	const parsed = toolInvocationsResponseSchema.parse({
		success: true,
		data: [row],
		total: 1,
		page: 1,
		page_size: 50,
		private_response_column: 'drop',
	})
	assert.equal(parsed.data[0].standard_cost, 0.5)
	assert.equal(parsed.data[0].created_at, '2026-09-28T02:05:06.000Z')
	assert.equal('private_db_column' in parsed.data[0], false)
	assert.equal('private_response_column' in parsed, false)
	for (const invalid of ['Infinity', '1e9', 'NaN', '12.1234567'])
		assert.equal(
			toolInvocationsResponseSchema.safeParse({
				success: true,
				data: [{ ...row, charged_cost: invalid }],
				total: 1,
				page: 1,
				page_size: 50,
			}).success,
			false
		)
	assert.equal(
		toolInvocationsResponseSchema.safeParse({
			success: true,
			data: [{ ...row, created_at: '2026-02-30 02:05:06' }],
			total: 1,
			page: 1,
			page_size: 50,
		}).success,
		false
	)
})

test('tool API enforces page/filter identity and config.read failure cannot block logs.read', async () => {
	const { api, calls } = fixture((path) =>
		path.includes('/config/overview')
			? json({ success: false }, 403)
			: json({ success: true, data: [row], total: 1, page: 1, page_size: 50 })
	)
	await assert.rejects(api.toolInvocationDisplay())
	const result = await api.toolInvocations(
		validateToolInvocationSearch({ tool: 'web-search' })
	)
	assert.equal(result.data[0].model_id, 'tool:web-search')
	assert.equal('private_db_column' in result.data[0], false)
	assert.equal(calls.length, 2)
	assert.equal(calls[1].init.credentials, 'same-origin')
	assert.equal(
		calls[1].init.headers instanceof Headers &&
			calls[1].init.headers.has('Authorization'),
		false
	)
	const wrong = fixture(() =>
		json({
			success: true,
			data: [{ ...row, model_id: 'tool:web-fetch' }],
			total: 1,
			page: 1,
			page_size: 50,
		})
	)
	await assert.rejects(
		wrong.api.toolInvocations(
			validateToolInvocationSearch({ tool: 'web-search' })
		),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	const pageMismatch = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 2, page_size: 50 })
	)
	await assert.rejects(
		pageMismatch.api.toolInvocations(validateToolInvocationSearch({ page: 1 })),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})

test('MCP API keeps the exact server prefix and accepts only matching MCP rows', async () => {
	const mcp = {
		...row,
		id: 'mcp-log-1',
		provider_id: 'octafuse-mcp',
		model_id: 'mcp:deep-wiki/read_docs',
		request_body: '{"name":"read_docs","arguments":{"repo":"cina/cinatoken"}}',
	}
	const search = validateToolInvocationSearch({
		source: 'mcp',
		server: 'deep-wiki',
	})
	const success = fixture(() =>
		json({
			success: true,
			data: [mcp],
			total: 1,
			page: 1,
			page_size: 50,
			applied_filters: { model_id_prefix: 'mcp:deep-wiki/' },
		})
	)
	const page = await success.api.toolInvocations(search)
	assert.equal(page.data[0].provider_id, 'octafuse-mcp')
	const params = new URL(success.calls[0].path, 'https://example.test')
		.searchParams
	assert.equal(params.get('provider_id'), 'octafuse-mcp')
	assert.equal(params.get('model_id_prefix'), 'mcp:deep-wiki/')
	for (const patch of [
		{ provider_id: 'octafuse-tools' },
		{ model_id: 'mcp:deep-wiki-other/read_docs' },
		{ model_id: 'mcp:other/read_docs' },
		{ model_id: 'tool:web-search' },
	]) {
		const wrong = fixture(() =>
			json({
				success: true,
				data: [{ ...mcp, ...patch }],
				total: 1,
				page: 1,
				page_size: 50,
				applied_filters: { model_id_prefix: 'mcp:deep-wiki/' },
			})
		)
		await assert.rejects(
			wrong.api.toolInvocations(search),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const rest = fixture(() =>
		json({ success: true, data: [mcp], total: 1, page: 1, page_size: 50 })
	)
	await assert.rejects(
		rest.api.toolInvocations(validateToolInvocationSearch({})),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})

test('invalid MCP/source filters and aborted reads send no broadened request', async () => {
	const { api, calls } = fixture(() => {
		throw new Error('must not send')
	})
	for (const search of [
		validateToolInvocationSearch({ source: 'mcp', server: '../other' }),
		validateToolInvocationSearch({ source: 'future' }),
		{ ...validateToolInvocationSearch({ source: 'mcp' }), server: 'bad/slug' },
	])
		await assert.rejects(api.toolInvocations(search))
	const controller = new AbortController()
	controller.abort()
	await assert.rejects(
		api.toolInvocations(validateToolInvocationSearch({ source: 'mcp' }), {
			signal: controller.signal,
		})
	)
	assert.equal(calls.length, 0)
})

test('MCP server reads require an exact prefix ACK for fully matching and empty pages; unscoped MCP remains legacy-compatible', async () => {
	const search = validateToolInvocationSearch({
		source: 'mcp',
		server: 'deep-wiki',
	})
	const mcp = {
		...row,
		provider_id: 'octafuse-mcp',
		model_id: 'mcp:deep-wiki/read_docs',
	}
	const matching = Array.from({ length: 50 }, (_, index) => ({
		...mcp,
		id: 'mcp-' + index,
	}))
	for (const data of [matching, []]) {
		for (const applied_filters of [
			undefined,
			{},
			{ ingress_host: 'Gateway.Example' },
			{ model_id_prefix: 'mcp:deep-wiki-other/' },
			{ model_id_prefix: 'mcp:DEEP-WIKI/' },
			{ model_id_prefix: '' },
			{ model_id_prefix: null },
		]) {
			const f = fixture(() =>
				json({
					success: true,
					data,
					total: 101,
					page: 1,
					page_size: 50,
					applied_filters,
				})
			)
			await assert.rejects(
				f.api.toolInvocations(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		}
		const exact = fixture(() =>
			json({
				success: true,
				data,
				total: 101,
				page: 1,
				page_size: 50,
				applied_filters: { model_id_prefix: 'mcp:deep-wiki/' },
			})
		)
		assert.equal((await exact.api.toolInvocations(search)).total, 101)
	}
	const allMcp = fixture(() =>
		json({ success: true, data: [mcp], total: 1, page: 1, page_size: 50 })
	)
	assert.equal(
		(
			await allMcp.api.toolInvocations(
				validateToolInvocationSearch({ source: 'mcp' })
			)
		).data.length,
		1
	)
	assert.equal(
		new URL(allMcp.calls[0].path, 'https://example.test').searchParams.has(
			'model_id_prefix'
		),
		false
	)
})

test('all tool sources require an exact provider-set ACK, including empty pages', async () => {
	const search = validateToolInvocationSearch({
			source: 'all',
			status: 'success',
		}),
		mcp = {
			...row,
			id: 'mcp-row',
			provider_id: 'octafuse-mcp',
			model_id: 'mcp:docs/read',
		}
	for (const data of [[row, mcp], []]) {
		const good = fixture(() =>
			json({
				success: true,
				data,
				total: 102,
				page: 1,
				page_size: 50,
				applied_filters: { provider_ids: ['octafuse-mcp', 'octafuse-tools'] },
			})
		)
		const result = await good.api.toolInvocations(search)
		assert.equal(result.total, 102)
		assert.equal(result.data.length, data.length)
		assert.equal(good.calls.length, 1)
		const params = new URL(good.calls[0].path, 'https://example.test')
			.searchParams
		assert.equal(params.get('provider_ids'), 'octafuse-mcp,octafuse-tools')
		assert.equal(params.has('provider_id'), false)
		for (const applied_filters of [
			undefined,
			{},
			{ provider_ids: [] },
			{ provider_ids: ['octafuse-tools'] },
			{ provider_ids: ['octafuse-tools', 'octafuse-mcp'] },
			{ provider_ids: ['octafuse-mcp', 'octafuse-tools', 'extra'] },
			{ provider_ids: ['octafuse-mcp', 'octafuse-mcp'] },
			{ provider_ids: 'octafuse-mcp,octafuse-tools' },
		]) {
			const bad = fixture(() =>
				json({
					success: true,
					data,
					total: 102,
					page: 1,
					page_size: 50,
					applied_filters,
				})
			)
			await assert.rejects(
				bad.api.toolInvocations(search),
				(e: unknown) =>
					e instanceof CinaTokenApiError && e.code === 'invalid-response'
			)
		}
	}
})

test('all sources reject foreign providers, malformed identities, mismatched status and incompatible scopes', async () => {
	const search = validateToolInvocationSearch({
		source: 'all',
		status: 'success',
	})
	for (const patch of [
		{ provider_id: 'other' },
		{ provider_id: 'octafuse-mcp', model_id: 'tool:web-search' },
		{ provider_id: 'octafuse-tools', model_id: 'mcp:docs/read' },
		{ provider_id: 'octafuse-mcp', model_id: 'mcp:docs/' },
		{ status: 'error' },
	]) {
		const f = fixture(() =>
			json({
				success: true,
				data: [{ ...row, ...patch }],
				total: 1,
				page: 1,
				page_size: 50,
				applied_filters: { provider_ids: ['octafuse-mcp', 'octafuse-tools'] },
			})
		)
		await assert.rejects(
			f.api.toolInvocations(search),
			(e: unknown) =>
				e instanceof CinaTokenApiError && e.code === 'invalid-response'
		)
	}
	const f = fixture(() => assert.fail('Invalid scope must not send'))
	for (const patch of [
		{ tool: 'web-search' },
		{ server: 'docs' },
		{ tool: ['web-search'] },
	])
		await assert.rejects(
			f.api.toolInvocations(
				validateToolInvocationSearch({ source: 'all', ...patch })
			)
		)
	assert.equal(f.calls.length, 0)
})

test('tool read checks dispatched snapshot after caller mutates search', async () => {
	const search = validateToolInvocationSearch({ source: 'all' })
	const f = fixture(() => {
		search.source = 'mcp'
		search.server = 'other'
		search.page = 9
		return json({
			success: true,
			data: [row],
			total: 1,
			page: 1,
			page_size: 50,
			applied_filters: { provider_ids: ['octafuse-mcp', 'octafuse-tools'] },
		})
	})
	assert.equal((await f.api.toolInvocations(search)).data.length, 1)
})
