/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminAuditLogsApi } from './audit-log-api'
import { validateAuditLogSearch } from './audit-log-domain'

const row = {
	id: 'audit-1',
	user_id: 'user-1',
	api_key_id: null,
	event_type: 'admin_adjust',
	actor_type: 'admin',
	before_spent: 1,
	after_spent: 2,
	delta_spent: 1,
	before_budget_max: null,
	after_budget_max: 10,
	before_budget_base: 0,
	after_budget_base: 0,
	request_log_id: null,
	change_payload: '{"reason_code":"adjusted"}',
	before_user_snapshot: '{"budget_spent":1,"budget_max":null}',
	after_user_snapshot: '{"budget_spent":2,"budget_max":10}',
	changed_fields: '["budget_max"]',
	created_at: '2026-09-28T02:05:06.000Z',
	user_email: 'a@example.test',
	private_extra: 'never retain',
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
	const api = createAdminAuditLogsApi({
		send: (path, schema, init, options, reader) =>
			cookie.send(path, schema, init, options, reader),
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

test('logs.read response is projected and repeated filters use the exact API contract', async () => {
	const { api, calls } = fixture(() =>
		json({
			success: true,
			data: [row],
			total: 1,
			page: 2,
			page_size: 50,
			secret_response: 'drop',
		})
	)
	const search = validateAuditLogSearch({
		page: 2,
		event_type: ['admin_adjust', 'guardrail_redacted'],
		actor_type: ['admin', 'user'],
		reason_code: ['adjusted'],
		user_email: 'a@example.test',
	})
	const result = await api.auditLogs(search)
	assert.equal(result.data.length, 1)
	assert.equal('private_extra' in result.data[0], false)
	assert.equal('secret_response' in result, false)
	const params = new URL(calls[0].path, 'https://example.test').searchParams
	assert.deepEqual(params.getAll('event_type'), [
		'admin_adjust',
		'guardrail_redacted',
	])
	assert.deepEqual(params.getAll('actor_type'), ['admin', 'user'])
	assert.equal(params.get('user_email'), 'a@example.test')
	assert.equal(params.get('page_size'), '50')
	assert.equal(calls[0].init.credentials, 'same-origin')
	assert.equal(
		calls[0].init.headers instanceof Headers &&
			calls[0].init.headers.has('Authorization'),
		false
	)
})

test('full-filter CSV export omits list pagination and accepts only bounded CSV', async () => {
	const csv =
		'\uFEFFaudit_id,created_at_utc,user_email\r\naudit-1,2026-09-29T03:00:00.000Z,x@example.test\r\n'
	const { api, calls } = fixture(
		() =>
			new Response(csv, {
				headers: { 'Content-Type': 'text/csv; charset=utf-8' },
			})
	)
	const search = validateAuditLogSearch({
		page: 9,
		user_email: 'x@example.test',
		event_type: ['admin_adjust', 'guardrail_redacted'],
		actor_kind: ['admin_key'],
		start_date: '2026-09-28 00:00:00',
		end_date: '2026-09-29 23:59:59',
	})
	assert.deepEqual(
		new Uint8Array(await (await api.exportAuditLogs(search)).arrayBuffer()),
		new TextEncoder().encode(csv)
	)
	const call = calls[0]
	const url = new URL(call.path, 'https://example.test')
	assert.equal(url.pathname, '/api/admin/budget-audit-logs/export.csv')
	assert.equal(url.searchParams.has('page'), false)
	assert.equal(url.searchParams.has('page_size'), false)
	assert.deepEqual(url.searchParams.getAll('event_type'), [
		'admin_adjust',
		'guardrail_redacted',
	])
	assert.equal(url.searchParams.get('actor_kind'), 'admin_key')
	assert.equal(url.searchParams.get('user_email'), 'x@example.test')
	assert.equal(url.searchParams.get('start_date'), '2026-09-28 00:00:00')
	assert.equal(url.searchParams.get('end_date'), '2026-09-29 23:59:59')
	assert.equal(call.init.credentials, 'same-origin')
	assert.equal(call.init.cache, 'no-store')
	assert.equal(new Headers(call.init.headers).get('Accept'), 'text/csv')
	const wrongType = fixture(() => json({ success: true }))
	await assert.rejects(
		wrongType.api.exportAuditLogs(search),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	const wrongHeader = fixture(
		() =>
			new Response('id,not-audit\r\n', {
				headers: { 'Content-Type': 'text/csv' },
			})
	)
	await assert.rejects(
		wrongHeader.api.exportAuditLogs(search),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	const tooLarge = fixture(
		() =>
			new Response(csv, {
				headers: {
					'Content-Type': 'text/csv',
					'Content-Length': String(8 * 1024 * 1024 + 1),
				},
			})
	)
	await assert.rejects(
		tooLarge.api.exportAuditLogs(search),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	const forbidden = fixture(() => json({ success: false }, 403))
	await assert.rejects(
		forbidden.api.exportAuditLogs(search),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
})

test('reason directory, display config and audit rows are independently read and malformed pages fail closed', async () => {
	const { api, calls } = fixture((path) => {
		if (path.endsWith('/filters'))
			return json({
				success: true,
				data: { reasonCodes: ['adjusted'], private_filter: 'drop' },
			})
		if (path.includes('/config/overview')) return json({ success: false }, 403)
		return json({
			success: true,
			data: [row],
			total: 1,
			page: 1,
			page_size: 50,
		})
	})
	assert.deepEqual(await api.auditLogFilterOptions(), {
		reasonCodes: ['adjusted'],
	})
	await assert.rejects(api.auditLogDisplay())
	assert.equal((await api.auditLogs(validateAuditLogSearch({}))).data.length, 1)
	assert.equal(calls.length, 3)
	const mismatch = fixture(() =>
		json({ success: true, data: [row], total: 1, page: 2, page_size: 50 })
	)
	await assert.rejects(
		mismatch.api.auditLogs(validateAuditLogSearch({ page: 1 })),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})
