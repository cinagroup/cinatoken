/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import { deferred } from '../../test-fixtures'
import {
	adminDomainFixtureAck,
	adminDomainFixtureAuth,
	bindAdminDomainFixtureApi,
} from '../domain-api-test-fixture'
import { reviewAdminDomainUnknown } from '../domain-manual-recovery'
import {
	AdminDomainWriteError,
	AdminDomainWriteRecovery,
} from '../domain-write-recovery'
import { createAdminGuardrailsApi } from './guardrails-api'
import type {
	AdminGuardrailAssignment,
	AdminGuardrailSummary,
} from './guardrails-contracts'
import { AdminGuardrailWriteRecovery } from './guardrails-write-recovery'

const privateText = 'PRIVATE-GUARDRAIL-CONFIG'
const row: AdminGuardrailSummary = {
	id: 'guardrail/one',
	workspaceId: 'workspace/one',
	ownerUserId: 'user/one',
	name: 'First',
	description: null,
	status: 'active',
	isWorkspaceDefault: false,
	isAccountDefault: false,
	accountScopeKey: null,
	designatedVersion: 2,
	latestVersion: 3,
}
const assignment: AdminGuardrailAssignment = {
	id: 'assignment/one',
	workspaceId: row.workspaceId,
	guardrailId: row.id,
	guardrailName: row.name,
	scopeType: 'api_key',
	scopeId: 'key/one',
	createdByUserId: null,
	createdAt: '2026-09-28T00:00:00.000Z',
}
type Call = { path: string; init: RequestInit }

function fixture(
	reply: (call: Call) => Response | Promise<Response>,
	config: {
		auth?: (call: Call) => Response
		ack?: (call: Call, body: unknown) => unknown
	} = {}
) {
	const calls: Call[] = []
	const allCalls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		allCalls.push(call)
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined) return config.auth?.(call) ?? Response.json(auth)
		calls.push(call)
		const response = await reply(call)
		if (!response.ok || (call.init.method ?? 'GET') === 'GET') return response
		const body: unknown = await response.json()
		return Response.json(
			config.ack
				? config.ack(call, body)
				: adminDomainFixtureAck(call.path, call.init, body),
			{ status: response.status, headers: response.headers }
		)
	}
	const transport = createCinaTokenCookieTransport(request)
	const rawApi = createAdminGuardrailsApi({
		send(path, schema, init, options, reader) {
			return transport.send(path, schema, init, options, reader)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid guardrail response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Guardrail operation could not be confirmed',
					error.status,
					error.code
				)
			return new Error('Guardrail operation could not be confirmed')
		},
	})
	const api = bindAdminDomainFixtureApi(rawApi, {
		listGuardrails: 0,
		listGuardrailVersions: 1,
		listGuardrailAssignments: 1,
		setGuardrailStatus: 2,
		designateGuardrail: 2,
		bindGuardrail: 3,
		unbindGuardrail: 2,
	})
	return { api, rawApi, calls, allCalls }
}

const invalid = (error: unknown): boolean =>
	error instanceof CinaTokenApiError && error.code === 'invalid-response'
const unknownWrite = (error: unknown): boolean =>
	error instanceof AdminDomainWriteError && error.code === 'unknown'

test('Guardrail summaries strip raw configs and use same-origin Console Cookie only', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: [
				{ ...row, config: { secret: privateText } },
				{
					...row,
					id: 'guardrail/two',
					workspaceId: 'workspace/two',
					ownerUserId: 'user/two',
					config: { secret: privateText },
				},
			],
			count: 2,
			canWrite: false,
			privateServerField: privateText,
		})
	)
	const listing = await api.listGuardrails({
		expectedWorkspaceId: privateText,
	} as never)
	assert.equal(listing.canWrite, false)
	assert.equal(listing.rows.length, 2)
	assert.deepEqual(listing.rows[0], row)
	assert.equal(listing.rows[1]?.workspaceId, 'workspace/two')
	assert.equal(JSON.stringify(listing).includes(privateText), false)
	assert.equal(calls[0]?.path, '/api/admin/guardrails/summaries')
	assert.equal(calls[0]?.init.credentials, 'same-origin')
	assert.equal(calls[0]?.init.cache, 'no-store')
	assert.equal(
		new Headers(calls[0]?.init.headers).get(
			'X-CinaToken-Expected-Console-Subject'
		),
		'fixture-subject'
	)
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(new Headers(calls[0]?.init.headers).get(name), null)
	for (const data of [
		{ data: [row], count: 0 },
		{ data: [row, row], count: 2 },
		{ data: [{ ...row, designatedVersion: 4 }], count: 1 },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, canWrite: true, ...data })
			).api.listGuardrails(),
			invalid
		)
	for (const canWrite of [undefined, null, 'false', 0])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data: [row], count: 1, canWrite })
			).api.listGuardrails(),
			invalid
		)
})

