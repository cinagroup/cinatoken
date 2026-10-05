import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { CinaTokenApiError, createCinaTokenApi } from '../api'
import type { AuthCheck } from '../contracts'
import { deferred } from '../test-fixtures'
import {
	CinaTokenConsoleSessionController,
	type ConsoleSessionApi,
	type ConsoleSessionIdentity,
	type ConsoleScopeInvalidation,
} from './console-session'

const alice: ConsoleSessionIdentity = {
	userId: 'user:alice',
	subject: 'alice',
	epoch: 1,
}
const bob: ConsoleSessionIdentity = {
	userId: 'user:bob',
	subject: 'bob',
	epoch: 2,
}
const verified: AuthCheck = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject: alice.subject,
}

function responseApi(response: unknown): ConsoleSessionApi {
	// Deliberately exercise runtime validation even when a typed injector is malformed.
	return { authCheck: async () => response as AuthCheck }
}

test('console session requires an explicit portal association and never checks implicitly', async () => {
	let requests = 0
	const session = new CinaTokenConsoleSessionController({
		authCheck: async () => {
			requests += 1
			return verified
		},
	})
	await session.refresh()
	assert.equal(requests, 0)
	assert.equal(session.getSnapshot().status, 'forbidden')
	assert.equal(session.getSnapshot().reason, 'identity_required')
	session.setIdentity(alice)
	assert.equal(requests, 0)
	assert.equal(session.getSnapshot().status, 'checking')
	assert.equal(session.getSnapshot().canWrite, false)
	await session.refresh()
	assert.equal(requests, 1)
	assert.equal(session.getSnapshot().status, 'verified')
	assert.equal(session.getSnapshot().canWrite, true)
	assert.deepEqual(session.getSnapshot().identity, alice)
})

test('only an authenticated verified console grants access; API keys and popup-like claims do not', async () => {
	for (const check of [
		{ ...verified, principalType: 'api_key' },
		{ ...verified, principalType: 'portal_user' },
		{ ...verified, principalType: undefined },
		{ ...verified, subject: undefined },
		{ ...verified, subject: bob.subject },
		{ ...verified, subject: `cinaauth:${alice.subject}` },
		{ ...verified, authenticated: false },
		{ ...verified, verification: 'none' },
		{ ...verified, verification: 'rejected' },
		{ authenticated: false, verification: 'none', isAdmin: true },
	]) {
		const session = new CinaTokenConsoleSessionController(responseApi(check))
		session.setIdentity({ ...alice, isAdmin: true } as ConsoleSessionIdentity)
		await session.refresh()
		assert.equal(session.getSnapshot().status, 'forbidden')
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(session.getSnapshot().reason, 'console_required')
		assert.equal('isAdmin' in (session.getSnapshot().identity ?? {}), false)
	}
})

test('malformed checks and CinaAuth degradation are indeterminate and never grant writes', async () => {
	for (const response of [
		null,
		{},
		{ ...verified, authenticated: 'true' },
		{ ...verified, verification: 'unknown' },
		{ ...verified, verification: 'degraded' },
	]) {
		const session = new CinaTokenConsoleSessionController(responseApi(response))
		session.setIdentity(alice)
		await session.refresh()
		assert.equal(session.getSnapshot().status, 'degraded')
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(session.getSnapshot().error, 'console_check_unavailable')
	}
})

test('refresh blocks writes synchronously, consumes revocation cleanup, and permits explicit recovery', async () => {
	let check = verified
	const events: ConsoleScopeInvalidation[] = []
	const session: CinaTokenConsoleSessionController =
		new CinaTokenConsoleSessionController(
			{ authCheck: async () => check },
			(event) => {
				assert.equal(session.getSnapshot().canWrite, false)
				events.push(event)
			}
		)
	session.setIdentity(alice)
	await session.refresh()
	const version = session.getSnapshot().accessVersion
	check = { authenticated: false, verification: 'rejected' }
	const refresh = session.refresh()
	assert.equal(session.getSnapshot().canWrite, false)
	assert.equal(session.getSnapshot().isRefreshing, true)
	assert.ok(session.getSnapshot().accessVersion > version)
	await refresh
	assert.equal(session.getSnapshot().status, 'forbidden')
	assert.equal(events.at(-1)?.reason, 'recheck')
	assert.deepEqual(events.at(-1)?.identity, alice)
	check = verified
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'verified')
})

