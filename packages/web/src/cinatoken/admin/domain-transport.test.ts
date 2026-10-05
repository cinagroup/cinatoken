/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../api'
import {
	createAdminDomainTransport,
	ADMIN_DOMAIN_SUBJECT_HEADER,
	type AdminDomainRequestOptions,
} from './domain-transport'
import {
	AdminDomainWriteError,
	type AdminWriteDomain,
} from './domain-write-recovery'

const subject = 'cinauth:subject/漢字'
const identity = { expectedConsoleSubject: subject, expectedUserId: 'user-a' }
function fixture(
	reply: (path: string, init: RequestInit) => Response | Promise<Response>,
	changed: Partial<{ subject: string; userId: string; isAdmin: boolean }> = {},
	domain: AdminWriteDomain = 'models'
) {
	const calls: { path: string; init: RequestInit }[] = []
	const transport = createCinaTokenCookieTransport(async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		calls.push(call)
		if (call.path === '/api/auth/check')
			return Response.json({
				authenticated: true,
				verification: 'verified',
				principalType: 'console',
				subject: changed.subject ?? subject,
			})
		if (call.path === '/api/user/me')
			return Response.json({
				success: true,
				data: {
					userId: changed.userId ?? 'user-a',
					subject: changed.subject ?? subject,
					isAdmin: changed.isAdmin ?? true,
					email: 'a@example.test',
					capabilities: [],
					organizations: [],
				},
			})
		return reply(call.path, call.init)
	})
	return {
		calls,
		api: createAdminDomainTransport(
			{
				send: transport.send,
				invalidResponse: () => {
					throw new CinaTokenApiError('Invalid', 200, 'invalid-response')
				},
				sanitizeError: (error) =>
					error instanceof Error ? error : new Error('Read failed'),
			},
			domain
		),
	}
}
test('each dispatch performs two fresh identity reads, emits canonical subject and calls marker immediately before the single write', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			acknowledgement: { domain: 'models', operation: 'update', id: 'm' },
		})
	)
	for (let index = 0; index < 2; index++) {
		let count = 0
		await api.send(
			'/api/admin/models/m',
			z.object({ success: z.literal(true) }),
			{ method: 'PATCH' },
			{
				...identity,
				onDispatch: (operation) => {
					assert.equal(operation, 'update')
					assert.equal(calls.length, index * 3 + 2)
					count++
				},
			}
		)
		assert.equal(count, 1)
	}
	assert.deepEqual(
		calls.map((call) => call.path),
		[
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/models/m',
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/models/m',
		]
	)
	for (const call of calls) {
		assert.equal(call.init.credentials, 'same-origin')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(new Headers(call.init.headers).get('Authorization'), null)
	}
	assert.equal(
		new Headers(calls[2]!.init.headers).get(ADMIN_DOMAIN_SUBJECT_HEADER),
		encodeURIComponent(subject)
	)
})
test('missing marker, storage failure, changed subject/user association and revoked admin issue zero business writes', async () => {
	for (const changed of [
		{ subject: 'other' },
		{ userId: 'other' },
		{ isAdmin: false },
		{},
	]) {
		const { api, calls } = fixture(() => {
			throw new Error('Unexpected write')
		}, changed)
		const options: AdminDomainRequestOptions = {
			...identity,
			onDispatch: () => {
				throw new AdminDomainWriteError('storage')
			},
		}
		await assert.rejects(
			api.send(
				'/api/admin/models/m',
				z.unknown(),
				{ method: 'DELETE' },
				options
			)
		)
		assert.equal(
			calls.some((call) => call.path.startsWith('/api/admin/')),
			false
		)
	}
	const { api, calls } = fixture(() => Response.json({}))
	await assert.rejects(
		api.send('/api/admin/models/m', z.unknown(), { method: 'DELETE' }, identity)
	)
	assert.equal(calls.length, 0)
})
test('lost, malformed, wrong ID/operation/domain acknowledgements remain unknown and never retry a mutation', async () => {
	for (const ack of [
		undefined,
		{ domain: 'models', operation: 'update', id: 'other' },
		{ domain: 'routes', operation: 'update', id: 'm' },
		{ domain: 'models', operation: 'delete', id: 'm' },
	]) {
		const { api, calls } = fixture(() =>
			Response.json({ success: true, acknowledgement: ack })
		)
		await assert.rejects(
			api.send(
				'/api/admin/models/m',
				z.object({ success: z.literal(true) }),
				{ method: 'PATCH' },
				{ ...identity, onDispatch: () => undefined }
			),
			(error) =>
				error instanceof AdminDomainWriteError && error.code === 'unknown'
		)
		assert.equal(
			calls.filter((call) => call.path.startsWith('/api/admin/')).length,
			1
		)
	}
})
test('definitive HTTP rejections stay distinct from 5xx, invalid bodies and ignored aborts', async () => {
	for (const status of [409, 412, 428, 500]) {
		const { api } = fixture(() => Response.json({ success: false }, { status }))
		await assert.rejects(
			api.send(
				'/api/admin/models/m',
				z.unknown(),
				{ method: 'PATCH' },
				{ ...identity, onDispatch: () => undefined }
			),
			(error) =>
				error instanceof AdminDomainWriteError &&
				error.code === (status < 500 ? 'rejected' : 'unknown')
		)
	}
	const controller = new AbortController()
	const { api, calls } = fixture(async () => {
		controller.abort()
		return Response.json({
			success: true,
			acknowledgement: { domain: 'models', operation: 'delete', id: 'm' },
		})
	})
	await assert.rejects(
		api.send(
			'/api/admin/models/m',
			z.unknown(),
			{ method: 'DELETE' },
			{ ...identity, signal: controller.signal, onDispatch: () => undefined }
		),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'unknown'
	)
	assert.equal(calls.length, 3)
})
test('typed model policy conflicts retain the public code while private database text is removed', async () => {
	const { api } = fixture(() =>
		Response.json(
			{
				success: false,
				code: 'model_route_policy_conflict',
				message: 'PRIVATE SQL DATA',
			},
			{ status: 409 }
		)
	)
	await assert.rejects(
		api.send(
			'/api/admin/models/m',
			z.unknown(),
			{ method: 'PATCH' },
			{ ...identity, onDispatch: () => undefined }
		),
		(error) =>
			error instanceof AdminDomainWriteError &&
			error.code === 'rejected' &&
			error.status === 409 &&
			error.serverCode === 'model_route_policy_conflict' &&
			!error.message.includes('PRIVATE')
	)
})
test('provider native JSON uses exact response-header acknowledgement without changing upstream resource fields', async () => {
	const ack = {
		domain: 'providers',
		operation: 'resource',
		id: 'p/one',
		related_id: 'voices',
	}
	const { api } = fixture(
		() =>
			Response.json(
				{ request_id: 'native-id', output: { voice: 'voice-one' } },
				{ headers: { 'X-CinaToken-Acknowledgement': JSON.stringify(ack) } }
			),
		{},
		'providers'
	)
	const result = await api.send(
		'/api/admin/providers/p%2Fone/dashscope/voices',
		z.object({
			request_id: z.string(),
			output: z.object({ voice: z.string() }),
		}),
		{ method: 'POST' },
		{ ...identity, onDispatch: () => undefined }
	)
	assert.deepEqual(result, {
		request_id: 'native-id',
		output: { voice: 'voice-one' },
	})
	const invalid = fixture(
		() => Response.json({ request_id: 'native-id' }),
		{},
		'providers'
	)
	await assert.rejects(
		invalid.api.send(
			'/api/admin/providers/p%2Fone/dashscope/voices',
			z.unknown(),
			{ method: 'POST' },
			{ ...identity, onDispatch: () => undefined }
		),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'unknown'
	)
})
test('read subject headers remain scoped, and plain reads never dispatch or infer a write outcome', async () => {
	const { api, calls } = fixture(() => Response.json({ success: true }))
	let dispatch = 0
	await api.send(
		'/api/admin/models',
		z.unknown(),
		{},
		{
			...identity,
			onDispatch: () => {
				dispatch++
			},
		}
	)
	assert.equal(dispatch, 0)
	assert.equal(calls.length, 1)
	assert.equal(
		new Headers(calls[0]!.init.headers).get(ADMIN_DOMAIN_SUBJECT_HEADER),
		encodeURIComponent(subject)
	)
})
