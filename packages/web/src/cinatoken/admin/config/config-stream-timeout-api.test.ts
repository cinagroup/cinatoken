/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { adminDomainFixtureAuth } from '../domain-api-test-fixture'
import { createAdminConfigApi } from './config-api'

const ms = 'streamFirstEventTimeoutMs'
const groups = 'streamFirstEventTimeoutRouteGroups'
const revision = 'abcdefab-1234-4234-8234-123456789abc'
const bound = {
	expectedConsoleSubject: 'fixture-subject',
	expectedUserId: 'fixture-user',
}
function fixture(
	reply: (path: string, init: RequestInit) => Response | Promise<Response>
) {
	const calls: { path: string; init: RequestInit }[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		const auth = adminDomainFixtureAuth(call.path)
		return auth === undefined
			? reply(call.path, call.init)
			: Response.json(auth)
	})
	const api = createAdminConfigApi({
		send: transport.send,
		invalidResponse: () => {
			throw new CinaTokenApiError('Invalid response', 200, 'invalid-response')
		},
		sanitizeError: (error) =>
			error instanceof CinaTokenApiError
				? new CinaTokenApiError('Request failed', error.status, error.code)
				: new Error('Request failed'),
	})
	return { api, calls }
}
function ack(field: string, value: string, token: string | null = revision) {
	return {
		success: true,
		data: {
			[field]: {
				value,
				source: value ? 'configured' : 'missing',
				revision: token,
			},
		},
	}
}
test('each timeout save verifies identity, persists before dispatch, uses its dedicated path and exact CAS acknowledgement', async () => {
	for (const field of [ms, groups] as const) {
		let recorded = false
		const value = field === ms ? '0' : 'VIP,*,vip'
		const f = fixture((path, init) => {
			assert.ok(recorded)
			assert.equal(
				path,
				field === ms
					? '/api/admin/config/stream-first-event-timeout-ms'
					: '/api/admin/config/stream-first-event-timeout-route-groups'
			)
			assert.deepEqual(JSON.parse(String(init.body)), { value })
			return Response.json(ack(field, value))
		})
		await f.api.updateStreamTimeout(field, ' ' + value + ' ', 'legacy', {
			...bound,
			onDispatch: () => {
				recorded = true
				assert.equal(f.calls.length, 2)
			},
		})
		assert.deepEqual(
			f.calls.slice(0, 2).map((call) => call.path),
			['/api/auth/check', '/api/user/me']
		)
		const write = f.calls[2]!
		assert.equal(new Headers(write.init.headers).get('If-Match'), '"legacy"')
		assert.equal(
			new Headers(write.init.headers).get(
				'X-CinaToken-Expected-Console-Subject'
			),
			'fixture-subject'
		)
		assert.equal(write.init.credentials, 'same-origin')
		assert.equal(write.init.cache, 'no-store')
	}
	const empty = fixture(() => Response.json(ack(ms, '')))
	await empty.api.updateStreamTimeout(ms, '', null, {
		...bound,
		onDispatch: () => {},
	})
	assert.equal(
		new Headers(empty.calls[2]!.init.headers).get('If-None-Match'),
		'*'
	)
})
test('invalid inputs, mismatched identity and persistence failure prevent dispatch', async () => {
	const f = fixture(() => assert.fail('must not dispatch'))
	await assert.rejects(
		f.api.updateStreamTimeout(ms, '1e3', null, {
			...bound,
			onDispatch: () => assert.fail(),
		})
	)
	assert.equal(f.calls.length, 0)
	await assert.rejects(
		f.api.updateStreamTimeout(ms, '10', null, {
			...bound,
			expectedUserId: 'other',
			onDispatch: () => assert.fail(),
		})
	)
	await assert.rejects(
		f.api.updateStreamTimeout(ms, '10', null, {
			...bound,
			onDispatch: () => {
				throw new Error('storage')
			},
		})
	)
	assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 0)
})
test('malformed or non-advancing ACKs and unknown HTTP failures are never replayed', async () => {
	for (const body of [
		ack(ms, '11'),
		ack(ms, '10', null),
		ack(ms, '10', 'legacy'),
		ack(ms, '10', 'LEGACY'),
		ack(groups, '10'),
		{ success: true },
		ack(ms, '10', revision),
	]) {
		const f = fixture(() => Response.json(body))
		await assert.rejects(
			f.api.updateStreamTimeout(ms, '10', revision.toUpperCase(), {
				...bound,
				onDispatch: () => {},
			})
		)
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1)
	}
	for (const status of [404, 409, 412, 503]) {
		const f = fixture(() =>
			Response.json({ success: false, message: 'PRIVATE_CANARY' }, { status })
		)
		await assert.rejects(
			f.api.updateStreamTimeout(ms, '10', null, {
				...bound,
				onDispatch: () => {},
			}),
			(error) =>
				error instanceof Error && !error.message.includes('PRIVATE_CANARY')
		)
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1)
	}
})
test('abort before dispatch stops persistence and abort after PUT never accepts an ACK', async () => {
	const abort = new AbortController()
	abort.abort()
	const f = fixture(() => assert.fail())
	await assert.rejects(
		f.api.updateStreamTimeout(ms, '10', null, {
			...bound,
			signal: abort.signal,
			onDispatch: () => assert.fail(),
		})
	)
	assert.equal(f.calls.length, 0)
	const late = new AbortController()
	const sent = fixture(() => {
		late.abort()
		return Response.json(ack(ms, '10'))
	})
	await assert.rejects(
		sent.api.updateStreamTimeout(ms, '10', null, {
			...bound,
			signal: late.signal,
			onDispatch: () => {},
		})
	)
	assert.equal(
		sent.calls.filter((call) => call.init.method === 'PUT').length,
		1
	)
})

test('reconciliation reads bind the same Console subject and retain fresh permission changes', async () => {
	const f = fixture((path, init) => {
		assert.equal(path, '/api/admin/config/overview')
		assert.equal(
			new Headers(init.headers).get('X-CinaToken-Expected-Console-Subject'),
			'fixture-subject'
		)
		return Response.json({
			success: true,
			data: {
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
				canWrite: false,
				canReveal: false,
				[ms]: { value: '10ms', source: 'invalid', revision: 'legacy' },
			},
		})
	})
	assert.deepEqual(await f.api.readStreamTimeout(ms, bound), {
		field: { value: '10ms', source: 'invalid', revision: 'legacy' },
		canWrite: false,
		canReveal: false,
	})
	assert.equal(
		f.calls.some((call) => call.init.method === 'PUT'),
		false
	)
})