test('an established identity survives degraded verification but loses access until retry succeeds', async () => {
	let check = verified
	let calls = 0
	const session = new CinaTokenConsoleSessionController({
		authCheck: async () => {
			calls += 1
			return check
		},
	})
	session.setIdentity(alice)
	await session.refresh()
	check = { ...verified, verification: 'degraded' }
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'degraded')
	assert.deepEqual(session.getSnapshot().identity, alice)
	assert.equal(session.getSnapshot().canWrite, false)
	await setImmediate()
	assert.equal(calls, 2, 'degradation never retries autonomously')
	check = verified
	await session.refresh()
	assert.equal(session.getSnapshot().canWrite, true)
})

test('401/403 revoke console access while transient transport failures remain retryable and sanitized', async () => {
	for (const status of [401, 403, 429, 500, 503, 0]) {
		const session = new CinaTokenConsoleSessionController({
			authCheck: async () => {
				throw new CinaTokenApiError('private upstream response', status, 'http')
			},
		})
		session.setIdentity(alice)
		await session.refresh()
		assert.equal(
			session.getSnapshot().status,
			status === 401 || status === 403 ? 'forbidden' : 'degraded'
		)
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(
			JSON.stringify(session.getSnapshot()).includes('private'),
			false
		)
	}
})

test('concurrent refreshes share one check and unchanged identity does not invalidate it', async () => {
	const check = deferred<AuthCheck>()
	const started = deferred<AbortSignal | undefined>()
	let calls = 0
	const session = new CinaTokenConsoleSessionController({
		authCheck: (options) => {
			calls += 1
			started.resolve(options?.signal)
			return check.promise
		},
	})
	session.setIdentity(alice)
	const first = session.refresh()
	assert.equal(session.refresh(), first)
	const signal = await started.promise
	const version = session.getSnapshot().accessVersion
	session.setIdentity({ ...alice })
	assert.equal(session.getSnapshot().accessVersion, version)
	assert.equal(signal?.aborted, false)
	check.resolve(verified)
	await first
	assert.equal(calls, 1)
	assert.equal(session.getSnapshot().canWrite, true)
})

test(
	'user, subject and epoch changes abort the old check and refuse late responses',
	{ timeout: 2000 },
	async () => {
		for (const identity of [
			bob,
			{ ...alice, subject: 'replacement' },
			{ ...alice, epoch: 2 },
		]) {
			const old = deferred<AuthCheck>()
			const started = deferred<AbortSignal | undefined>()
			let calls = 0
			const session = new CinaTokenConsoleSessionController({
				authCheck: (options) => {
					calls += 1
					if (calls === 1) {
						started.resolve(options?.signal)
						return old.promise
					}
					return Promise.resolve({
						authenticated: false,
						verification: 'rejected',
					})
				},
			})
			session.setIdentity(alice)
			const pending = session.refresh()
			const signal = await started.promise
			session.setIdentity(identity)
			assert.equal(session.getSnapshot().canWrite, false)
			assert.equal(signal?.aborted, true)
			await pending // The old injector deliberately ignores AbortSignal.
			await session.refresh()
			const snapshot = session.getSnapshot()
			old.resolve(verified)
			await setImmediate()
			assert.equal(session.getSnapshot(), snapshot)
			assert.deepEqual(snapshot.identity, identity)
			assert.equal(snapshot.status, 'forbidden')
		}
	}
)

