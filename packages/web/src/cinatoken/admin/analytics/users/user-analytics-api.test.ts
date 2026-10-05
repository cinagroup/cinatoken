/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../../api'
import {
	createAdminUserAnalyticsApi,
	userAnalyticsPath,
	userModelsPath,
} from './user-analytics-api'

const start = '2026-09-28 00:00:00'
const end = '2026-09-28 08:00:00'
const user = {
	user_email: 'alice@example.test',
	request_count: 2,
	input_tokens: 100,
	output_tokens: 50,
	standard_cost: 0.6,
	charged_cost: 0.4,
	metered_cost: 0.3,
	distinct_models: 1,
	last_active_at: '2026-09-28T02:05:06.000Z',
	budget_max: 10,
	budget_spent: 15,
	budget_usage_rate: 150,
	success_rate: 50,
	error_count: 1,
}
const model = {
	model_id: 'model-1',
	route_group: 'default',
	request_count: 2,
	input_tokens: 100,
	output_tokens: 50,
	cache_read_tokens: 20,
	cache_write_tokens: 4,
	cache_hit_rate: 20,
	standard_cost: 0.6,
	charged_cost: 0.4,
	metered_cost: 0.3,
	success_count: 1,
	error_count: 1,
	success_rate: 50,
	avg_latency_ms: 100,
	avg_first_reasoning_token_ms: null,
	avg_first_token_ms: 20,
	avg_effective_ttft_ms: 20,
	avg_reasoning_phase_ms: null,
	reasoning_ttft_rate: 0,
	content_ttft_rate: 50,
	avg_upstream_response_ms: null,
	tokens_per_second: 30,
	failover_rate: 150,
	avg_attempts: 2.5,
	avg_charged_per_request: 0.2,
}

function fixture(reply: (path: string) => Response) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	})
	const api = createAdminUserAnalyticsApi({
		send: (path, schema, init, options) =>
			transport.send(path, schema, init, options),
		invalidResponse(): never {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError(error): Error {
			return error instanceof CinaTokenApiError
				? new CinaTokenApiError(
						'User analytics read failed',
						error.status,
						error.code
					)
				: new Error('User analytics read failed')
		},
	})
	return { api, calls }
}

test('main partial email search and selected-row exact model drilldown use distinct query contracts', async () => {
	const { api, calls } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/users?') ? [user] : [model],
			tags: [],
		})
	)
	const users = await api.userAnalytics(start, end, ' alice ')
	const models = await api.userModels(start, end, users[0]!.user_email)
	assert.equal(users[0]?.budget_usage_rate, 150)
	assert.equal(models[0]?.model_id, 'model-1')
	const main = new URL(calls[0]!.path, 'https://example.test')
	const detail = new URL(calls[1]!.path, 'https://example.test')
	assert.equal(main.pathname, '/api/admin/analytics/users')
	assert.deepEqual(Object.fromEntries(main.searchParams), {
		start_date: start,
		end_date: end,
		email: 'alice',
	})
	assert.equal(detail.pathname, '/api/admin/analytics/models')
	assert.deepEqual(Object.fromEntries(detail.searchParams), {
		start_date: start,
		end_date: end,
		user_email: 'alice@example.test',
	})
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.method, undefined)
		const headers = new Headers(call.init.headers)
		assert.equal(headers.get('Authorization'), null)
		assert.equal(headers.get('X-CinaToken-Workspace'), null)
	}
})

test('main, detail and permission reads project private extras away before caching', async () => {
	const { api } = fixture((path) =>
		Response.json(
			path.includes('/request-logs')
				? { success: true, data: [{ request_body: 'PRIVATE' }] }
				: {
						success: true,
						data: path.includes('/users?')
							? [{ ...user, private_notes: 'PRIVATE' }]
							: [{ ...model, request_body: 'PRIVATE' }],
						tags: [],
						private_notes: 'PRIVATE',
					}
		)
	)
	const users = await api.userAnalytics(start, end, '')
	const models = await api.userModels(start, end, user.user_email)
	const logs = await api.userAnalyticsLogsAccess()
	assert.equal(
		JSON.stringify({ users, models, logs }).includes('PRIVATE'),
		false
	)
	assert.equal(logs, true)
})

test('canonical ISO and strict legacy SQL UTC normalize safely; invalid and ambiguous times fail closed', async () => {
	for (const [input, expected] of [
		['2026-09-28T02:05:06.000Z', '2026-09-28T02:05:06.000Z'],
		['2026-09-28 02:05:06', '2026-09-28T02:05:06.000Z'],
	] as const) {
		const { api } = fixture(() =>
			Response.json({
				success: true,
				data: [{ ...user, last_active_at: input }],
			})
		)
		assert.equal(
			(await api.userAnalytics(start, end, ''))[0]?.last_active_at,
			expected
		)
	}
	for (const input of [
		'2026-02-30 02:05:06',
		'2026-09-28T02:05:06+08:00',
		'2026-09-28T02:05:06',
		'2026-09-28 02:05:06+08:00',
	]) {
		const { api } = fixture(() =>
			Response.json({
				success: true,
				data: [{ ...user, last_active_at: input }],
			})
		)
		await assert.rejects(
			api.userAnalytics(start, end, ''),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})

test('budget null, zero and over 100 percent remain distinct; invalid aggregates reject', async () => {
	const valid = [
		{
			...user,
			user_email: 'unlimited@example.test',
			budget_max: null,
			budget_usage_rate: null,
		},
		{
			...user,
			user_email: 'zero@example.test',
			budget_max: 0,
			budget_usage_rate: null,
		},
		{
			...user,
			user_email: 'unused@example.test',
			budget_spent: 0,
			budget_usage_rate: 0,
		},
		{ ...user, user_email: 'over@example.test', budget_usage_rate: 150 },
	]
	const { api } = fixture(() => Response.json({ success: true, data: valid }))
	assert.deepEqual(
		(await api.userAnalytics(start, end, '')).map(
			(row) => row.budget_usage_rate
		),
		[null, null, 0, 150]
	)
	for (const rows of [
		[user, user],
		[{ ...user, budget_max: 0, budget_usage_rate: 0 }],
		[{ ...user, budget_usage_rate: -1 }],
		[{ ...user, success_rate: 110 }],
		[{ ...user, error_count: 3 }],
		[{ ...user, user_email: ' alice@example.test ' }],
	]) {
		const failure = fixture(() => Response.json({ success: true, data: rows }))
		await assert.rejects(
			failure.api.userAnalytics(start, end, ''),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})

test('config and logs denial never turns analytics read into an authorization failure', async () => {
	const { api } = fixture((path) =>
		path.includes('/config/') || path.includes('/request-logs')
			? Response.json({ success: false }, { status: 403 })
			: Response.json({ success: true, data: [user] })
	)
	await assert.rejects(
		api.userAnalyticsDisplay(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	await assert.rejects(
		api.userAnalyticsLogsAccess(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	assert.equal((await api.userAnalytics(start, end, '')).length, 1)
})

test('bad range, filter and missing selected exact email reject before a request', () => {
	assert.throws(() => userAnalyticsPath('2026-02-30 00:00:00', end, ''))
	assert.throws(() => userAnalyticsPath('2026-01-01 00:00:00', end, ''))
	assert.throws(() => userAnalyticsPath(start, end, 'alice\nbob'))
	assert.throws(() => userModelsPath(start, end, ''))
	assert.equal(
		new URL(
			userModelsPath(start, end, 'a+b@example.test'),
			'https://example.test'
		).searchParams.get('user_email'),
		'a+b@example.test'
	)
})
