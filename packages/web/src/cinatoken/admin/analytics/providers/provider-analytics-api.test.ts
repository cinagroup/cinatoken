/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../../api'
import {
	createAdminProviderAnalyticsApi,
	providerAnalyticsPath,
	providerModelsPath,
} from './provider-analytics-api'

const start = '2026-09-28 00:00:00'
const end = '2026-09-28 08:00:00'
const metrics = {
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
	provider_id: 'provider-1',
	provider_name: 'Provider One',
	distinct_models: 1,
	...metrics,
}
const model = { model_id: 'model-1', route_group: 'default', ...metrics }

function fixture(reply: (path: string) => Response) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	})
	const api = createAdminProviderAnalyticsApi({
		send: (path, schema, init, options) =>
			transport.send(path, schema, init, options),
		invalidResponse(): never {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError(error): Error {
			return error instanceof CinaTokenApiError
				? new CinaTokenApiError(
						'Provider read failed',
						error.status,
						error.code
					)
				: new Error('Provider read failed')
		},
	})
	return { api, calls }
}

test('provider and expanded model reads share range and tag, with only supported filters', async () => {
	const { api, calls } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/providers?') ? [provider] : [model],
			tags: ['production'],
		})
	)
	const providers = await api.providerAnalytics(start, end, ' production ')
	const models = await api.providerModels(
		start,
		end,
		'provider-1',
		'production'
	)
	assert.equal(providers.rows[0]?.failover_rate, 150)
	assert.equal(models[0]?.model_id, 'model-1')
	const main = new URL(calls[0]!.path, 'https://example.test')
	const detail = new URL(calls[1]!.path, 'https://example.test')
	assert.equal(main.pathname, '/api/admin/analytics/providers')
	assert.deepEqual(Object.fromEntries(main.searchParams), {
		start_date: start,
		end_date: end,
		tag: 'production',
	})
	assert.equal(detail.pathname, '/api/admin/analytics/models')
	assert.deepEqual(Object.fromEntries(detail.searchParams), {
		start_date: start,
		end_date: end,
		tag: 'production',
		provider_id: 'provider-1',
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

test('strict DTOs discard surplus private fields from main, detail and permission reads', async () => {
	const { api } = fixture((path) =>
		Response.json(
			path.includes('/request-logs')
				? { success: true, data: [{ request_body: 'PRIVATE' }] }
				: {
						success: true,
						data: path.includes('/providers?')
							? [{ ...provider, request_body: 'PRIVATE' }]
							: [{ ...model, private_notes: 'PRIVATE' }],
						tags: ['production'],
						private_notes: 'PRIVATE',
					}
		)
	)
	const providers = await api.providerAnalytics(start, end, '')
	const models = await api.providerModels(start, end, 'provider-1', '')
	const logs = await api.providerAnalyticsLogsAccess()
	assert.equal(
		JSON.stringify({ providers, models, logs }).includes('PRIVATE'),
		false
	)
	assert.equal(logs, true)
})

test('duplicate, malformed and inconsistent aggregates fail closed', async () => {
	for (const rows of [
		[provider, provider],
		[{ ...provider, failover_rate: -1 }],
		[{ ...provider, success_count: 3 }],
	]) {
		const { api } = fixture(() =>
			Response.json({ success: true, data: rows, tags: [] })
		)
		await assert.rejects(
			api.providerAnalytics(start, end, ''),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
	const { api } = fixture(() =>
		Response.json({ success: true, data: [model, model], tags: [] })
	)
	await assert.rejects(
		api.providerModels(start, end, 'provider-1', ''),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
})

test('config and logs denial is independent from analytics read', async () => {
	const { api } = fixture((path) =>
		path.includes('/config/') || path.includes('/request-logs')
			? Response.json({ success: false }, { status: 403 })
			: Response.json({ success: true, data: [provider], tags: [] })
	)
	await assert.rejects(
		api.providerAnalyticsDisplay(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	await assert.rejects(
		api.providerAnalyticsLogsAccess(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	assert.equal((await api.providerAnalytics(start, end, '')).rows.length, 1)
})

test('range and filters reject malformed timestamps and unsupported lengths', () => {
	assert.throws(() => providerAnalyticsPath('2026-02-30 00:00:00', end, ''))
	assert.throws(() => providerAnalyticsPath('2026-01-01 00:00:00', end, ''))
	assert.throws(() => providerAnalyticsPath(start, end, 'x\ny'))
	assert.throws(() => providerModelsPath(start, end, '', ''))
	assert.equal(
		new URL(
			providerModelsPath(start, end, 'a/b', '+prod'),
			'https://example.test'
		).searchParams.get('provider_id'),
		'a/b'
	)
})