test('new authorization waits for old cleanup to finish, including overlapping identity changes', async () => {
	const cleanup = deferred<void>()
	const started = deferred<void>()
	let delayCleanup = false
	let calls = 0
	let serverSubject = alice.subject
	const session = new CinaTokenConsoleSessionController(
		{
			authCheck: async () => {
				calls += 1
				return { ...verified, subject: serverSubject }
			},
		},
		async (event) => {
			if (delayCleanup && event.identity?.userId === alice.userId) {
				started.resolve()
				await cleanup.promise
			}
		}
	)
	session.setIdentity(alice)
	await session.refresh()
	delayCleanup = true
	serverSubject = bob.subject
	session.setIdentity(bob)
	const pending = session.refresh()
	await started.promise
	assert.equal(calls, 1)
	assert.equal(session.getSnapshot().canWrite, false)
	cleanup.resolve()
	await pending
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().status, 'verified')
	assert.deepEqual(session.getSnapshot().identity, bob)
})

test('a failed old-identity cleanup cannot be hidden by successful new-identity cleanup', async () => {
	let failOld = false
	let calls = 0
	let serverSubject = alice.subject
	const cachedScopes = new Set<string>()
	const session = new CinaTokenConsoleSessionController(
		{
			authCheck: async () => {
				calls += 1
				return { ...verified, subject: serverSubject }
			},
		},
		(event) => {
			if (event.identity?.userId === alice.userId && failOld)
				throw new Error('private cleanup error')
			if (event.identity) cachedScopes.delete(event.identity.userId)
		}
	)
	session.setIdentity(alice)
	await session.refresh()
	cachedScopes.add(alice.userId)
	failOld = true
	serverSubject = bob.subject
	session.setIdentity(bob)
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'degraded')
	assert.equal(session.getSnapshot().error, 'console_cleanup_failed')
	assert.equal(session.getSnapshot().canWrite, false)
	assert.equal(
		calls,
		1,
		'no identity check occurs while privileged cleanup is incomplete'
	)
	assert.equal(cachedScopes.has(alice.userId), true)
	failOld = false
	await session.refresh()
	assert.equal(cachedScopes.size, 0)
	assert.equal(calls, 2)
	assert.equal(session.getSnapshot().canWrite, true)
})

test(
	'cancel settles an ignored-abort check promptly and allows a new explicit check',
	{ timeout: 2000 },
	async () => {
		const old = deferred<AuthCheck>()
		const started = deferred<AbortSignal | undefined>()
		let calls = 0
		const session = new CinaTokenConsoleSessionController({
			authCheck: (options) => {
				calls += 1
				if (calls === 1) {
					started.resolve(options?.signal)
					return old.promise
				}
				return Promise.resolve(verified)
			},
		})
		session.setIdentity(alice)
		const pending = session.refresh()
		const signal = await started.promise
		session.cancelRefresh()
		assert.equal(signal?.aborted, true)
		await pending
		assert.equal(session.getSnapshot().status, 'degraded')
		assert.equal(session.getSnapshot().error, 'console_check_cancelled')
		await session.refresh()
		const snapshot = session.getSnapshot()
		old.reject(new Error('late upstream failure'))
		await setImmediate()
		assert.equal(session.getSnapshot(), snapshot)
		assert.equal(snapshot.canWrite, true)
	}
)

test(
	'cancellation during cleanup cannot call authCheck or regain authority when cleanup completes',
	{ timeout: 2000 },
	async () => {
		const cleanup = deferred<void>()
		const started = deferred<void>()
		let calls = 0
		const session = new CinaTokenConsoleSessionController(
			{
				authCheck: async () => {
					calls += 1
					return verified
				},
			},
			async () => {
				started.resolve()
				await cleanup.promise
			}
		)
		session.setIdentity(alice)
		const pending = session.refresh()
		await started.promise
		session.cancelRefresh()
		await pending
		cleanup.resolve()
		await setImmediate()
		assert.equal(calls, 0)
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(session.getSnapshot().error, 'console_check_cancelled')
	}
)

