/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../../api'
import {
	adminDomainFixtureAuth,
	adminDomainFixtureAck,
	bindAdminDomainFixtureApi,
} from '../domain-api-test-fixture'
import { reviewAdminDomainUnknown } from '../domain-manual-recovery'
import {
	AdminDomainWriteError,
	AdminDomainWriteRecovery,
} from '../domain-write-recovery'
import { createDataPoliciesApi } from './data-policy-api'
import { dataPolicyUpsertInputSchema } from './data-policy-contracts'

const routeId = 'route/one'
const policy = {
	route_target_id: routeId,
	subject_fingerprint: 'a'.repeat(64),
	retention_days: 30,
	training_allowed: false,
	zdr_supported: true,
	evidence_url: 'https://example.test/evidence',
	verified_by: 'console:cinaauth:fixture-subject',
	verified_at: '2026-09-27T00:00:00.000Z',
	expires_at: '2099-01-01T00:00:00.000Z',
	status: 'verified',
	invalidated_at: null,
	invalidation_reason: null,
	updated_at: '2026-09-27T00:00:00.000Z',
	subject_matches_current: true,
	effective_status: 'verified',
} as const
const joined = {
	...policy,
	model_id: 'model/one',
	provider_id: 'provider/one',
	provider_name: 'Provider One',
	provider_model_name: 'upstream-model',
	upstream_protocol: 'openai',
	upstream_operation: 'chat',
	route_group: 'default',
}
const unconfigured = {
	...joined,
	route_target_id: 'route/two',
	subject_fingerprint: null,
	retention_days: null,
	training_allowed: true,
	zdr_supported: false,
	evidence_url: null,
	verified_by: null,
	verified_at: null,
	expires_at: null,
	status: 'unknown',
	subject_matches_current: false,
	effective_status: 'unknown',
}
const input = {
	status: 'verified',
	retention_days: 0,
	training_allowed: false,
	zdr_supported: true,
	evidence_url: ' https://example.test/evidence ',
	expires_at: '2099-01-01T00:00:00Z',
} as const
type Call = { path: string; init: RequestInit }
function fixture(reply: (call: Call) => Promise<Response>, includeAck = true) {
	const calls: Call[] = []
	const allCalls: Call[] = []
	const request: typeof fetch = async (path, init) => {
		const call = { path: String(path), init: init ?? {} }
		allCalls.push(call)
		const auth = adminDomainFixtureAuth(call.path)
		if (auth !== undefined) return Response.json(auth)
		calls.push(call)
		const result = await reply(call)
		if (!includeAck || !result.ok || (call.init.method ?? 'GET') === 'GET')
			return result
		return Response.json(
			adminDomainFixtureAck(call.path, call.init, await result.json()),
			{ status: result.status, headers: result.headers }
		)
	}
	const transport = createCinaTokenCookieTransport(request)
	const rawApi = createDataPoliciesApi({
		send(path, schema, init, options) {
			return transport.send(path, schema, init, options)
		},
		invalidResponse() {
			throw new CinaTokenApiError(
				'Invalid data policy response',
				200,
				'invalid-response'
			)
		},
		sanitizeError(error) {
			if (error instanceof CinaTokenApiError)
				return new CinaTokenApiError(
					'Data policy operation failed',
					error.status,
					error.code
				)
			return new Error('Data policy operation failed')
		},
	})
	const api = bindAdminDomainFixtureApi(
		{
			...rawApi,
			upsertDataPolicy: (
				id: string,
				input: Parameters<typeof rawApi.upsertDataPolicy>[1],
				options: Parameters<typeof rawApi.upsertDataPolicy>[2] = {}
			) =>
				rawApi.upsertDataPolicy(id, input, {
					expectedPolicy: {
						route_target_id: id,
						current_subject_fingerprint: 'a'.repeat(64),
						current_policy_fingerprint: null,
					},
					...options,
				}),
		},
		{ upsertDataPolicy: 2 }
	)
	return { api, rawApi, calls, allCalls }
}
const ok = (data: unknown): Promise<Response> =>
	Promise.resolve(Response.json({ success: true, data }))
