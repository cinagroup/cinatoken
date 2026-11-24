/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { requestLogCatalogAccess } from './catalog-access'
import { createAdminRequestLogsApi } from './request-log-api'
import {
	updateRequestLogScopedFilter,
	validateRequestLogRouteSearch,
	validateRequestLogSearch,
} from './request-log-domain'

const row = {
	id: 'log-1',
	input_tokens: 1,
	output_tokens: 2,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	standard_cost: '0.100000',
	metered_cost: '0.050000',
	charged_cost: '0.200000',
	status: 'success',
	created_at: '2026-09-28T02:05:06.000Z',
	request_body: '{"model":"x"}',
	workspace_id: 'private-extra',
}
function fixture(reply: (path: string) => Response) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const cookie = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	})
	const api = createAdminRequestLogsApi({
		send: (path, schema, init, options) =>
			cookie.send(path, schema, init, options),
		invalidResponse: (message) => {
			throw new CinaTokenApiError(message ?? 'Invalid', 200, 'invalid-response')
		},
		sanitizeError: (error) =>
			error instanceof CinaTokenApiError
				? new CinaTokenApiError(
						'Console operation could not be confirmed',
						error.status,
						error.code
					)
				: new Error('Console operation could not be confirmed'),
	})
	return { api, calls }
}
function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

test('logs.read fetch projects extras and verifies server page without persistence headers', async () => {
	const { api, calls } = fixture(() =>
		json({
			success: true,
			data: [row],
			total: 1,
			page: 2,
			page_size: 50,
			access_token: 'private-extra',
		})
	)
	const search = validateRequestLogSearch({
		page: 2,
		user_id: 'user-42',
		user_email: 'a@example.test',
		start_date: '2026-09-28 00:00:00',
	})
	const result = await api.requestLogs(search)
	assert.equal(result.data[0].charged_cost, 0.2)
	assert.equal('workspace_id' in result.data[0], false)
	assert.equal('access_token' in result, false)
	assert.match(calls[0].path, /user_email=a%40example\.test/u)
	assert.match(calls[0].path, /user_id=user-42/u)
	assert.match(calls[0].path, /page_size=50/u)
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(
		calls[0].init.headers instanceof Headers
			? calls[0].init.headers.has('Authorization')
			: false,
		false
	)
})

test('separate catalog permissions do not gate logs.read and malformed pages fail closed', async () => {
	const { api, calls } = fixture((path) => {
		if (path.includes('/models') || path.includes('/routes'))
			return json({ success: false }, 403)
		if (path.includes('/providers'))
			return json({
				success: true,
				data: [{ id: 'p1', name: 'P', api_key: 'secret' }],
				count: 1,
			})
		return json({
			success: true,
			data: [row],
			total: 1,
			page: 1,
			page_size: 50,
		})
	})
	const results = await Promise.allSettled([
		api.requestLogModels(),
		api.requestLogProviders(),
		api.requestLogRoutes(),
	])
	assert.equal(results[0].status, 'rejected')
	assert.equal(results[1].status, 'fulfilled')
	assert.equal(results[2].status, 'rejected')
	if (results[1].status === 'fulfilled')
		assert.deepEqual(results[1].value, [{ id: 'p1', name: 'P' }])
	assert.equal(
		(await api.requestLogs(validateRequestLogSearch({}))).data.length,
		1
	)
	assert.equal(calls.length, 4)
	const mismatch = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 2, page_size: 50 })
	)
	await assert.rejects(
		mismatch.api.requestLogs(validateRequestLogSearch({ page: 1 })),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})

test('catalog 403 locks stay bounded per principal and clear only on explicit retry', () => {
	const store = requestLogCatalogAccess({})
	store.block('alice', 'models')
	assert.equal(store.canRead('alice', 'models'), false)
	assert.equal(store.canRead('alice', 'providers'), true)
	assert.equal(store.canRead('bob', 'models'), true)
	store.settle('alice')
	assert.equal(store.canRead('alice', 'models'), true)
})