test(
	'clear and local logout remove identity and cannot be reversed by a late verified response',
	{ timeout: 2000 },
	async () => {
		for (const method of ['clear', 'logout'] as const) {
			const old = deferred<AuthCheck>()
			const started = deferred<AbortSignal | undefined>()
			const events: ConsoleScopeInvalidation[] = []
			let calls = 0
			const session = new CinaTokenConsoleSessionController(
				{
					authCheck: (options) => {
						calls += 1
						started.resolve(options?.signal)
						return old.promise
					},
				},
				(event) => {
					events.push(event)
				}
			)
			session.setIdentity(alice)
			const pending = session.refresh()
			const signal = await started.promise
			session[method]()
			await pending
			assert.equal(signal?.aborted, true)
			await session.refresh()
			old.resolve(verified)
			await setImmediate()
			assert.equal(calls, 1)
			assert.equal(session.getSnapshot().identity, null)
			assert.equal(session.getSnapshot().canWrite, false)
			assert.equal(
				session.getSnapshot().reason,
				method === 'logout' ? 'logged_out' : 'identity_required'
			)
			assert.equal(events.at(-1)?.reason, method)
			assert.deepEqual(events.at(-1)?.identity, alice)
		}
	}
)

test(
	'dispose is terminal, revokes verified access, and cannot restart through a stale provider',
	{ timeout: 2000 },
	async () => {
		const old = deferred<AuthCheck>()
		const started = deferred<void>()
		let calls = 0
		const events: ConsoleScopeInvalidation[] = []
		const session = new CinaTokenConsoleSessionController(
			{
				authCheck: () => {
					calls += 1
					if (calls === 1) return Promise.resolve(verified)
					started.resolve()
					return old.promise
				},
			},
			(event) => {
				events.push(event)
			}
		)
		session.setIdentity(alice)
		await session.refresh()
		const pending = session.refresh()
		await started.promise
		session.dispose()
		await pending
		session.setIdentity(bob)
		await session.refresh()
		session.dispose()
		old.resolve(verified)
		await setImmediate()
		assert.equal(calls, 2)
		assert.equal(session.getSnapshot().reason, 'disposed')
		assert.equal(session.getSnapshot().identity, null)
		assert.equal(session.getSnapshot().canWrite, false)
		assert.equal(events.at(-1)?.reason, 'dispose')
	}
)

test('subscription cleanup and immutable snapshots protect the caller-supplied association', async () => {
	const mutableIdentity = { ...alice }
	const session = new CinaTokenConsoleSessionController(responseApi(verified))
	let notifications = 0
	const unsubscribe = session.subscribe(() => {
		notifications += 1
	})
	session.setIdentity(mutableIdentity)
	mutableIdentity.userId = bob.userId
	await session.refresh()
	assert.deepEqual(session.getSnapshot().identity, alice)
	assert.equal(Object.isFrozen(session.getSnapshot()), true)
	assert.equal(Object.isFrozen(session.getSnapshot().identity), true)
	const count = notifications
	unsubscribe()
	session.clear()
	assert.equal(notifications, count)
	session.dispose()
	const afterDispose = session.subscribe(() => {
		notifications += 1
	})
	await session.refresh()
	afterDispose()
	assert.equal(notifications, count)
})

test('invalid identity input revokes a previous grant instead of preserving privileged state', async () => {
	const session = new CinaTokenConsoleSessionController(responseApi(verified))
	session.setIdentity(alice)
	await session.refresh()
	assert.throws(() => session.setIdentity({ ...alice, epoch: NaN }), TypeError)
	assert.equal(session.getSnapshot().identity, null)
	assert.equal(session.getSnapshot().canWrite, false)
})

