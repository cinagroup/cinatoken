/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { createAdminConfigApi } from './config-api'
import {
	ConfigTimezoneInputError,
	ConfigWebhookInputError,
	normalizeBusinessTimezoneWrite,
	normalizeWebhookWrite,
} from './config-contracts'

const revision = '11111111-1111-4111-8111-111111111111'
const safeOverview = {
	businessTimezone: {
		value: 'Asia/Singapore',
		source: 'configured',
		revision: 'legacy',
	},
	billingCurrency: { value: 'CNY', source: 'configured', revision },
	routeStrategy: {
		value: 'weighted_random',
		source: 'configured',
		revision: 'legacy',
	},
	webhooks: {
		wecom: { configured: true, revision },
		feishu: { configured: false, revision: null },
	},
	canWrite: true,
	canReveal: false,
}
type Call = { path: string; init: RequestInit }

function fixture(reply: (call: Call) => Promise<Response>) {
	const calls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		return reply(call)
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminConfigApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Configuration response is invalid',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Configuration request failed',
					error.status,
					error.code
				)
			return new Error('Configuration request failed')
		},
	})
	return { api, calls }
}

test('overview strips unexpected secret fields and uses only same-origin Cookie context', async () => {
	const secret = 'https://example.test/webhook?key=PRIVATE'
	const { api, calls } = fixture(async () =>
		Response.json({
			success: true,
			data: {
				...safeOverview,
				webhooks: {
					wecom: { configured: true, revision, rawUrl: secret },
					feishu: { configured: false, revision: null },
				},
				rawSystemConfig: [{ key: 'PRIVATE_WEBHOOK', value: secret }],
			},
		})
	)
	const result = await api.configOverview({
		timeoutMs: 500,
		expectedWorkspaceId: 'PRIVATE',
	} as never)
	assert.deepEqual(result, safeOverview)
	assert.equal(JSON.stringify(result).includes(secret), false)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.path, '/api/admin/config/overview')
	assert.equal(calls[0]!.init.credentials, 'same-origin')
	assert.equal(calls[0]!.init.cache, 'no-store')
	const headers = new Headers(calls[0]!.init.headers)
	assert.equal(headers.get('Accept'), 'application/json')
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(headers.get(name), null)
})

test('fixed-key non-secret writes require exact confirmed projection and do not call generic config GET', async () => {
	const { api, calls } = fixture(async ({ path }) =>
		path.endsWith('billing-currency')
			? Response.json({
					success: true,
					data: {
						billingCurrency: {
							value: 'CNY',
							source: 'configured',
							revision,
							secret: 'SHOULD_STRIP',
						},
					},
				})
			: Response.json({
					success: true,
					data: {
						routeStrategy: {
							value: 'weighted_random',
							source: 'configured',
							revision,
							secret: 'SHOULD_STRIP',
						},
					},
				})
	)
	assert.deepEqual(await api.updateBillingCurrency('CNY', 'legacy'), {
		value: 'CNY',
		source: 'configured',
		revision,
	})
	assert.deepEqual(await api.updateRouteStrategy('weighted_random', null), {
		value: 'weighted_random',
		source: 'configured',
		revision,
	})
	assert.deepEqual(
		calls.map((call) => [
			call.path,
			call.init.method,
			JSON.parse(String(call.init.body)),
		]),
		[
			['/api/admin/config/billing-currency', 'PUT', { value: 'CNY' }],
			['/api/admin/config/route-strategy', 'PUT', { value: 'weighted_random' }],
		]
	)
	assert.equal(new Headers(calls[0]!.init.headers).get('If-Match'), '"legacy"')
	assert.equal(new Headers(calls[0]!.init.headers).get('If-None-Match'), null)
	assert.equal(new Headers(calls[1]!.init.headers).get('If-None-Match'), '*')
	assert.equal(new Headers(calls[1]!.init.headers).get('If-Match'), null)
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(new Headers(call.init.headers).get('Authorization'), null)
		assert.equal(
			new Headers(call.init.headers).get('X-CinaToken-Workspace'),
			null
		)
	}
	await assert.rejects(
		api.updateBillingCurrency('EUR' as never, revision),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	await assert.rejects(
		api.updateRouteStrategy('round_robin' as never, revision),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	assert.equal(calls.length, 2)
})

test('mismatched write echo and malformed responses fail closed with no automatic retry', async () => {
	for (const [operation, data] of [
		[
			(api: ReturnType<typeof fixture>['api']) =>
				api.updateBillingCurrency('CNY', revision),
			{ billingCurrency: { value: 'USD', source: 'configured', revision } },
		],
		[
			(api: ReturnType<typeof fixture>['api']) =>
				api.updateRouteStrategy('weighted_random', revision),
			{
				routeStrategy: {
					value: 'hash_affinity',
					source: 'configured',
					revision,
				},
			},
		],
	] as const) {
		const { api, calls } = fixture(async () =>
			Response.json({ success: true, data })
		)
		await assert.rejects(
			operation(api),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
		assert.equal(calls.length, 1)
	}
})

test('webhook replace, clear, reveal and verify are per-channel and secret is never copied into parsed status', async () => {
	const secret = 'https://qyapi.weixin.qq.com/hook?token=PRIVATE'
	const { api, calls } = fixture(async ({ path, init }) => {
		if (path.endsWith('/reveal'))
			return Response.json({
				success: true,
				data: { channel: 'wecom', value: secret, extraneous: secret },
			})
		if (path.endsWith('/verify'))
			return Response.json({
				success: true,
				data: {
					channel: 'wecom',
					matched: true,
					configured: true,
					value: secret,
				},
			})
		return Response.json({
			success: true,
			data: {
				webhook: {
					configured: init.method !== 'DELETE',
					revision,
					value: secret,
				},
			},
		})
	})
	await api.replaceWebhook('wecom', ` ${secret} `, 'legacy')
	assert.equal(await api.revealWebhook('wecom'), secret)
	assert.deepEqual(await api.verifyWebhook('wecom', secret), {
		matched: true,
		configured: true,
	})
	await api.clearWebhook('feishu', null)
	assert.deepEqual(
		calls.map((call) => [call.path, call.init.method ?? 'GET']),
		[
			['/api/admin/config/webhooks/wecom', 'PUT'],
			['/api/admin/config/webhooks/wecom/reveal', 'GET'],
			['/api/admin/config/webhooks/wecom/verify', 'POST'],
			['/api/admin/config/webhooks/feishu', 'DELETE'],
		]
	)
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { value: secret })
	assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { value: secret })
	assert.equal(new Headers(calls[0]!.init.headers).get('If-Match'), '"legacy"')
	assert.equal(new Headers(calls[3]!.init.headers).get('If-None-Match'), '*')
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(new Headers(call.init.headers).get('Authorization'), null)
		assert.equal(
			new Headers(call.init.headers).get('X-CinaToken-Workspace'),
			null
		)
	}
})