test('Guardrail version summaries bind to ID and discard config content', async () => {
	const version = {
		id: 'version/one',
		version: 2,
		createdAt: '2026-09-28T00:00:00.000Z',
	}
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: {
				guardrailId: row.id,
				versions: [{ ...version, config: { secret: privateText } }],
				total: 1,
			},
		})
	)
	assert.deepEqual(await api.listGuardrailVersions(row.id), [version])
	assert.equal(
		calls[0]?.path,
		'/api/admin/guardrails/guardrail%2Fone/version-summaries'
	)
	for (const data of [
		{ guardrailId: 'guardrail/other', versions: [version], total: 1 },
		{ guardrailId: row.id, versions: [version], total: 2 },
		{ guardrailId: row.id, versions: [version, version], total: 2 },
		{
			guardrailId: row.id,
			versions: [version, { ...version, id: 'version/two' }],
			total: 2,
		},
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data })
			).api.listGuardrailVersions(row.id),
			invalid
		)
})

test('assignments must belong to the requested guardrail and workspace', async () => {
	const { api, calls } = fixture(() =>
		Response.json({
			success: true,
			data: [{ ...assignment, config: { secret: privateText } }],
		})
	)
	assert.deepEqual(await api.listGuardrailAssignments(row), [assignment])
	assert.equal(
		JSON.stringify(await api.listGuardrailAssignments(row)).includes(
			privateText
		),
		false
	)
	assert.equal(
		calls[0]?.path,
		'/api/admin/guardrails/guardrail%2Fone/assignments'
	)
	for (const bad of [
		{ ...assignment, guardrailId: 'guardrail/other' },
		{ ...assignment, workspaceId: 'workspace/other' },
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data: [bad] })
			).api.listGuardrailAssignments(row),
			invalid
		)
})

test('status and designation send only narrowed writes and verify result identity', async () => {
	const { api, calls } = fixture((call) =>
		Response.json({
			success: true,
			data:
				call.init.method === 'PATCH'
					? { ...row, status: 'archived', config: { secret: privateText } }
					: { ...row, designatedVersion: 1, config: { secret: privateText } },
		})
	)
	assert.equal(
		(await api.setGuardrailStatus(row, 'archived')).status,
		'archived'
	)
	assert.equal((await api.designateGuardrail(row, 1)).designatedVersion, 1)
	assert.equal(
		calls[0]?.path,
		'/api/admin/guardrails/guardrail%2Fone?view=summary'
	)
	assert.equal(
		calls[1]?.path,
		'/api/admin/guardrails/guardrail%2Fone/designate?view=summary'
	)
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		status: 'archived',
	})
	assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { version: 1 })
	for (const data of [
		{ ...row, id: 'guardrail/other', status: 'archived' },
		{ ...row, workspaceId: 'workspace/other', status: 'archived' },
		{ ...row, ownerUserId: 'user/other', status: 'archived' },
		row,
	])
		await assert.rejects(
			fixture(() =>
				Response.json({ success: true, data })
			).api.setGuardrailStatus(row, 'archived'),
			unknownWrite
		)
	await assert.rejects(api.designateGuardrail(row, 0), /could not be confirmed/)
	assert.equal(calls.length, 2)
})

test('bind verifies target and conditional unbind carries expected Guardrail ID', async () => {
	const { api, calls } = fixture((call) =>
		Response.json(
			call.init.method === 'PUT'
				? { success: true, data: { ...assignment, config: privateText } }
				: { success: true, removed: true }
		)
	)
	assert.deepEqual(
		await api.bindGuardrail(row, 'api_key', 'key/one'),
		assignment
	)
	assert.equal(await api.unbindGuardrail(row, assignment), true)
	assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), {
		scope_type: 'api_key',
		scope_id: 'key/one',
	})
	assert.equal(
		calls[1]?.path,
		'/api/admin/guardrails/assignments/api_key/key%2Fone?workspace_id=workspace%2Fone&expected_guardrail_id=guardrail%2Fone'
	)
	assert.equal(calls[1]?.init.method, 'DELETE')
	await assert.rejects(
		api.unbindGuardrail(row, { ...assignment, guardrailId: 'guardrail/other' }),
		invalid
	)
	assert.equal(calls.length, 2)
	await assert.rejects(
		fixture(() =>
			Response.json({
				success: true,
				data: { ...assignment, guardrailId: 'guardrail/other' },
			})
		).api.bindGuardrail(row, 'api_key', 'key/one'),
		unknownWrite
	)
	for (const data of [
		{ ...assignment, workspaceId: 'workspace/other' },
		{ ...assignment, scopeType: 'user' },
		{ ...assignment, scopeId: 'key/other' },
	]) {
		const badScope = fixture(() => Response.json({ success: true, data }))
		await assert.rejects(
			badScope.api.bindGuardrail(row, 'api_key', 'key/one'),
			unknownWrite
		)
		assert.equal(badScope.calls.length, 1)
	}
})