test(
	'clear supports StrictMode setup-cleanup-setup without reusing an aborted grant',
	{ timeout: 2000 },
	async () => {
		const old = deferred<AuthCheck>()
		const started = deferred<AbortSignal | undefined>()
		let calls = 0
		const session = new CinaTokenConsoleSessionController({
			authCheck: (options) => {
				calls += 1
				if (calls === 1) {
					started.resolve(options?.signal)
					return old.promise
				}
				return Promise.resolve(verified)
			},
		})
		session.setIdentity(alice)
		const initial = session.refresh()
		const signal = await started.promise
		session.clear()
		session.setIdentity(alice)
		const repeated = session.refresh()
		assert.notEqual(initial, repeated)
		assert.equal(signal?.aborted, true)
		assert.equal(session.getSnapshot().canWrite, false)
		await Promise.all([initial, repeated])
		const current = session.getSnapshot()
		assert.equal(current.canWrite, true)
		assert.equal(calls, 2)
		old.resolve({ authenticated: false, verification: 'rejected' })
		await setImmediate()
		assert.equal(session.getSnapshot(), current)
	}
)

test('failed cleanup survives clear and must succeed before a reused controller can grant a new identity', async () => {
	const cachedUsers = new Set<string>()
	let failCleanup = false
	let serverSubject = alice.subject
	let calls = 0
	const session = new CinaTokenConsoleSessionController(
		{
			authCheck: async () => {
				calls += 1
				return { ...verified, subject: serverSubject }
			},
		},
		async (event) => {
			await setImmediate()
			if (event.identity?.userId === alice.userId && failCleanup)
				throw new Error('Private cache cleanup failure')
			if (event.identity) cachedUsers.delete(event.identity.userId)
		}
	)
	session.setIdentity(alice)
	await session.refresh()
	cachedUsers.add(alice.userId)
	failCleanup = true
	session.clear()
	serverSubject = bob.subject
	session.setIdentity(bob)
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'degraded')
	assert.equal(session.getSnapshot().error, 'console_cleanup_failed')
	assert.equal(session.getSnapshot().canWrite, false)
	assert.equal(cachedUsers.has(alice.userId), true)
	assert.equal(calls, 1)
	failCleanup = false
	await session.refresh()
	assert.equal(cachedUsers.size, 0)
	assert.deepEqual(session.getSnapshot().identity, bob)
	assert.equal(session.getSnapshot().canWrite, true)
	assert.equal(calls, 2)
})

test('public Cookie transport preserves the server-verified subject and never fabricates caller metadata', async () => {
	const api = createCinaTokenApi(async (input, init) => {
		assert.equal(String(input), '/api/auth/check')
		assert.equal(init?.credentials, 'same-origin')
		assert.equal(init?.cache, 'no-store')
		const headers = new Headers(init?.headers)
		assert.equal(headers.get('Authorization'), null)
		assert.equal(headers.get('New-Api-User'), null)
		assert.equal(headers.get('X-CinaToken-Workspace'), null)
		return Response.json(verified)
	})
	const session = new CinaTokenConsoleSessionController(api)
	session.setIdentity(alice)
	await session.refresh()
	assert.equal(session.getSnapshot().status, 'verified')
	assert.deepEqual(session.getSnapshot().identity, alice)
	assert.equal((await api.authCheck()).subject, alice.subject)
})

test('public Cookie transport cannot grant console access for another subject or an old server without proof', async () => {
	for (const subject of [undefined, bob.subject]) {
		const api = createCinaTokenApi(async () =>
			Response.json({ ...verified, subject })
		)
		const session = new CinaTokenConsoleSessionController(api)
		session.setIdentity(alice)
		await session.refresh()
		assert.equal(session.getSnapshot().status, 'forbidden')
		assert.equal(session.getSnapshot().canWrite, false)
	}
})

test(
	'public transport cancellation prevents a late server response from restoring console access',
	{ timeout: 2000 },
	async () => {
		const response = deferred<Response>()
		const started = deferred<AbortSignal | null | undefined>()
		const api = createCinaTokenApi((_input, init) => {
			started.resolve(init?.signal)
			return response.promise
		})
		const session = new CinaTokenConsoleSessionController(api)
		session.setIdentity(alice)
		const pending = session.refresh()
		const signal = await started.promise
		session.logout()
		await pending
		assert.equal(signal?.aborted, true)
		response.resolve(Response.json(verified))
		await setImmediate()
		assert.equal(session.getSnapshot().identity, null)
		assert.equal(session.getSnapshot().canWrite, false)
	}
)