test('MCP prefix requests reject rows outside the server and provider filter', async () => {
	const search = validateRequestLogSearch({
		provider_id: 'octafuse-mcp',
		model_id_prefix: 'mcp:qa-server/',
	})
	for (const identity of [
		{ provider_id: 'octafuse-mcp', model_id: 'mcp:qa-server/search' },
		{ provider_id: 'octafuse-mcp', model_id: 'mcp:qa-server-other/search' },
		{ provider_id: 'octafuse-tools', model_id: 'mcp:qa-server/search' },
		{ provider_id: 'octafuse-mcp', model_id: null },
	]) {
		const { api, calls } = fixture(() =>
			json({
				success: true,
				data: [{ ...row, ...identity }],
				total: 1,
				page: 1,
				page_size: 50,
				applied_filters: { model_id_prefix: search.model_id_prefix },
			})
		)
		const result = api.requestLogs(search)
		if (
			identity.provider_id === 'octafuse-mcp' &&
			identity.model_id === 'mcp:qa-server/search'
		)
			assert.equal((await result).data[0].model_id, identity.model_id)
		else
			await assert.rejects(
				result,
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		const url = new URL(calls[0].path, 'https://example.test')
		assert.equal(url.searchParams.get('model_id_prefix'), 'mcp:qa-server/')
	}
})

test('ingress API queries require every returned row to match the exact Host snapshot', async () => {
	const search = validateRequestLogSearch({
		ingress_host: 'Gateway.Example.test:8443',
		provider_id: 'octafuse-mcp',
		model_id_prefix: 'mcp:qa/',
	})
	for (const ingress_host of [
		'Gateway.Example.test:8443',
		'gateway.example.test:8443',
		'Gateway.Example.test',
		'Gateway.Example.test:8443.other',
		undefined,
		null,
	]) {
		const { api, calls } = fixture(() =>
			json({
				success: true,
				data: [
					{
						...row,
						provider_id: 'octafuse-mcp',
						model_id: 'mcp:qa/search',
						ingress_host,
					},
				],
				total: 1,
				page: 1,
				page_size: 50,
				applied_filters: {
					ingress_host: search.ingress_host,
					model_id_prefix: search.model_id_prefix,
				},
			})
		)
		const promise = api.requestLogs(search)
		if (ingress_host === search.ingress_host)
			assert.equal((await promise).data[0].ingress_host, ingress_host)
		else
			await assert.rejects(
				promise,
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		const params = new URL(calls[0].path, 'https://example.test').searchParams
		assert.equal(params.get('ingress_host'), search.ingress_host)
		assert.equal(params.get('model_id_prefix'), 'mcp:qa/')
		assert.equal(params.get('provider_id'), 'octafuse-mcp')
	}
})

test('invalid ingress filters never reach transport; clearing host retains ordinary legacy reads', async () => {
	const { api, calls } = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 1, page_size: 50 })
	)
	for (const ingress_host of [' ', 'a\tb', 'x'.repeat(256)])
		await assert.rejects(
			api.requestLogs({ ...validateRequestLogSearch({}), ingress_host })
		)
	await assert.rejects(
		api.requestLogs({ ...validateRequestLogSearch({}), invalidFilter: true })
	)
	assert.equal(calls.length, 0)
	assert.equal(
		(await api.requestLogs(validateRequestLogSearch({ ingress_host: '' })))
			.data[0].ingress_host,
		undefined
	)
	assert.equal(calls.length, 1)
})