test('an aborted dispatched write rejects a late legal ACK and retains its generation', async () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const recovery = new AdminDomainWriteRecovery(storage)
	const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
	const held = deferred<Response>()
	const entered = deferred<void>()
	const f = fixture(() => {
		entered.resolve()
		return held.promise
	})
	const abort = new AbortController()
	const pending = f.api.setGuardrailStatus(row, 'archived', {
		signal: abort.signal,
		onDispatch: (operation) => {
			recovery.markPending(identity, 'guardrails', operation)
		},
	})
	await entered.promise
	const marker = recovery.marker(identity, 'guardrails')
	assert.ok(marker)
	assert.equal(f.calls.length, 1)
	abort.abort()
	assert.equal(f.calls[0]?.init.signal?.aborted, true)
	// The injected HTTP transport deliberately ignores AbortSignal, so the real
	// SDK's post-response check must still reject the otherwise legal ACK.
	held.resolve(
		Response.json({ success: true, data: { ...row, status: 'archived' } })
	)
	await assert.rejects(pending, unknownWrite)
	assert.equal(f.calls.length, 1)
	assert.deepEqual(
		new AdminDomainWriteRecovery(storage).marker(identity, 'guardrails'),
		marker
	)
})

test('committed 503 write remains unknown and SDK does not replay it', async () => {
	const { api, calls } = fixture(() =>
		Response.json({ success: false, message: privateText }, { status: 503 })
	)
	await assert.rejects(api.bindGuardrail(row, 'user', 'user/two'), (error) => {
		assert.equal(error instanceof AdminDomainWriteError, true)
		if (!(error instanceof AdminDomainWriteError)) return false
		assert.equal(error.code, 'unknown')
		assert.equal(error.status, 503)
		assert.equal(error.message.includes(privateText), false)
		return true
	})
	assert.equal(calls.length, 1)
})

test('fresh Console and Portal association failures prevent dispatch and replay', async () => {
	const cases: Array<{ path: string; body?: unknown; status?: number }> = [
		{ path: '/api/auth/check', status: 401 },
		{ path: '/api/auth/check', status: 403 },
		{
			path: '/api/auth/check',
			body: {
				authenticated: true,
				verification: 'verified',
				principalType: 'console',
				subject: 'changed-subject',
			},
		},
		{
			path: '/api/auth/check',
			body: {
				authenticated: true,
				verification: 'verified',
				principalType: 'user',
				subject: 'fixture-subject',
			},
		},
		{ path: '/api/user/me', status: 401 },
		{ path: '/api/user/me', status: 403 },
		{
			path: '/api/user/me',
			body: {
				success: true,
				data: {
					userId: 'changed-user',
					subject: 'fixture-subject',
					email: 'fixture@example.test',
					isAdmin: true,
					capabilities: [],
					organizations: [],
				},
			},
		},
		{
			path: '/api/user/me',
			body: {
				success: true,
				data: {
					userId: 'fixture-user',
					subject: 'changed-subject',
					email: 'fixture@example.test',
					isAdmin: true,
					capabilities: [],
					organizations: [],
				},
			},
		},
		{
			path: '/api/user/me',
			body: {
				success: true,
				data: {
					userId: 'fixture-user',
					subject: 'fixture-subject',
					email: 'fixture@example.test',
					isAdmin: false,
					capabilities: [],
					organizations: [],
				},
			},
		},
	]
	for (const failure of cases) {
		let dispatches = 0
		const f = fixture(
			() => {
				throw new Error('Business request must not dispatch')
			},
			{
				auth: (call) => {
					if (call.path !== failure.path)
						return Response.json(adminDomainFixtureAuth(call.path))
					return Response.json(failure.body ?? { success: false }, {
						status: failure.status ?? 200,
					})
				},
			}
		)
		await assert.rejects(
			f.api.designateGuardrail(row, 1, {
				onDispatch: () => {
					dispatches += 1
				},
			}),
			(error: unknown) =>
				error instanceof AdminDomainWriteError && error.code === 'subject'
		)
		assert.equal(dispatches, 0)
		assert.equal(f.calls.length, 0)
		assert.equal(f.allCalls.length, failure.path === '/api/auth/check' ? 1 : 2)
		for (const call of f.allCalls) {
			assert.equal(call.init.method ?? 'GET', 'GET')
			assert.equal(call.init.credentials, 'same-origin')
			assert.equal(call.init.cache, 'no-store')
		}
	}
})