const invalid = (error: unknown): boolean =>
	(error instanceof CinaTokenApiError && error.code === 'invalid-response') ||
	(error instanceof AdminDomainWriteError && error.code === 'unknown')

test('list includes unconfigured route targets, projects labels and sends only same-origin Cookie context', async () => {
	const { api, calls } = fixture(() =>
		ok([{ ...joined, provider_secret: 'PRIVATE' }, unconfigured])
	)
	const rows = await api.dataPolicyList({
		timeoutMs: 500,
		expectedWorkspaceId: 'PRIVATE',
	} as never)
	assert.equal(rows.length, 2)
	assert.equal(rows[1]!.subject_fingerprint, null)
	assert.equal(rows[1]!.effective_status, 'unknown')
	assert.equal(JSON.stringify(rows).includes('PRIVATE'), false)
	assert.equal(calls[0]!.path, '/api/admin/data-policies')
	assert.equal(calls[0]!.init.credentials, 'same-origin')
	assert.equal(calls[0]!.init.cache, 'no-store')
	const headers = new Headers(calls[0]!.init.headers)
	assert.equal(headers.get('Accept'), 'application/json')
	for (const name of ['Authorization', 'New-Api-User', 'X-CinaToken-Workspace'])
		assert.equal(headers.get(name), null)
	for (const data of [
		[joined, joined],
		[{ ...joined, effective_status: 'other' }],
		[
			{
				...joined,
				subject_matches_current: false,
				effective_status: 'verified',
			},
		],
		[{ ...joined, subject_fingerprint: null, effective_status: 'verified' }],
		[{ ...joined, route_target_id: '' }],
	])
		await assert.rejects(fixture(() => ok(data)).api.dataPolicyList(), invalid)
})

test('legacy stored retention and long HTTPS evidence remain readable while new retention is capped', async () => {
	const longUrl = 'https://example.test/' + 'a'.repeat(4_100)
	const { api } = fixture(() =>
		ok([{ ...joined, retention_days: 36_501, evidence_url: longUrl }])
	)
	const [row] = await api.dataPolicyList()
	assert.equal(row?.retention_days, 36_501)
	assert.equal(row?.evidence_url, longUrl)
	assert.equal(
		dataPolicyUpsertInputSchema.safeParse({ ...input, retention_days: 36_501 })
			.success,
		false
	)
	assert.equal(
		dataPolicyUpsertInputSchema.safeParse({ ...input, evidence_url: longUrl })
			.success,
		true
	)
})

test('audit accepts nullable historical target and projects only known version 2 snapshots', async () => {
	const snapshot = {
		v: 2,
		route_target_id: routeId,
		subject_fingerprint: 'sha256:current',
		retention_days: 30,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: null,
		verified_by: 'admin/one',
		verified_at: '2026-09-27T00:00:00Z',
		expires_at: null,
		status: 'unknown',
		invalidated_at: null,
		invalidation_reason: null,
		secret: 'PRIVATE',
	}
	const records = [
		{
			id: 'audit/one',
			route_target_id: routeId,
			actor_id: 'admin/one',
			created_at: policy.updated_at,
			snapshot,
		},
		{
			id: 'audit/two',
			route_target_id: null,
			actor_id: 'admin/two',
			created_at: policy.updated_at,
			snapshot: {
				v: 2,
				event: 'invalidated',
				reason: 'Provider changed',
				previous_status: 'verified',
				subject_fingerprint: 'sha256:old',
				secret: 'PRIVATE',
			},
		},
		{
			id: 'audit/three',
			route_target_id: routeId,
			actor_id: 'admin/three',
			created_at: policy.updated_at,
			snapshot: { v: 1, legacy_secret: 'PRIVATE' },
		},
	]
	const { api, calls } = fixture(() => ok(records))
	const audit = await api.dataPolicyAudit(routeId)
	assert.equal(calls[0]!.path, '/api/admin/data-policies/route%2Fone/audit')
	assert.equal(audit[2]!.snapshot, null)
	assert.equal(JSON.stringify(audit).includes('PRIVATE'), false)
	assert.deepEqual(audit[1]!.snapshot, {
		v: 2,
		event: 'invalidated',
		reason: 'Provider changed',
		previous_status: 'verified',
		subject_fingerprint: 'sha256:old',
	})
	for (const data of [
		[records[0], records[0]],
		[{ ...records[0], route_target_id: 'route/other' }],
		[
			{
				...records[0],
				snapshot: { ...snapshot, route_target_id: 'route/other' },
			},
		],
	])
		await assert.rejects(
			fixture(() => ok(data)).api.dataPolicyAudit(routeId),
			invalid
		)
})