test('invalid webhook URL and unexpected channel never reach transport, and server errors do not expose URL', async () => {
	const secret = 'https://qyapi.weixin.qq.com/hook?token=PRIVATE'
	for (const value of [
		'',
		'http://qyapi.weixin.qq.com/hook',
		'https://user:pass@qyapi.weixin.qq.com/hook',
		'https://qyapi.weixin.qq.com/hook#frag',
		'https://qyapi.weixin.qq.com/\nprivate',
		'https://qyapi.weixin.qq.com:8443/hook',
		'https://example.test/hook',
		'x'.repeat(2049),
	]) {
		assert.throws(
			() => normalizeWebhookWrite('wecom', value),
			ConfigWebhookInputError
		)
	}
	assert.equal(
		normalizeWebhookWrite(
			'feishu',
			'https://open.feishu.cn/hook?token=PRIVATE'
		),
		'https://open.feishu.cn/hook?token=PRIVATE'
	)
	const { api, calls } = fixture(async () =>
		Response.json({ success: false, message: secret }, { status: 503 })
	)
	await assert.rejects(
		api.replaceWebhook('wecom', secret, revision),
		(error: unknown) => {
			assert.equal(String(error).includes(secret), false)
			return error instanceof CinaTokenApiError && error.status === 503
		}
	)
	await assert.rejects(
		api.revealWebhook('other' as never),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	assert.equal(calls.length, 1)
})

test('valid legacy and unsupported states remain visible; contradictory or incomplete responses fail closed', async () => {
	const legacy = {
		...safeOverview,
		businessTimezone: { value: 'EST', source: 'legacy', revision: 'legacy' },
		billingCurrency: { value: 'EUR', source: 'unsupported', revision },
		routeStrategy: { value: 'hash_affinity', source: 'invalid', revision },
	}
	assert.deepEqual(
		await fixture(async () =>
			Response.json({ success: true, data: legacy })
		).api.configOverview(),
		legacy
	)
	for (const data of [
		{ ...safeOverview, canWrite: undefined },
		{
			...safeOverview,
			businessTimezone: {
				...safeOverview.businessTimezone,
				revision: 'https://example.test/secret',
			},
		},
		{
			...safeOverview,
			webhooks: { ...safeOverview.webhooks, wecom: { configured: true } },
		},
		{
			...safeOverview,
			billingCurrency: { value: 'EUR', source: 'configured', revision },
		},
		{
			...safeOverview,
			billingCurrency: { value: 'CNY', source: 'missing', revision },
		},
		{
			...safeOverview,
			routeStrategy: { value: 'weighted_random', source: 'invalid', revision },
		},
		{
			...safeOverview,
			businessTimezone: { value: secretLike(), source: 'configured', revision },
		},
	]) {
		await assert.rejects(
			fixture(async () =>
				Response.json({ success: true, data })
			).api.configOverview(),
			(error: unknown) =>
				error instanceof CinaTokenApiError && error.code === 'invalid-response'
		)
	}
})

function secretLike(): string {
	return 'https://example.test/hook?key=PRIVATE'
}

test('timezone writes are exactly one validated key and never call the secret-bearing generic GET', async () => {
	const { api, calls } = fixture(async () =>
		Response.json({ success: true, message: 'Updated', revision })
	)
	await api.updateBusinessTimezone(' Asia/Shanghai ', 'legacy', {
		expectedWorkspaceId: 'PRIVATE',
	} as never)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.path, '/api/admin/config')
	assert.equal(calls[0]!.init.method, 'PUT')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		key: 'BUSINESS_TIMEZONE',
		value: 'Asia/Shanghai',
	})
	assert.equal(calls[0]!.init.credentials, 'same-origin')
	const headers = new Headers(calls[0]!.init.headers)
	assert.equal(headers.get('Content-Type'), 'application/json')
	assert.equal(headers.get('If-Match'), '"legacy"')
	assert.equal(headers.get('X-CinaToken-Workspace'), null)
	assert.equal(headers.get('Authorization'), null)
	assert.equal(normalizeBusinessTimezoneWrite(' UTC '), 'UTC')
	for (const value of [
		'',
		' ',
		'Mars/Olympus',
		'EST',
		'+01:00',
		'UTC\n',
		'a'.repeat(129),
	]) {
		assert.throws(
			() => normalizeBusinessTimezoneWrite(value),
			ConfigTimezoneInputError
		)
		await assert.rejects(
			api.updateBusinessTimezone(value, revision),
			ConfigTimezoneInputError
		)
	}
	assert.equal(calls.length, 1)
})