test('missing or mismatched bind ACK leaves the exact generation durable without replay', async () => {
	const expected = {
		domain: 'guardrails',
		operation: 'bind',
		id: row.id,
		related_id: assignment.scopeId,
	}
	for (const acknowledgement of [
		undefined,
		{ ...expected, domain: 'presets' },
		{ ...expected, operation: 'update' },
		{ ...expected, id: 'other' },
		{ ...expected, related_id: 'other' },
		{ ...expected, extra: true },
	]) {
		const values = new Map<string, string>()
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value)
			},
			removeItem: (key: string) => {
				values.delete(key)
			},
		}
		const recovery = new AdminDomainWriteRecovery(storage)
		const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
		const f = fixture(
			() => Response.json({ success: true, data: assignment }),
			{ ack: (_call, body) => ({ ...(body as object), acknowledgement }) }
		)
		await assert.rejects(
			f.api.bindGuardrail(row, 'api_key', assignment.scopeId, {
				onDispatch: (operation) => {
					recovery.markPending(identity, 'guardrails', operation)
				},
			}),
			unknownWrite
		)
		const marker = recovery.marker(identity, 'guardrails')
		assert.ok(marker)
		assert.equal(f.calls.length, 1)
		assert.deepEqual(
			f.allCalls.map((call) => call.path),
			[
				'/api/auth/check',
				'/api/user/me',
				'/api/admin/guardrails/guardrail%2Fone/assignments',
			]
		)
		assert.deepEqual(
			new AdminDomainWriteRecovery(storage).marker(identity, 'guardrails'),
			marker
		)
		assert.equal(
			new Headers(f.calls[0]?.init.headers).get(
				'X-CinaToken-Expected-Console-Subject'
			),
			'fixture-subject'
		)
		assert.equal(JSON.stringify(marker).includes(assignment.scopeId), false)
		assert.equal(JSON.stringify(marker).includes(row.id), false)
	}
})

test('conditional unbind is acknowledged for the exact resource even when another assignment won', async () => {
	const f = fixture(() => Response.json({ success: true, removed: false }))
	assert.equal(await f.api.unbindGuardrail(row, assignment), false)
	assert.equal(f.calls.length, 1)
	assert.equal(f.calls[0]?.init.method, 'DELETE')
	for (const related_id of [undefined, 'other']) {
		const invalidAck = fixture(
			() => Response.json({ success: true, removed: false }),
			{
				ack: () => ({
					success: true,
					removed: false,
					acknowledgement: {
						domain: 'guardrails',
						operation: 'unbind',
						id: row.id,
						related_id,
					},
				}),
			}
		)
		await assert.rejects(
			invalidAck.api.unbindGuardrail(row, assignment),
			unknownWrite
		)
		assert.equal(invalidAck.calls.length, 1)
	}
})

test('successful summary GET and two fresh reviews never implicitly clear a durable unknown generation', async () => {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value)
		},
		removeItem: (key: string) => {
			values.delete(key)
		},
	}
	const recovery = new AdminGuardrailWriteRecovery(storage)
	const identity = JSON.stringify(['fixture-user', 'fixture-subject', 1])
	const marker = recovery.markPending(identity, 'guardrails', 'bind')
	// More identities than the former in-memory cache limit cannot evict this marker.
	for (let index = 0; index < 40; index += 1)
		recovery.markPending(
			JSON.stringify([`user-${index}`, `subject-${index}`, 1]),
			'guardrails',
			'update'
		)
	const f = fixture(() =>
		Response.json({ success: true, data: [row], count: 1, canWrite: true })
	)
	await f.api.listGuardrails()
	assert.deepEqual(recovery.marker(identity, 'guardrails'), marker)
	const options = {
		expectedConsoleSubject: 'fixture-subject',
		expectedUserId: 'fixture-user',
	}
	await reviewAdminDomainUnknown({
		options,
		verify: f.rawApi.verifyAdminDomainSubject,
		observe: f.rawApi.listGuardrails,
		reviewedExternal: true,
		acceptsUnknown: true,
	})
	assert.deepEqual(
		f.allCalls.map((call) => call.path),
		[
			'/api/admin/guardrails/summaries',
			'/api/auth/check',
			'/api/user/me',
			'/api/admin/guardrails/summaries',
			'/api/auth/check',
			'/api/user/me',
		]
	)
	assert.deepEqual(
		new AdminDomainWriteRecovery(storage).marker(identity, 'guardrails'),
		marker
	)
	for (const call of f.allCalls) {
		assert.equal(call.init.method ?? 'GET', 'GET')
		assert.equal(call.init.cache, 'no-store')
	}
	recovery.acknowledgeUnknown(identity, marker)
	assert.equal(recovery.status(identity, 'guardrails'), 'ready')
})