test('host-scoped pages require an exact applied-filter acknowledgement even when all fifty rows match or the page is empty', async () => {
	const host = 'Gateway.Example.test:8443'
	const search = validateRequestLogSearch({ ingress_host: host })
	const matching = Array.from({ length: 50 }, (_, index) => ({
		...row,
		id: 'same-host-' + index,
		ingress_host: host,
	}))
	for (const data of [matching, []]) {
		for (const applied_filters of [
			undefined,
			null,
			{},
			{ ingress_host: 'gateway.example.test:8443' },
			{ ingress_host: 'Gateway.Example.test' },
			{ ingress_host: '' },
			{ ingress_host: ' ' + host },
			{ ingress_host: 42 },
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
				f.api.requestLogs(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
			assert.equal(f.calls.length, 1)
		}
		const confirmed = fixture(() =>
			json({
				success: true,
				data,
				total: data.length ? 101 : 0,
				page: 1,
				page_size: 50,
				applied_filters: { ingress_host: host },
			})
		)
		const result = await confirmed.api.requestLogs(search)
		assert.equal(result.data.length, data.length)
		assert.equal(result.total, data.length ? 101 : 0)
	}
	const emptyLegacy = fixture(() =>
		json({ success: true, data: [], total: 0, page: 1, page_size: 50 })
	)
	await assert.rejects(
		emptyLegacy.api.requestLogs(search),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	assert.equal(
		(await emptyLegacy.api.requestLogs(validateRequestLogSearch({}))).total,
		0
	)
})

test('literal prefix pages require their own exact ACK even when a full page matches or an empty page cannot prove the total scope', async () => {
	const prefix = 'mcp:Deep_Wiki%\\目录🧪/'
	const search = validateRequestLogSearch({ model_id_prefix: prefix })
	const matching = Array.from({ length: 50 }, (_, index) => ({
		...row,
		id: 'literal-' + index,
		model_id: prefix + 'search',
	}))
	for (const data of [matching, []]) {
		for (const applied_filters of [
			undefined,
			null,
			{},
			{ ingress_host: 'Gateway.Example' },
			{ model_id_prefix: prefix.toLowerCase() },
			{ model_id_prefix: prefix + 'other' },
			{ model_id_prefix: ' ' + prefix },
			{ model_id_prefix: '' },
			{ model_id_prefix: 42 },
			{ model_id_prefix: '\ud800' },
			{ model_id_prefix: 'a'.repeat(601) },
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
				f.api.requestLogs(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		}
		const confirmed = fixture(() =>
			json({
				success: true,
				data,
				total: 101,
				page: 1,
				page_size: 50,
				applied_filters: { model_id_prefix: prefix },
			})
		)
		assert.equal((await confirmed.api.requestLogs(search)).total, 101)
	}
	const legacy = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 1, page_size: 50 })
	)
	assert.equal(
		(await legacy.api.requestLogs(validateRequestLogSearch({}))).total,
		1
	)
})

test('combined host and prefix scopes require both ACKs rather than treating either as confirmation of the other', async () => {
	const search = validateRequestLogSearch({
		ingress_host: 'Gateway.Example:8443',
		model_id_prefix: 'mcp:QA/',
	})
	for (const applied_filters of [
		{ ingress_host: search.ingress_host },
		{ model_id_prefix: search.model_id_prefix },
		{
			ingress_host: search.ingress_host,
			model_id_prefix: search.model_id_prefix,
		},
	]) {
		const f = fixture(() =>
			json({
				success: true,
				data: [],
				total: 0,
				page: 1,
				page_size: 50,
				applied_filters,
			})
		)
		if (
			'ingress_host' in applied_filters &&
			'model_id_prefix' in applied_filters
		)
			assert.equal((await f.api.requestLogs(search)).total, 0)
		else
			await assert.rejects(
				f.api.requestLogs(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
	}
})

test('recoverable invalid prefix and combined URL state issue no log request, including after repairing only the host', async () => {
	const f = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 1, page_size: 50 })
	)
	for (const search of [
		validateRequestLogRouteSearch({ model_id_prefix: ' ' }),
		validateRequestLogRouteSearch({
			model_id_prefix: 'a\nb',
			ingress_host: ' ',
		}),
		updateRequestLogScopedFilter(
			validateRequestLogRouteSearch({
				model_id_prefix: ' ',
				ingress_host: ' ',
			}),
			'ingress_host',
			'Fixed.Gateway:8443'
		),
	])
		await assert.rejects(f.api.requestLogs(search))
	assert.equal(f.calls.length, 0)
	const fixed = updateRequestLogScopedFilter(
		validateRequestLogRouteSearch({ model_id_prefix: ' ' }),
		'model_id_prefix',
		''
	)
	assert.equal((await f.api.requestLogs(fixed)).data.length, 1)
	assert.equal(f.calls.length, 1)
})

test('provider sets require their own exact ACK even for empty pages, and preserve legacy unscoped reads', async () => {
	const provider_ids = 'octafuse-mcp,octafuse-tools'
	const search = validateRequestLogSearch({ provider_ids })
	for (const data of [[], [{ ...row, provider_id: 'octafuse-mcp' }]]) {
		for (const applied_filters of [
			undefined,
			{},
			{ ingress_host: 'Gateway.Test' },
			{ provider_ids: ['octafuse-mcp'] },
			{ provider_ids: ['octafuse-mcp', 'other'] },
			{ provider_ids: ['octafuse-tools', 'octafuse-mcp'] },
			{ provider_ids: [] },
			{ provider_ids: 'octafuse-mcp,octafuse-tools' },
		]) {
			const f = fixture(() =>
				json({
					success: true,
					data,
					total: 10,
					page: 1,
					page_size: 50,
					applied_filters,
				})
			)
			await assert.rejects(
				f.api.requestLogs(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		}
		const f = fixture(() =>
			json({
				success: true,
				data,
				total: 10,
				page: 1,
				page_size: 50,
				applied_filters: { provider_ids: provider_ids.split(',') },
			})
		)
		assert.equal((await f.api.requestLogs(search)).total, 10)
		assert.equal(
			new URL(f.calls[0].path, 'https://example.test').searchParams.get(
				'provider_ids'
			),
			provider_ids
		)
	}
	const legacy = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 1, page_size: 50 })
	)
	assert.equal(
		(await legacy.api.requestLogs(validateRequestLogSearch({}))).total,
		1
	)
})