test('PUT sends only canonical fields, does not cache blank JOIN labels, and rejects bad input before dispatch', async () => {
	const { api, calls } = fixture(() =>
		ok({
			...policy,
			retention_days: 0,
			provider_name: '',
			private_value: 'PRIVATE',
		})
	)
	assert.equal(await api.upsertDataPolicy(routeId, input), undefined)
	assert.equal(calls.length, 1)
	assert.equal(calls[0]!.path, '/api/admin/data-policies/route%2Fone')
	assert.equal(calls[0]!.init.method, 'PUT')
	assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
		status: 'verified',
		retention_days: 0,
		training_allowed: false,
		zdr_supported: true,
		evidence_url: 'https://example.test/evidence',
		expires_at: '2099-01-01T00:00:00.000Z',
		expected_subject_fingerprint: 'a'.repeat(64),
		expected_policy_fingerprint: null,
	})
	for (const invalidInput of [
		{ ...input, evidence_url: 'http://example.test/evidence' },
		{ ...input, evidence_url: 'https://user:password@example.test/evidence' },
		{ ...input, evidence_url: null },
		{ ...input, expires_at: '2020-01-01T00:00:00Z' },
		{ ...input, retention_days: 36_501 },
		{ ...input, api_key: 'PRIVATE' },
	])
		await assert.rejects(
			api.upsertDataPolicy(routeId, invalidInput as never),
			(error) => error instanceof Error && !error.message.includes('PRIVATE')
		)
	assert.equal(calls.length, 1)
	assert.equal(dataPolicyUpsertInputSchema.safeParse(input).success, true)
	await assert.rejects(
		fixture(() =>
			ok({ ...policy, route_target_id: 'route/other' })
		).api.upsertDataPolicy(routeId, input),
		invalid
	)
})

test('permission, missing route, conflict and service failures preserve status without leaking backend messages', async () => {
	for (const status of [401, 403, 404, 409, 503]) {
		const { api } = fixture(async () =>
			Response.json(
				{ success: false, message: 'PRIVATE administrator details' },
				{ status }
			)
		)
		await assert.rejects(
			api.upsertDataPolicy(routeId, input),
			(error) =>
				error instanceof AdminDomainWriteError &&
				error.status === status &&
				!error.message.includes('PRIVATE')
		)
	}
	await assert.rejects(
		fixture(async () =>
			Response.json({ success: false, message: 'PRIVATE' })
		).api.dataPolicyList(),
		(error) =>
			error instanceof CinaTokenApiError &&
			error.code === 'business' &&
			!error.message.includes('PRIVATE')
	)
})

test('caller cancellation and timeouts are terminal, including late injected responses', async () => {
	const controller = new AbortController()
	const { api } = fixture(async () => {
		controller.abort()
		return Response.json({ success: true, data: [joined] })
	})
	await assert.rejects(
		api.dataPolicyList({ signal: controller.signal }),
		(error) => error instanceof CinaTokenApiError && error.code === 'cancelled'
	)
	const timeout = fixture(
		(call) =>
			new Promise<Response>((_resolve, reject) => {
				call.init.signal?.addEventListener(
					'abort',
					() => reject(new Error('aborted')),
					{ once: true }
				)
			})
	)
	await assert.rejects(
		timeout.api.dataPolicyList({ timeoutMs: 1 }),
		(error) => error instanceof CinaTokenApiError && error.code === 'timeout'
	)
})

