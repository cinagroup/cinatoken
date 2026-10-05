/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	createAdminReliabilityApi,
	reliabilityRequestPath,
} from './reliability-api'

const startUtc = '2026-09-28 00:00:00'
const endUtc = '2026-09-28 08:00:00'
const provider = {
	provider_id: 'provider-1',
	provider_name: 'Provider One',
	request_count: 2,
	success_count: 1,
	error_count: 1,
	success_rate: 50,
	avg_latency_ms: 120,
	avg_upstream_response_ms: null,
	failover_rate: 150,
	avg_attempts: 2.5,
	standard_cost: 0.5,
	charged_cost: 0.4,
	metered_cost: 0.3,
}
const modelProvider = {
	model_id: 'model-1',
	provider_id: 'provider-1',
	provider_name: 'Provider One',
	request_count: 2,
	success_rate: 50,
	avg_latency_ms: 120,
	avg_upstream_response_ms: null,
	failover_rate: 150,
	avg_attempts: 2.5,
	standard_cost: 0.5,
	charged_cost: 0.4,
	metered_cost: 0.3,
}
const recentError = {
	id: 'request-1',
	model_id: 'model-1',
	provider_id: 'provider-1',
	provider_name: 'Provider One',
	status: 'error',
	created_at: '2026-09-28T07:00:00.000Z',
}
const overview = {
	businessTimezone: {
		value: 'Asia/Singapore',
		source: 'configured',
		revision: 'legacy',
	},
	billingCurrency: { value: 'CNY', source: 'configured', revision: 'legacy' },
	webhooks: { secret: 'PRIVATE' },
}

function fixture(reply: (path: string) => Response | Promise<Response>) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const request: typeof fetch = async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminReliabilityApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Reliability read failed',
					error.status,
					error.code
				)
			return new Error('Reliability read failed')
		},
	})
	return { api, calls }
}

const success = (path: string) =>
	Response.json({
		success: true,
		data: path.includes('/config/')
			? overview
			: {
					providers: [provider],
					modelProviders: [modelProvider],
					recentErrors: [recentError],
				},
	})

test('reliability uses only same-origin Cookie reads and validates UTC range', async () => {
	const { api, calls } = fixture(success)
	const result = await api.reliability(startUtc, endUtc)
	assert.equal(result.providers[0]?.failover_rate, 150)
	assert.equal((await api.display()).currency, 'CNY')
	assert.equal(
		calls[0]?.path,
		'/api/admin/analytics/reliability?start_date=2026-09-28+00%3A00%3A00&end_date=2026-09-28+08%3A00%3A00'
	)
	assert.equal(calls[1]?.path, '/api/admin/config/overview')
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.method, undefined)
		const headers = new Headers(call.init.headers)
		for (const name of [
			'Authorization',
			'New-Api-User',
			'X-CinaToken-Workspace',
		])
			assert.equal(headers.get(name), null)
	}
	assert.throws(() => reliabilityRequestPath('2026-02-30 00:00:00', endUtc))
	assert.throws(() => reliabilityRequestPath(endUtc, startUtc))
	assert.throws(() => reliabilityRequestPath('2026-01-01 00:00:00', endUtc))
})

test('DTO projection strips accidentally exposed request and config secrets before query cache', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? overview
				: {
						providers: [{ ...provider, private_notes: 'PRIVATE' }],
						modelProviders: [{ ...modelProvider, request_body: 'PRIVATE' }],
						recentErrors: [
							{
								...recentError,
								error_message: 'PRIVATE',
								request_body: 'PRIVATE',
							},
						],
					},
		})
	)
	const result = await api.reliability(startUtc, endUtc)
	const display = await api.display()
	assert.equal(JSON.stringify({ result, display }).includes('PRIVATE'), false)
	assert.deepEqual(
		Object.keys(result.recentErrors[0] ?? {}).sort(),
		[
			'created_at',
			'id',
			'model_id',
			'provider_id',
			'provider_name',
			'status',
		].sort()
	)
	assert.deepEqual(display, {
		timezone: 'Asia/Singapore',
		timezoneSource: 'configured',
		currency: 'CNY',
		currencySource: 'configured',
	})
})

test('unverified currency is hidden independently of timezone and analytics', async () => {
	for (const source of ['invalid', 'unsupported'] as const) {
		const { api } = fixture((path) =>
			Response.json({
				success: true,
				data: path.includes('/config/')
					? {
							...overview,
							billingCurrency: {
								value: source === 'invalid' ? 'USD' : 'EUR',
								source,
							},
						}
					: {
							providers: [provider],
							modelProviders: [modelProvider],
							recentErrors: [],
						},
			})
		)
		const display = await api.display()
		assert.equal(display.timezone, 'Asia/Singapore')
		assert.equal(display.currency, null)
		assert.equal((await api.reliability(startUtc, endUtc)).providers.length, 1)
	}
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? {
						...overview,
						businessTimezone: { value: 'UTC', source: 'missing' },
						billingCurrency: { value: 'USD', source: 'missing' },
					}
				: { providers: [], modelProviders: [], recentErrors: [] },
		})
	)
	assert.deepEqual(await api.display(), {
		timezone: 'UTC',
		timezoneSource: 'missing',
		currency: 'USD',
		currencySource: 'missing',
	})
})

test('config permission failure does not invalidate independent analytics read', async () => {
	const { api } = fixture((path) =>
		path.includes('/config/')
			? Response.json({ success: false }, { status: 403 })
			: success(path)
	)
	await assert.rejects(
		api.display(),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 403
	)
	assert.equal((await api.reliability(startUtc, endUtc)).providers.length, 1)
})

test('malformed required aggregate or recent timestamp fails closed', async () => {
	for (const data of [
		{
			providers: [{ ...provider, success_count: 3 }],
			modelProviders: [],
			recentErrors: [],
		},
		{
			providers: [],
			modelProviders: [modelProvider],
			recentErrors: [{ ...recentError, created_at: '2026-09-28 07:00:00' }],
		},
		{
			providers: [],
			modelProviders: [modelProvider],
			recentErrors: [
				{ ...recentError, created_at: '2026-02-30T07:00:00.000Z' },
			],
		},
	]) {
		const { api } = fixture(() => Response.json({ success: true, data }))
		await assert.rejects(
			api.reliability(startUtc, endUtc),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})