test('provider-set replies must match every requested scope and the single-provider intersection', async () => {
	const search = validateRequestLogSearch({
		provider_ids: 'p2,p1',
		provider_id: 'p1',
		ingress_host: 'Gateway.Test',
		model_id_prefix: 'mcp:qa/',
	})
	const applied_filters = {
		provider_ids: ['p1', 'p2'],
		ingress_host: search.ingress_host,
		model_id_prefix: search.model_id_prefix,
	}
	const matching = {
		...row,
		provider_id: 'p1',
		ingress_host: search.ingress_host,
		model_id: 'mcp:qa/search',
	}
	for (const patch of [
		{ provider_id: 'p2' },
		{ provider_id: 'other' },
		{ provider_id: null },
		{ provider_id: undefined },
		{ ingress_host: 'other' },
		{ model_id: 'mcp:other/search' },
	]) {
		const f = fixture(() =>
			json({
				success: true,
				data: [{ ...matching, ...patch }],
				total: 1,
				page: 1,
				page_size: 50,
				applied_filters,
			})
		)
		await assert.rejects(
			f.api.requestLogs(search),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	for (const key of [
		'provider_ids',
		'ingress_host',
		'model_id_prefix',
	] as const) {
		const echo = { ...applied_filters, [key]: undefined }
		const f = fixture(() =>
			json({
				success: true,
				data: [],
				total: 0,
				page: 1,
				page_size: 50,
				applied_filters: echo,
			})
		)
		await assert.rejects(
			f.api.requestLogs(search),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const good = fixture(() =>
		json({
			success: true,
			data: [matching],
			total: 1,
			page: 1,
			page_size: 50,
			applied_filters,
		})
	)
	assert.equal((await good.api.requestLogs(search)).data[0].provider_id, 'p1')
	const disjoint = validateRequestLogSearch({
		provider_ids: 'p1,p2',
		provider_id: 'p3',
	})
	const empty = fixture(() =>
		json({
			success: true,
			data: [],
			total: 0,
			page: 1,
			page_size: 50,
			applied_filters: { provider_ids: ['p1', 'p2'] },
		})
	)
	assert.equal((await empty.api.requestLogs(disjoint)).total, 0)
})

test('invalid provider sets never dispatch and partial scope repairs cannot unblock requests', async () => {
	const f = fixture(() =>
		json({ success: true, data: [], total: 0, page: 1, page_size: 50 })
	)
	const invalid = validateRequestLogRouteSearch({
		provider_ids: ',,',
		ingress_host: ' ',
		model_id_prefix: ' ',
	})
	for (const search of [
		invalid,
		updateRequestLogScopedFilter(invalid, 'provider_ids', 'p'),
		updateRequestLogScopedFilter(invalid, 'ingress_host', 'Gateway.Test'),
		updateRequestLogScopedFilter(invalid, 'model_id_prefix', 'mcp:qa/'),
	])
		await assert.rejects(f.api.requestLogs(search))
	assert.equal(f.calls.length, 0)
})

test('request-log expectations are captured before awaiting the transport and cannot follow a mutated search object', async () => {
	for (const useOriginalResponse of [true, false]) {
		const search = validateRequestLogSearch({
			provider_ids: 'p1,p2',
			provider_id: 'p1',
			ingress_host: 'Gateway.Test',
			model_id_prefix: 'mcp:qa/',
			page: 2,
		})
		const f = fixture(() => {
			search.provider_ids = 'other'
			search.provider_id = 'other'
			search.ingress_host = 'Other.Test'
			search.model_id_prefix = 'mcp:other/'
			search.page = 3
			return json({
				success: true,
				total: 1,
				page: useOriginalResponse ? 2 : 3,
				page_size: 50,
				data: [
					{
						...row,
						provider_id: useOriginalResponse ? 'p1' : 'other',
						ingress_host: useOriginalResponse ? 'Gateway.Test' : 'Other.Test',
						model_id: useOriginalResponse
							? 'mcp:qa/search'
							: 'mcp:other/search',
					},
				],
				applied_filters: useOriginalResponse
					? {
							provider_ids: ['p1', 'p2'],
							ingress_host: 'Gateway.Test',
							model_id_prefix: 'mcp:qa/',
						}
					: {
							provider_ids: ['other'],
							ingress_host: 'Other.Test',
							model_id_prefix: 'mcp:other/',
						},
			})
		})
		if (useOriginalResponse)
			assert.equal((await f.api.requestLogs(search)).page, 2)
		else
			await assert.rejects(
				f.api.requestLogs(search),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		assert.match(f.calls[0].path, /provider_ids=p1%2Cp2/u)
		assert.match(f.calls[0].path, /page=2/u)
	}
})
