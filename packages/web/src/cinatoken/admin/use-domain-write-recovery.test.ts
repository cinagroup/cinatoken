/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError, createCinaTokenCookieTransport } from '../api'
import { deferred } from '../test-fixtures'
import { reviewAdminDomainUnknown } from './domain-manual-recovery'
import {
	AdminDomainWriteError,
	AdminDomainWriteRecovery,
	type AdminDomainPendingMarker,
} from './domain-write-recovery'
import { createModelsApi } from './model-api'

// These exercise the real SDK, review protocol and generation store. Mounted
// controller state (capability, busy and dialog lifecycle) needs browser coverage.
const identity = JSON.stringify(['review-user', 'review-subject', 1])
const authPath = '/api/auth/check'
const mePath = '/api/user/me'
const observationPath = '/api/admin/models'
type Call = { path: string; init: RequestInit }
type Fixture = {
	api: ReturnType<typeof createModelsApi>
	calls: Call[]
	store: AdminDomainWriteRecovery
	marker: AdminDomainPendingMarker
	storage: {
		getItem: (key: string) => string | null
		setItem: (key: string, value: string) => void
		removeItem: (key: string) => void
	}
}
function response(call: Call): Response {
	if (call.path === authPath)
		return Response.json({
			authenticated: true,
			verification: 'verified',
			principalType: 'console',
			subject: 'review-subject',
		})
	if (call.path === mePath)
		return Response.json({
			success: true,
			data: {
				userId: 'review-user',
				subject: 'review-subject',
				email: 'review@example.test',
				isAdmin: true,
				capabilities: ['models.manage'],
				organizations: [],
			},
		})
	assert.equal(call.path, observationPath)
	return Response.json({
		success: true,
		data: [],
		count: 0,
		billing_currency: 'USD',
	})
}
function fixture(
	reply: (
		call: Call,
		occurrence: number
	) => Response | Promise<Response> = response
): Fixture {
	const values = new Map<string, string>()
	const storage = {
		getItem: (key: string): string | null => values.get(key) ?? null,
		setItem: (key: string, value: string): void => {
			values.set(key, value)
		},
		removeItem: (key: string): void => {
			values.delete(key)
		},
	}
	const store = new AdminDomainWriteRecovery(storage)
	const marker = store.markPending(identity, 'models', 'update')
	const calls: Call[] = []
	const request: typeof fetch = async (input, init) => {
		const call = { path: String(input), init: init ?? {} }
		calls.push(call)
		return reply(call, calls.filter((item) => item.path === call.path).length)
	}
	const transport = createCinaTokenCookieTransport(request)
	const api = createModelsApi({
		send: transport.send,
		invalidResponse(message): never {
			throw new CinaTokenApiError(message, 200, 'invalid-response')
		},
		sanitizeError(error): Error {
			return error instanceof Error ? error : new Error('Invalid response')
		},
	})
	return { api, calls, store, marker, storage }
}
function review(f: Fixture, signal?: AbortSignal): Promise<void> {
	return reviewAdminDomainUnknown({
		options: {
			expectedConsoleSubject: 'review-subject',
			expectedUserId: 'review-user',
			signal,
		},
		verify: f.api.verifyAdminDomainSubject,
		observe: f.api.modelListContext,
		reviewedExternal: true,
		acceptsUnknown: true,
	})
}
function assertOnlyUncachedReads(f: Fixture): void {
	for (const call of f.calls) {
		assert.equal(call.init.method ?? 'GET', 'GET', 'no write or replay')
		assert.equal(call.init.cache, 'no-store')
		assert.equal(call.init.credentials, 'same-origin')
	}
}
function assertUnresolved(f: Fixture): void {
	assert.equal(f.store.status(identity, 'models'), 'pending')
	assert.deepEqual(f.store.marker(identity, 'models'), f.marker)
	assert.deepEqual(
		new AdminDomainWriteRecovery(f.storage).marker(identity, 'models'),
		f.marker,
		'a reload retains the exact generation'
	)
	assert.throws(
		() => f.store.markPending(identity, 'models', 'delete'),
		(error: unknown) =>
			error instanceof AdminDomainWriteError && error.code === 'storage'
	)
	assertOnlyUncachedReads(f)
}

test('successful real SDK review observes between two fresh identity checks and needs explicit generation acknowledgement', async () => {
	const f = fixture()
	await review(f)
	assert.deepEqual(
		f.calls.map((call) => call.path),
		[authPath, mePath, observationPath, authPath, mePath]
	)
	assertUnresolved(f)
	f.store.acknowledgeUnknown(identity, f.marker)
	assert.equal(f.store.status(identity, 'models'), 'ready')
})

