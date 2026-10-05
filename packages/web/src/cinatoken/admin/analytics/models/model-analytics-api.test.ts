/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../../api'
import {
	createAdminModelAnalyticsApi,
	modelAnalyticsPath,
	modelProvidersPath,
} from './model-analytics-api'

const start = '2026-09-28 00:00:00'
const end = '2026-09-28 08:00:00'
const row = {
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
const provider = {
	...row,
	model_id: undefined,
	route_group: undefined,
	provider_id: 'provider-1',
	provider_name: 'Provider One',
	distinct_models: 1,
}

function fixture(reply: (path: string) => Response) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	})
	const api = createAdminModelAnalyticsApi({
		send: (path, schema, init, options) =>
			transport.send(path, schema, init, options),
		invalidResponse(): never {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError(error): Error {
			return error instanceof CinaTokenApiError
				? new CinaTokenApiError('Model read failed', error.status, error.code)
				: new Error('Model read failed')
		},
	})
	return { api, calls }
}

test('model and provider reads use same-origin Cookie paths and preserve the tag drilldown scope', async () => {
	const { api, calls } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/providers?') ? [provider] : [row],
			tags: ['production'],
		})
	)
	const models = await api.modelAnalytics(start, end, {
		tag: ' production ',
		providerId: '',
		userEmail: '',
	})
	const providers = await api.modelProviders(start, end, row, 'production')
	assert.equal(models.rows[0]?.failover_rate, 150)
	assert.equal(providers[0]?.provider_id, 'provider-1')
	const mainUrl = new URL(calls[0]!.path, 'https://example.test')
	const detailUrl = new URL(calls[1]!.path, 'https://example.test')
	assert.equal(mainUrl.pathname, '/api/admin/analytics/models')
	assert.equal(mainUrl.searchParams.get('tag'), 'production')
	assert.equal(detailUrl.pathname, '/api/admin/analytics/providers')
	assert.equal(detailUrl.searchParams.get('tag'), 'production')
	assert.equal(detailUrl.searchParams.get('model_id'), 'model-1')
	assert.equal(detailUrl.searchParams.get('route_group'), 'default')
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.method, undefined)
		const headers = new Headers(call.init.headers)
		assert.equal(headers.get('Authorization'), null)
		assert.equal(headers.get('X-CinaToken-Workspace'), null)
	}
})

test('strict DTO projection strips surplus sensitive fields from both analytics and logs responses', async () => {
	const { api } = fixture((path) =>
		Response.json(
			path.includes('/request-logs')
				? { success: true, data: [{ request_body: 'PRIVATE' }] }
				: {
						success: true,
						data: path.includes('/providers?')
							? [{ ...provider, request_body: 'PRIVATE' }]
							: [{ ...row, private_notes: 'PRIVATE' }],
						tags: ['production'],
						private_notes: 'PRIVATE',
					}
		)
	)
	const models = await api.modelAnalytics(start, end, {
		tag: '',
		providerId: '',
		userEmail: '',
	})
	const providers = await api.modelProviders(start, end, row, '')
	const allowed = await api.modelAnalyticsLogsAccess()
	assert.equal(
		JSON.stringify({ models, providers, allowed }).includes('PRIVATE'),
		false
	)
	assert.equal(allowed, true)
})

test('invalid and duplicate aggregate rows fail closed instead of showing ambiguous keys', async () => {
	for (const data of [
		[row, row],
		[{ ...row, failover_rate: -1 }],
		[{ ...row, success_count: 3 }],
	]) {
		const { api } = fixture(() =>
			Response.json({ success: true, data, tags: [] })
		)
		await assert.rejects(
			api.modelAnalytics(start, end, {
				tag: '',
				providerId: '',
				userEmail: '',
			}),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const { api } = fixture(() =>
		Response.json({ success: true, data: [provider, provider], tags: [] })
	)
	await assert.rejects(
		api.modelProviders(start, end, row, ''),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})

test('overview and logs permissions remain independent of analytics', async () => {
	const { api } = fixture((path) =>
		path.includes('/config/') || path.includes('/request-logs')
			? Response.json({ success: false }, { status: 403 })
			: Response.json({ success: true, data: [row], tags: [] })
	)
	await assert.rejects(
		api.modelAnalyticsDisplay(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	await assert.rejects(
		api.modelAnalyticsLogsAccess(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	assert.equal(
		(
			await api.modelAnalytics(start, end, {
				tag: '',
				providerId: '',
				userEmail: '',
			})
		).rows.length,
		1
	)
})

test('range and filter validation reject malformed or over-180-day requests', () => {
	assert.throws(() =>
		modelAnalyticsPath('2026-02-30 00:00:00', end, {
			tag: '',
			providerId: '',
			userEmail: '',
		})
	)
	assert.throws(() =>
		modelAnalyticsPath('2026-01-01 00:00:00', end, {
			tag: '',
			providerId: '',
			userEmail: '',
		})
	)
	assert.throws(() =>
		modelAnalyticsPath(start, end, {
			tag: 'x\ny',
			providerId: '',
			userEmail: '',
		})
	)
	assert.equal(
		new URL(
			modelProvidersPath(
				start,
				end,
				{ model_id: 'a/b', route_group: '=prod' },
				'x y'
			),
			'https://example.test'
		).searchParams.get('model_id'),
		'a/b'
	)
})