test('revision preconditions reject stale browser writes without replay', async () => {
	let current = 'legacy'
	let committed = 0
	const { api, calls } = fixture(async ({ init }) => {
		const match = new Headers(init.headers).get('If-Match')
		if (match !== `"${current}"`)
			return Response.json(
				{ success: false, code: 'config_revision_conflict' },
				{ status: 412 }
			)
		current = revision
		committed++
		return Response.json({
			success: true,
			data: {
				billingCurrency: { value: 'CNY', source: 'configured', revision },
			},
		})
	})
	await api.updateBillingCurrency('CNY', 'legacy')
	await assert.rejects(
		api.updateBillingCurrency('CNY', 'legacy'),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.status === 412
	)
	assert.equal(committed, 1)
	assert.equal(calls.length, 2)
	assert.equal(new Headers(calls[1]!.init.headers).get('If-Match'), '"legacy"')
	await assert.rejects(
		api.updateBillingCurrency('CNY', 'https://example.test/secret' as never),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'invalid-response'
	)
	assert.equal(calls.length, 2)
})

test('business, HTTP, invalid response and cancellation failures retain safe status without replay', async () => {
	for (const [response, status, code] of [
		[
			Response.json({ success: false, message: 'Denied' }, { status: 200 }),
			200,
			'business',
		],
		[
			Response.json({ success: false, message: 'Denied' }, { status: 401 }),
			401,
			'http',
		],
		[
			Response.json({ success: false, message: 'Denied' }, { status: 403 }),
			403,
			'http',
		],
		[
			Response.json({ success: false, message: 'Conflict' }, { status: 409 }),
			409,
			'http',
		],
		[
			Response.json(
				{ success: false, message: 'Unavailable' },
				{ status: 503 }
			),
			503,
			'http',
		],
		[
			Response.json({
				success: true,
				data: { ...safeOverview, canReveal: 'yes' },
			}),
			200,
			'invalid-response',
		],
	] as const) {
		const { api, calls } = fixture(async () => response.clone())
		await assert.rejects(
			api.configOverview(),
			(error: unknown) =>
				error instanceof CinaTokenApiError &&
				error.status === status &&
				error.code === code
		)
		assert.equal(calls.length, 1)
	}
	const abort = new AbortController()
	const { api, calls } = fixture(async () => {
		abort.abort()
		return Response.json({ success: true, data: safeOverview })
	})
	await assert.rejects(
		api.configOverview({ signal: abort.signal }),
		(error: unknown) =>
			error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	assert.equal(calls.length, 1)
})
