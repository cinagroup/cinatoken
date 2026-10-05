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
