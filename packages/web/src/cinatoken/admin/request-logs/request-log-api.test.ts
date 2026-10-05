/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { requestLogCatalogAccess } from './catalog-access'
import { createAdminRequestLogsApi } from './request-log-api'
import { validateRequestLogSearch } from './request-log-domain'

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
