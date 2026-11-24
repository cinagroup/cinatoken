/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import { createAdminConfigApi } from './config-api'
import { adminConfigOverviewSchema } from './config-contracts'
import { configWriteUncertain } from './config-errors'

const revision = '11111111-1111-4111-8111-111111111111'
const bound = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
}
const ack = (value = 'min', token: string | null = revision) => ({
	success: true,
	data: {
		userChargedCostFactorMode: { value, source: 'configured', revision: token },
	},
})
type Call = { path: string; init: RequestInit }
function fixture(
	reply: (call: Call) => Response | Promise<Response>,
	authReply: (path: string) => unknown = adminDomainFixtureAuth
) {
	const calls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		const auth = authReply(call.path)
		return auth !== undefined ? Response.json(auth) : reply(call)
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createAdminConfigApi({
		send: transport.send,
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid configuration response',
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

test('factor mode write freshly verifies subject and user, sends CAS and only accepts the exact new revision acknowledgement', async () => {
	const f = fixture(() => Response.json(ack()))
	assert.deepEqual(
		await f.api.updateUserChargedCostFactorMode('min', 'legacy', bound),
		ack().data.userChargedCostFactorMode
	)
	assert.deepEqual(
		f.calls.map((call) => call.path),
		[
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/config/user-charged-cost-factor-mode',
		]
	)
	const write = f.calls[2]!
	assert.equal(write.init.method, 'PUT')
	assert.deepEqual(JSON.parse(String(write.init.body)), { value: 'min' })
	const headers = new Headers(write.init.headers)
	assert.equal(headers.get('If-Match'), '"legacy"')
	assert.equal(headers.get('If-None-Match'), null)
	assert.equal(
		headers.get('X-CinaToken-Expected-Console-Subject'),
		'fixture-subject'
	)
	for (const call of f.calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(new Headers(call.init.headers).get('Authorization'), null)
		assert.equal(
			new Headers(call.init.headers).get('X-CinaToken-Workspace'),
			null
		)
	}
	const missing = fixture(() => Response.json(ack('multiply')))
	await missing.api.updateUserChargedCostFactorMode('multiply', null, bound)
	assert.equal(
		new Headers(missing.calls[2]!.init.headers).get('If-None-Match'),
		'*'
	)
})

test('invalid values, revisions and unverified or mismatched identity cannot dispatch a factor mode write', async () => {
	const f = fixture(() => assert.fail('No write may be sent'))
	await assert.rejects(
		f.api.updateUserChargedCostFactorMode('other' as never, null, bound)
	)
	await assert.rejects(
		f.api.updateUserChargedCostFactorMode('min', 'private-revision', bound)
	)
	assert.equal(f.calls.length, 0)
	for (const options of [
		{},
		{ ...bound, expectedConsoleSubject: 'other' },
		{ ...bound, expectedUserId: 'other' },
	]) {
		await assert.rejects(
			f.api.updateUserChargedCostFactorMode('min', null, options),
			(error) => error instanceof CinaTokenApiError && error.status === 401
		)
	}
	assert.ok(f.calls.every((call) => call.init.method !== 'PUT'))
})

test('a degraded Console check or changed portal administrator association stops before the write', async () => {
	for (const mismatch of [
		'degraded',
		'api-key',
		'not-admin',
		'changed-user',
	] as const) {
		const f = fixture(
			() => assert.fail('Unverified identity cannot write'),
			(path) => {
				const base = adminDomainFixtureAuth(path)
				if (path === '/api/auth/check' && base && typeof base === 'object') {
					if (mismatch === 'degraded')
						return { ...base, verification: 'degraded' }
					if (mismatch === 'api-key')
						return { ...base, principalType: 'api_key' }
				}
				if (
					path === '/api/user/me' &&
					base &&
					typeof base === 'object' &&
					'data' in base &&
					base.data &&
					typeof base.data === 'object'
				) {
					if (mismatch === 'not-admin')
						return { ...base, data: { ...base.data, isAdmin: false } }
					if (mismatch === 'changed-user')
						return { ...base, data: { ...base.data, userId: 'other' } }
				}
				return base
			}
		)
		await assert.rejects(
			f.api.updateUserChargedCostFactorMode('min', null, bound),
			(error) =>
				error instanceof CinaTokenApiError &&
				error.status === 401 &&
				!configWriteUncertain(error)
		)
		assert.equal(
			f.calls.some((call) => call.init.method === 'PUT'),
			false
		)
	}
})

test('wrong value, unchanged revision and malformed success acknowledgements retain uncertain outcome without replay', async () => {
	for (const body of [
		ack('multiply'),
		ack('min', 'legacy'),
		ack('min', null),
		{ success: true },
		ack('other'),
	]) {
		const f = fixture(() => Response.json(body))
		await assert.rejects(
			f.api.updateUserChargedCostFactorMode('min', 'legacy', bound),
			(error) =>
				error instanceof CinaTokenApiError &&
				error.code === 'invalid-response' &&
				configWriteUncertain(error)
		)
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1)
	}
	const failed = fixture(() =>
		Response.json(
			{ success: false, message: 'private secret must not escape' },
			{ status: 503 }
		)
	)
	await assert.rejects(
		failed.api.updateUserChargedCostFactorMode('min', null, bound),
		(error) =>
			error instanceof Error &&
			!error.message.includes('private secret') &&
			configWriteUncertain(error)
	)
	assert.equal(
		failed.calls.filter((call) => call.init.method === 'PUT').length,
		1
	)
})

test('abort prevents fresh reads and a cancellation after dispatch remains uncertain', async () => {
	const before = new AbortController()
	before.abort()
	const f = fixture(() => assert.fail('Cancelled request cannot dispatch'))
	await assert.rejects(
		f.api.updateUserChargedCostFactorMode('min', null, {
			...bound,
			signal: before.signal,
		})
	)
	assert.equal(f.calls.length, 0)
	const after = new AbortController()
	const dispatched = fixture(() => {
		after.abort()
		return Response.json(ack())
	})
	await assert.rejects(
		dispatched.api.updateUserChargedCostFactorMode('min', null, {
			...bound,
			signal: after.signal,
		}),
		configWriteUncertain
	)
	assert.equal(
		dispatched.calls.filter((call) => call.init.method === 'PUT').length,
		1
	)
})

test('overview accepts a legacy missing mode but rejects invalid/default masquerading and strips accidental secrets', () => {
	const legacy = {
		businessTimezone: { value: 'UTC', source: 'missing', revision: null },
		billingCurrency: { value: 'USD', source: 'missing', revision: null },
		routeStrategy: {
			value: 'hash_affinity',
			source: 'missing',
			revision: null,
		},
		webhooks: {
			wecom: { configured: false, revision: null },
			feishu: { configured: false, revision: null },
		},
		canWrite: true,
		canReveal: false,
	}
	assert.equal(
		adminConfigOverviewSchema.parse(legacy).userChargedCostFactorMode,
		undefined
	)
	const configured = {
		...legacy,
		userChargedCostFactorMode: {
			value: 'min',
			source: 'configured',
			revision,
			secret: 'PRIVATE',
		},
	}
	assert.deepEqual(
		adminConfigOverviewSchema.parse(configured).userChargedCostFactorMode,
		{ value: 'min', source: 'configured', revision }
	)
	for (const field of [
		{ value: 'min', source: 'invalid', revision },
		{ value: 'min', source: 'missing', revision: null },
		{ value: 'min', source: 'configured', revision: null },
		{ value: 'other', source: 'configured', revision },
	])
		assert.equal(
			adminConfigOverviewSchema.safeParse({
				...legacy,
				userChargedCostFactorMode: field,
			}).success,
			false
		)
})