for (const phase of ['observation', 'second fresh'] as const) {
	test(`held ${phase} response leaves the generation locked and blocks another dispatch`, async () => {
		const held = deferred<Response>()
		const entered = deferred<void>()
		const f = fixture((call, occurrence) => {
			if (
				(phase === 'observation' && call.path === observationPath) ||
				(phase === 'second fresh' && call.path === authPath && occurrence === 2)
			) {
				entered.resolve()
				return held.promise
			}
			return response(call)
		})
		const running = review(f)
		await entered.promise
		assertUnresolved(f)
		assert.equal(f.calls.length, phase === 'observation' ? 3 : 4)
		held.resolve(response(f.calls.at(-1)!))
		await running
		assertUnresolved(f)
	})
	test(`cancelling held ${phase} rejects even when fetch ignores AbortSignal and retains the generation`, async () => {
		const held = deferred<Response>()
		const entered = deferred<void>()
		const abort = new AbortController()
		const f = fixture((call, occurrence) => {
			if (
				(phase === 'observation' && call.path === observationPath) ||
				(phase === 'second fresh' && call.path === authPath && occurrence === 2)
			) {
				entered.resolve()
				return held.promise
			}
			return response(call)
		})
		const running = review(f, abort.signal)
		await entered.promise
		const rejected = assert.rejects(running)
		abort.abort()
		held.resolve(response(f.calls.at(-1)!))
		await rejected
		assertUnresolved(f)
		assert.equal(f.calls.length, phase === 'observation' ? 3 : 4)
	})
}

for (const checkpoint of [1, 2]) {
	for (const path of [authPath, mePath]) {
		for (const status of [401, 403]) {
			test(`fresh check ${checkpoint} ${path} HTTP ${status} cannot authorize clearing or replay`, async () => {
				const f = fixture((call, occurrence) => {
					if (call.path === path && occurrence === checkpoint)
						return Response.json({ message: 'Denied' }, { status })
					return response(call)
				})
				await assert.rejects(
					review(f),
					(error: unknown) =>
						error instanceof AdminDomainWriteError && error.code === 'subject'
				)
				assertUnresolved(f)
				assert.equal(
					f.calls.filter((call) => call.path === observationPath).length,
					checkpoint - 1
				)
			})
		}
	}
	for (const changed of ['subject', 'user'] as const) {
		test(`fresh check ${checkpoint} rejects ${changed} drift and retains the original generation`, async () => {
			const f = fixture(async (call, occurrence) => {
				const result = response(call)
				const path = changed === 'subject' ? authPath : mePath
				if (call.path !== path || occurrence !== checkpoint) return result
				if (changed === 'subject')
					return Response.json({
						authenticated: true,
						verification: 'verified',
						principalType: 'console',
						subject: 'other-subject',
					})
				const body = (await result.json()) as {
					success: true
					data: { userId: string }
				}
				body.data.userId = 'other-user'
				return Response.json(body)
			})
			await assert.rejects(
				review(f),
				(error: unknown) =>
					error instanceof AdminDomainWriteError && error.code === 'subject'
			)
			assertUnresolved(f)
			assert.equal(
				f.calls.filter((call) => call.path === observationPath).length,
				checkpoint - 1
			)
		})
	}
}

for (const failure of ['503', 'invalid JSON', 'malformed DTO'] as const) {
	test(`uncached observation ${failure} stops before the second fresh check without clearing or replay`, async () => {
		const f = fixture((call) => {
			if (call.path !== observationPath) return response(call)
			if (failure === '503')
				return Response.json({ message: 'Unavailable' }, { status: 503 })
			if (failure === 'invalid JSON') return new Response('{broken')
			return Response.json({ success: true, data: [], count: 0 })
		})
		await assert.rejects(review(f), CinaTokenApiError)
		assertUnresolved(f)
		assert.deepEqual(
			f.calls.map((call) => call.path),
			[authPath, mePath, observationPath]
		)
	})
}

test('a new identity cannot acknowledge another identity generation after a successful review', async () => {
	const f = fixture()
	await review(f)
	const changedIdentity = JSON.stringify(['review-user', 'other-subject', 2])
	assert.throws(() => f.store.acknowledgeUnknown(changedIdentity, f.marker))
	assertUnresolved(f)
	assert.equal(f.store.status(changedIdentity, 'models'), 'ready')
})

test('a concurrent new generation during the second fresh check survives stale manual acknowledgement', async () => {
	const held = deferred<Response>()
	const entered = deferred<void>()
	const f = fixture((call, occurrence) => {
		if (call.path === authPath && occurrence === 2) {
			entered.resolve()
			return held.promise
		}
		return response(call)
	})
	const running = review(f)
	await entered.promise
	f.store.settleKnown(identity, f.marker, 'confirmed-2xx')
	const next = f.store.markPending(identity, 'models', 'delete')
	held.resolve(response(f.calls.at(-1)!))
	await running
	assert.throws(() => f.store.acknowledgeUnknown(identity, f.marker))
	assert.equal(f.store.status(identity, 'models'), 'pending')
	assert.deepEqual(f.store.marker(identity, 'models'), next)
	assert.deepEqual(
		new AdminDomainWriteRecovery(f.storage).marker(identity, 'models'),
		next
	)
	assertOnlyUncachedReads(f)
})