test('missing or partial policy read-set and fresh identity drift issue no business writes', async () => {
	const f = fixture(() => ok({ ...policy, retention_days: 0 }))
	const options = {
		expectedConsoleSubject: 'fixture-subject',
		expectedUserId: 'fixture-user',
		onDispatch: () => {
			throw Error('Unexpected dispatch')
		},
	}
	for (const expectedPolicy of [
		undefined,
		{ route_target_id: routeId, current_subject_fingerprint: 'a'.repeat(64) },
		{
			route_target_id: 'other',
			current_subject_fingerprint: 'a'.repeat(64),
			current_policy_fingerprint: null,
		},
	])
		await assert.rejects(
			f.rawApi.upsertDataPolicy(routeId, input, { ...options, expectedPolicy }),
			(error) =>
				error instanceof AdminDomainWriteError && error.code === 'subject'
		)
	assert.equal(f.allCalls.length, 0)
	await assert.rejects(
		f.api.upsertDataPolicy(routeId, input, { expectedUserId: 'other' }),
		(error) =>
			error instanceof AdminDomainWriteError && error.code === 'subject'
	)
	assert.equal(f.calls.length, 0)
	assert.deepEqual(
		f.allCalls.map((call) => call.path),
		['/api/auth/check', '/api/user/me']
	)
})
test('lost or semantically different ACK leaves a durable generation across refresh; safe GET never clears it', async () => {
	for (const kind of ['lost', 'different'] as const) {
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
		const f = fixture(async (call) => {
			if (call.init.method !== 'PUT') return ok([joined])
			return ok({ ...policy, retention_days: kind === 'different' ? 30 : 0 })
		}, kind !== 'lost')
		await assert.rejects(
			f.api.upsertDataPolicy(routeId, input, {
				onDispatch: (operation) => {
					assert.equal(operation, 'update')
					recovery.markPending(identity, 'data-policies', operation)
				},
			}),
			(error) =>
				error instanceof AdminDomainWriteError && error.code === 'unknown'
		)
		const marker = recovery.marker(identity, 'data-policies')
		assert.ok(marker)
		const afterRefresh = new AdminDomainWriteRecovery(storage)
		const epoch2 = JSON.stringify(['fixture-user', 'fixture-subject', 2])
		assert.deepEqual(afterRefresh.marker(epoch2, 'data-policies'), marker)
		await f.api.dataPolicyList({ expectedConsoleSubject: 'fixture-subject' })
		assert.deepEqual(afterRefresh.marker(epoch2, 'data-policies'), marker)
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1)
		await reviewAdminDomainUnknown({
			options: {
				expectedConsoleSubject: 'fixture-subject',
				expectedUserId: 'fixture-user',
			},
			verify: f.api.verifyAdminDomainSubject,
			observe: (options) => f.api.dataPolicyList(options),
			reviewedExternal: true,
			acceptsUnknown: true,
		})
		assert.deepEqual(afterRefresh.marker(epoch2, 'data-policies'), marker)
		afterRefresh.acknowledgeUnknown(epoch2, marker)
		assert.equal(afterRefresh.status(epoch2, 'data-policies'), 'ready')
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 1)
		assert.equal(
			[...values.values()].some(
				(value) => value.includes(routeId) || value.includes('evidence')
			),
			false
		)
	}
})

test('listing requires an explicit writable capability while legacy reads remain available', async () => {
	for (const capability of [undefined, false, true]) {
		const f = fixture(async () =>
			Response.json({
				success: true,
				data: [joined],
				...(capability === undefined ? {} : { canWrite: capability }),
			})
		)
		const listing = await f.rawApi.dataPolicyListing({
			expectedConsoleSubject: 'fixture-subject',
		})
		assert.equal(listing.canWrite, capability === true)
		assert.equal(listing.data.length, 1)
		assert.equal((await f.api.dataPolicyList()).length, 1)
		assert.equal(f.calls.filter((call) => call.init.method === 'PUT').length, 0)
	}
})
