/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { createElement } from 'react'
import { createInstance } from 'i18next'
import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { DASHBOARD_ACTIVITY_LIMIT } from '../../../../../admin/lib/dashboard-constants'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { DashboardOperations } from './DashboardOperations'
import { createAdminDashboardApi } from './dashboard-api'
import {
	DashboardCurrencyUnavailableError,
	dashboardStatsSchema,
} from './dashboard-contracts'
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

test('both dashboard reads accept additive aggregates without retaining them', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/')
				? overview
				: {
						...stats,
						futureAggregate: { current: { requests: 80 } },
						extra: 'PRIVATE',
					},
		})
	)
	const snapshots = [
		await api.dashboard({ kind: 'preset', value: '1d' }),
		await api.dashboardWindow({ kind: 'calendar', preset: 'today' }),
	]
	for (const snapshot of snapshots) {
		assert.deepEqual(snapshot.stats, stats)
		assert.equal(Object.hasOwn(snapshot.stats, 'futureAggregate'), false)
		assert.equal(JSON.stringify(snapshot).includes('PRIVATE'), false)
	}
})

test('recent summaries accept the server activity limit and reject larger or unsafe lists', async () => {
	for (const field of ['recentLogs', 'recentErrors'] as const) {
		const rows = Array.from(
			{ length: DASHBOARD_ACTIVITY_LIMIT },
			(_, index) => ({
				...safeLog,
				id: `request-${index}`,
			})
		)
		const reply = (recent: unknown[]) => (path: string) =>
			Response.json({
				success: true,
				data: path.includes('/config/')
					? overview
					: { ...stats, [field]: recent },
			})
		const { api } = fixture(reply(rows))
		assert.equal(
			(await api.dashboardWindow({ kind: 'rolling', preset: '1h' })).stats[
				field
			].length,
			DASHBOARD_ACTIVITY_LIMIT
		)
		for (const invalid of [
			[...rows, { ...safeLog, id: 'excess' }],
			rows.map((row, index) =>
				index === rows.length - 1
					? { ...row, request_body: 'PRIVATE PROMPT' }
					: row
			),
		]) {
			const { api: invalidApi } = fixture(reply(invalid))
			await assert.rejects(
				invalidApi.dashboardWindow({ kind: 'rolling', preset: '1h' }),
				(error: unknown) =>
					error instanceof CinaTokenApiError &&
					error.code === 'invalid-response'
			)
		}
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

test('calendar resolves one business-zone window before stats', async () => {
	const { api, calls } = fixture(success)
	const result = await api.dashboardWindow(
		{ kind: 'calendar', preset: 'today' },
		{},
		new Date('2026-10-23T02:13:45Z')
	)
	assert.deepEqual(result.rangeParams, {
		startUtc: '2026-10-22 16:00:00',
		endUtc: '2026-10-23 02:13:45',
	})
	assert.equal(calls[0]?.path, '/api/admin/config/overview')
	const params = new URL(calls[1]!.path, 'https://example.test').searchParams
	assert.equal(params.get('start_date'), result.rangeParams.startUtc)
	assert.equal(params.get('end_date'), result.rangeParams.endUtc)
	assert.equal(params.has('range'), false)
	assert.equal(params.get('preset'), 'today')
})

test('custom seconds are retained and invalid ranges never request stats', async () => {
	const { api, calls } = fixture(success)
	const range = {
		kind: 'custom' as const,
		startUtc: '2026-10-20 04:23:01',
		endUtc: '2026-10-20 05:23:02',
	}
	const result = await api.dashboardWindow(range)
	assert.equal(result.rangeParams.startUtc, range.startUtc)
	assert.equal(result.rangeParams.endUtc, range.endUtc)
	for (const invalid of [
		{ ...range, endUtc: range.startUtc },
		{ ...range, startUtc: '2026-02-30 00:00:00' },
		{ ...range, startUtc: '2025-01-01 00:00:00' },
	]) {
		const before = calls.length
		await assert.rejects(api.dashboardWindow(invalid))
		assert.equal(calls.length, before + 1)
	}
})

test('config denial and aborted overview prevent the window stats request', async () => {
	for (const status of [401, 403, 500]) {
		const { api, calls } = fixture(() =>
			Response.json({ error: 'denied' }, { status })
		)
		await assert.rejects(
			api.dashboardWindow({ kind: 'calendar', preset: 'today' })
		)
		assert.equal(calls.length, 1)
	}
	const controller = new AbortController()
	const { api, calls } = fixture((path) => {
		controller.abort()
		return success(path)
	})
	await assert.rejects(
		api.dashboardWindow(
			{ kind: 'rolling', preset: '1h' },
			{ signal: controller.signal }
		)
	)
	assert.equal(calls.length, 1)
})

test('invalid and duplicate business buckets are rejected', async () => {
	for (const timeseries of [
		[{ ...stats.timeseries[0], bucket: '2026-02-30 00:00:00' }],
		[stats.timeseries[0], stats.timeseries[0]],
	]) {
		const { api } = fixture((path) =>
			Response.json({
				success: true,
				data: path.includes('/config/') ? overview : { ...stats, timeseries },
			})
		)
		await assert.rejects(api.dashboardWindow({ kind: 'rolling', preset: '1h' }))
	}
})

const period = {
	requests: 80,
	success: 76,
	errors: 2,
	incomplete: 1,
	cancelled: 1,
	charged: 4,
	metered: 2,
	standard: 1,
	errorCost: 0.2,
	failoverRequests: 3,
	failoverSamples: 60,
	attemptsSamples: 60,
	avgAttempts: 1.05,
	ttftSamples: 30,
	ttftP50: 12,
	ttftP95: 50,
	latencySamples: 76,
	latencyP50: 200,
	latencyP95: 1000,
}
const operations = {
	current: period,
	previous: {
		...period,
		requests: 0,
		ttftSamples: 0,
		ttftP50: null,
		ttftP95: null,
	},
	window: {
		startDate: '2026-11-26 00:00:00',
		endDate: '2026-11-27 00:00:00',
		previousStart: '2026-11-25 00:00:00',
		previousEnd: '2026-11-26 00:00:00',
	},
	providers: [
		{ id: '', name: null, requests: 10, errors: 2, affectedUsers: 1 },
	],
	errorCategories: [{ category: 'timeout', count: 2 }],
}

test('overview operations are verified on both reads, including absent samples and unknown providers', async () => {
	const { api } = fixture((path) =>
		Response.json({
			success: true,
			data: path.includes('/config/') ? overview : { ...stats, operations },
		})
	)
	for (const snapshot of [
		await api.dashboard({ kind: 'preset', value: '1d' }),
		await api.dashboardWindow({ kind: 'calendar', preset: 'today' }),
	]) {
		assert.deepEqual(snapshot.stats.operations, operations)
		assert.equal(snapshot.stats.operations?.previous.ttftP95, null)
	}
})

test('malformed operation aggregates cannot populate the overview or relax the log privacy boundary', () => {
	for (const invalid of [
		{ ...operations, current: { ...period, ttftP95: -1 } },
		{ ...operations, current: { ...period, avgAttempts: Infinity } },
		{
			...operations,
			providers: [{ ...operations.providers[0], affectedUsers: -1 }],
		},
		{
			...operations,
			errorCategories: [{ category: 'raw-error-message', count: 1 }],
		},
		{
			...operations,
			window: { ...operations.window, previousStart: 'invalid' },
		},
	])
		assert.equal(
			dashboardStatsSchema.safeParse({ ...stats, operations: invalid }).success,
			false
		)
	assert.equal(
		dashboardStatsSchema.safeParse({
			...stats,
			operations,
			recentLogs: [{ ...safeLog, error_message: 'PRIVATE' }],
		}).success,
		false
	)
	assert.equal(dashboardStatsSchema.safeParse(stats).success, true)
})

for (const locale of ['en', 'zh', 'ja', 'ko'] as const) {
	test(`operations render verified costs, samples and scoped drilldowns in ${locale}`, () => {
		const i18n = createInstance()
		void i18n.init({
			lng: locale,
			initAsync: false,
			interpolation: { escapeValue: false },
			resources: {
				[locale]: {
					translation: {
						cinatoken: { adminDashboard: dashboardMessages[locale] },
					},
				},
			},
		})
		const snapshot = {
			stats: dashboardStatsSchema.parse({ ...stats, operations }),
			displayConfig: {
				billingCurrency: 'CNY' as const,
				currencySource: 'configured' as const,
				businessTimezone: 'Asia/Shanghai',
				timezoneSource: 'configured' as const,
			},
		}
		const html = renderToStaticMarkup(
			createElement(
				I18nextProvider,
				{ i18n },
				createElement(DashboardOperations, { snapshot, locale })
			)
		)
		assert.ok(html.includes(dashboardMessages[locale].periodComparison))
		assert.ok(html.includes(dashboardMessages[locale].costEfficiency))
		assert.ok(html.includes('×4.00'))
		assert.ok(html.includes('50.0%'))
		assert.ok(html.includes('5.0%'))
		assert.ok(html.includes('50 ms'))
		assert.ok(html.includes('—'))
		assert.ok(html.includes('status=error'))
		assert.ok(html.includes('end_date=2026-11-26+23%3A59%3A59'))
		assert.ok(html.includes('start_date=2026-11-26+00%3A00%3A00'))
		assert.equal(html.includes('cinatoken.adminDashboard.'), false)
		const without = { ...snapshot, stats: dashboardStatsSchema.parse(stats) }
		assert.equal(
			renderToStaticMarkup(
				createElement(
					I18nextProvider,
					{ i18n },
					createElement(DashboardOperations, { snapshot: without, locale })
				)
			),
			''
		)
	})
}

test('additive operations fields are projected away without rejecting verified summaries', () => {
	const parsed = dashboardStatsSchema.parse({
		...stats,
		operations: {
			...operations,
			internal: 'PRIVATE',
			current: { ...period, internal: 'PRIVATE' },
		},
	})
	assert.equal(JSON.stringify(parsed).includes('PRIVATE'), false)
	assert.deepEqual(parsed.operations, operations)
})
