/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminDashboardApi } from './dashboard-api'
import { DashboardCurrencyUnavailableError } from './dashboard-contracts'
import { dashboardMessages } from './messages'

const safeLog = {
	id: 'request-1',
	model_id: 'model-a',
	provider_id: 'provider-a',
	provider_name: 'Provider A',
	status: 'error',
	created_at: '2026-09-28T07:00:00.000Z',
}
const stats = {
	gateway: {
		activeKeysCount: 2,
		keysTotal: 3,
		keysActive: 2,
		accountsTotal: 4,
		accountsActive: 3,
		todayRequestsCount: 20,
		todayCost: 1.25,
		todayTokens: 1200,
		errorRate: 5,
	},
	kpi: {
		totalRequests: 80,
		successRate: 95,
		totalCost: 4.25,
		meteredCost: 3.5,
		standardCost: 5.5,
		activeUsers: 3,
		errorRate: 5,
		inputTokens: 900,
		outputTokens: 300,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		totalTokens: 1200,
		avgLatencyMs: 200,
		rpm: 12,
		tpm: 1000,
	},
	modelDistribution: [
		{
			model_id: 'model-a',
			request_count: 50,
			input_tokens: 600,
			output_tokens: 200,
			total_tokens: 800,
			charged_cost: 3,
			metered_cost: 2.5,
			standard_cost: 3.5,
		},
	],
	topUsers: [
		{
			user_email: 'one@example.test',
			request_count: 40,
			input_tokens: 500,
			output_tokens: 150,
			total_tokens: 650,
			charged_cost: 2,
			metered_cost: 1.5,
			standard_cost: 2.5,
		},
	],
	timeseries: [
		{
			bucket: '2026-09-28 07:00:00',
			request_count: 10,
			input_tokens: 300,
			output_tokens: 100,
			cache_read_tokens: 5,
			cache_write_tokens: 2,
			total_tokens: 400,
			charged_cost: 0.75,
			avg_latency_ms: 180,
			cache_hit_rate: 10,
		},
	],
	granularity: 'hour',
	recentLogs: [safeLog],
	recentErrors: [safeLog],
}
const overview = {
	businessTimezone: {
		value: 'Asia/Singapore',
		source: 'configured',
		revision: 'legacy',
	},
	billingCurrency: { value: 'CNY', source: 'configured', revision: 'legacy' },
	routeStrategy: { value: 'hash_affinity', source: 'missing', revision: null },
	webhooks: {
		wecom: { configured: false, revision: null },
		feishu: { configured: false, revision: null },
	},
	canWrite: false,
	canReveal: false,
}

function fixture(reply: (path: string) => Response | Promise<Response>) {
	const calls: Array<{ path: string; init: RequestInit }> = []
	const request: typeof fetch = async (path, init) => {
		calls.push({ path: String(path), init: init ?? {} })
		return reply(String(path))
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminDashboardApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Dashboard response invalid',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Dashboard read failed',
					error.status,
					error.code
				)
			return new Error('Dashboard read failed')
		},
	})
	return { api, calls }
}

const success = (path: string) =>
	Response.json({
		success: true,
		data: path.includes('/config/') ? overview : stats,
	})

test('dashboard reads only same-origin safe stats and config overview using Cookie transport', async () => {
	const { api, calls } = fixture(success)
	const result = await api.dashboard({ kind: 'preset', value: '1d' })
	assert.equal(result.stats.kpi.totalRequests, 80)
	assert.equal(result.displayConfig.billingCurrency, 'CNY')
	assert.equal(result.displayConfig.businessTimezone, 'Asia/Singapore')
	assert.deepEqual(
		calls.map((call) => call.path),
		['/api/admin/stats?range=1d', '/api/admin/config/overview']
	)
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
})

test('strict recent summary rejects upstream errors, request content and invalid UTC timestamps', async () => {
	for (const unsafe of [
		{ ...safeLog, error_message: 'PRIVATE PROMPT' },
		{ ...safeLog, request_body: '{"prompt":"PRIVATE"}' },
		{ ...safeLog, created_at: '2026-09-28 07:00:00' },
	]) {
		const { api } = fixture((path) =>
			Response.json({
				success: true,
				data: path.includes('/config/')
					? overview
					: { ...stats, recentErrors: [unsafe] },
			})
		)
		await assert.rejects(
			api.dashboard({ kind: 'preset', value: '1d' }),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})

test('stats or config permission denial rejects the entire dashboard', async () => {
	for (const deniedPath of ['/api/admin/stats', '/api/admin/config/overview']) {
		const { api } = fixture((path) =>
			path.startsWith(deniedPath)
				? Response.json({ error: 'PRIVATE ERROR' }, { status: 403 })
				: success(path)
		)
		await assert.rejects(
			api.dashboard({ kind: 'preset', value: '7d' }),
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.status === 403 &&
				!error.message.includes('PRIVATE ERROR')
		)
	}
})

test('unsupported billing currency blocks all cost-bearing dashboard data', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? {
						...overview,
						billingCurrency: {
							value: 'EUR',
							source: 'unsupported',
							revision: 'legacy',
						},
					}
				: stats,
		})
	)
	await assert.rejects(
		api.dashboard({ kind: 'preset', value: '1d' }),
		DashboardCurrencyUnavailableError
	)
})

test('invalid billing currency fallback does not label cost as USD', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? {
						...overview,
						billingCurrency: {
							value: 'USD',
							source: 'invalid',
							revision: 'legacy',
						},
					}
				: stats,
		})
	)
	await assert.rejects(
		api.dashboard({ kind: 'preset', value: '1d' }),
		DashboardCurrencyUnavailableError
	)
})

test('known USD fallback remains explicit when no currency row exists', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? {
						...overview,
						billingCurrency: {
							value: 'USD',
							source: 'missing',
							revision: null,
						},
					}
				: stats,
		})
	)
	const result = await api.dashboard({ kind: 'preset', value: '1h' })
	assert.deepEqual(
		[result.displayConfig.billingCurrency, result.displayConfig.currencySource],
		['USD', 'missing']
	)
})

test('all dashboard message dictionaries share complete keys', () => {
	const expected = Object.keys(dashboardMessages.en).sort()
	for (const locale of ['zh', 'ja', 'ko'] as const) {
		assert.deepEqual(Object.keys(dashboardMessages[locale]).sort(), expected)
		for (const value of Object.values(dashboardMessages[locale]))
			assert.ok(value.trim())
	}
})
