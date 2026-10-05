/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminRequestLogsApi } from './request-log-api'
import {
	requestLogsPath,
	validateRequestLogRouteSearch,
	validateRequestLogSearch,
} from './request-log-domain'
import { requestLogTargetHref } from './request-log-target'

const row = {
	id: 'request-1',
	input_tokens: 1,
	output_tokens: 2,
	cache_read_tokens: 0,
	cache_write_tokens: 0,
	metered_cost: 0.1,
	charged_cost: 0.2,
	status: 'success',
	created_at: '2026-09-30T00:00:00.000Z',
}
function fixture(
	reply: (path: string, init: RequestInit) => Promise<Response> | Response
) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const cookie = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path), init ?? {})
	})
	return {
		calls,
		api: createAdminRequestLogsApi({
			send: (path, schema, init, options) =>
				cookie.send(path, schema, init, options),
			invalidResponse: () => {
				throw new CinaTokenApiError('Invalid detail', 200, 'invalid-response')
			},
			sanitizeError: (failure) =>
				failure instanceof CinaTokenApiError
					? new CinaTokenApiError('Read failed', failure.status, failure.code)
					: new Error('Read failed'),
		}),
	}
}
test('request target is an independently validated ID and never changes list filtering or gateway-key identity', () => {
	const search = validateRequestLogSearch({
		request_id: 'request%literal',
		user_id: 'owner',
		api_key_id: 'gateway',
		page: 3,
	})
	assert.equal(search.request_id, 'request%literal')
	const query = new URL(requestLogsPath(search), 'https://example.test')
		.searchParams
	assert.equal(query.get('request_id'), null)
	assert.equal(query.get('api_key_id'), 'gateway')
	assert.equal(query.get('user_id'), 'owner')
	assert.equal(query.get('page'), '3')
	assert.equal(
		requestLogTargetHref('request%literal'),
		'/admin/request-logs?request_id=request%25literal'
	)
	for (const request_id of [
		'a/b',
		'a?b',
		'a#b',
		'a\\b',
		'a\u202e',
		'a\n',
		'a b',
		'x'.repeat(256),
		'sk-private',
		'enc:v1:private',
		'sha256:' + 'a'.repeat(64),
		'\ud800',
	]) {
		assert.throws(() => validateRequestLogSearch({ request_id }))
		assert.equal(
			validateRequestLogRouteSearch({ request_id }).invalidTarget,
			true
		)
		assert.equal(
			validateRequestLogRouteSearch({ request_id }).request_id,
			undefined
		)
	}
})
test('exact request GET projects raw bodies, errors, usage and fingerprint away before any page state', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				...row,
				workspace_id: 'workspace-1',
				api_key_id: 'gateway-1',
				provider_key_id: 'sharedkey:shared-1',
				reasoning_tokens: null,
				total_tokens: null,
				request_body: 'private',
				upstream_request_body: 'private',
				raw_usage: 'private',
				pricing_audit: 'private',
				headers: 'private',
				error_message: 'private',
				route_trace: 'private',
				timing_metadata: 'private',
				provider_key_fingerprint: 'private',
				provider_key_label: 'private',
				user_email: 'Bearer private-token',
			},
		})
	)
	const result = await api.requestLogById('request-1')
	assert.equal(calls[0].path, '/api/admin/request-logs/request-1')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(calls[0].init.cache, 'no-store')
	assert.equal(result.workspace_id, 'workspace-1')
	assert.equal(result.provider_key_id, 'sharedkey:shared-1')
	assert.equal(result.api_key_id, 'gateway-1')
	assert.equal(JSON.stringify(result).includes('private'), false)
	for (const field of [
		'request_body',
		'upstream_request_body',
		'raw_usage',
		'pricing_audit',
		'headers',
		'error_message',
		'route_trace',
		'timing_metadata',
		'provider_key_fingerprint',
		'provider_key_label',
	])
		assert.equal(field in result, false)
})
test('request detail rejects wrong ownership, invalid numbers/dates and never requests invalid IDs', async () => {
	for (const patch of [
		{ id: 'other' },
		{ created_at: '2026-02-30T00:00:00.000Z' },
		{ input_tokens: -1 },
		{ charged_cost: '0.200000' },
		{ upstream_response_ms: -1 },
	]) {
		const { api } = fixture(() =>
			Response.json({ success: true, data: { ...row, ...patch } })
		)
		await assert.rejects(
			api.requestLogById('request-1'),
			(failure: unknown) =>
				failure instanceof CinaTokenApiError &&
				failure.code === 'invalid-response'
		)
	}
	const { api, calls } = fixture(() =>
		Response.json({ success: true, data: row })
	)
	await assert.rejects(api.requestLogById('request/other'))
	assert.equal(calls.length, 0)
})
test('request detail retains status-only failures and discards responses arriving after cancellation', async () => {
	const forbidden = fixture(() =>
		Response.json(
			{ success: false, message: 'Bearer private-token' },
			{ status: 403 }
		)
	)
	await assert.rejects(
		forbidden.api.requestLogById('request-1'),
		(failure: unknown) =>
			failure instanceof CinaTokenApiError &&
			failure.status === 403 &&
			!failure.message.includes('private')
	)
	const abort = new AbortController()
	const late = fixture(() => {
		abort.abort()
		return Response.json({ success: true, data: row })
	})
	await assert.rejects(
		late.api.requestLogById('request-1', { signal: abort.signal })
	)
	assert.equal(late.calls.length, 1)
})
