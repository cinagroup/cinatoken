/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
	AUTH_POPUP_TIMEOUT_MS,
	type AuthPopupReservation,
	type LoginOptions,
} from '../../auth-popup-contract'
import { PublicAuthController } from './public-auth-controller'
import type {
	PublicAuthRuntime,
	PublicAuthRuntimeModule,
	PublicAuthSnapshot,
} from './public-auth-types'

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((yes, no) => {
		resolve = yes
		reject = no
	})
	return { promise, resolve, reject }
}
const flush = async () => {
	await new Promise((resolve) => setImmediate(resolve))
}

function fixture(blocked = false) {
	const events: string[] = [],
		navigations: string[] = [],
		reservations: AuthPopupReservation[] = []
	const loaded = deferred<PublicAuthRuntimeModule>()
	let time = 1_000,
		released = 0,
		focus = 0,
		notifications = 0,
		factories = 0,
		disposed = 0
	let expire: () => void = () => undefined
	let logout: () => void = () => undefined
	const states: Array<{
		verified: (options: LoginOptions) => void
		emit: (snapshot: PublicAuthSnapshot) => void
	}> = []
	const module: PublicAuthRuntimeModule = {
		createPublicAuthRuntime(verified) {
			factories++
			let snapshot: PublicAuthSnapshot = { phase: 'waiting', error: null }
			let listener: () => void = () => undefined
			states.push({
				verified,
				emit(value) {
					snapshot = value
					listener()
				},
			})
			const runtime: PublicAuthRuntime = {
				getSnapshot: () => snapshot,
				subscribe(callback) {
					listener = callback
					events.push('subscribed')
					return () => {
						listener = () => undefined
					}
				},
				begin() {
					events.push('adopted')
					listener()
				},
				refocus() {
					focus++
				},
				dispose() {
					disposed++
				},
			}
			return runtime
		},
	}
	const controller = new PublicAuthController({
		loadRuntime() {
			events.push('load')
			return loaded.promise
		},
		reserve(options) {
			events.push('reserve')
			if (blocked) return null
			const reservation = {
				requestId: crypto.randomUUID(),
				popup: {
					focus() {
						focus++
					},
				} as Window,
				options: { ...options },
				startedAt: time,
			}
			reservations.push(reservation)
			return reservation
		},
		release() {
			released++
		},
		logout(cancel) {
			logout = cancel
			return () => {
				logout = () => undefined
			}
		},
		notify() {
			notifications++
		},
		navigate(path) {
			navigations.push(path)
		},
		now: () => time,
		schedule(callback, delay) {
			expire = callback
			const timer = setTimeout(callback, delay)
			timer.unref()
			return timer
		},
		clear: clearTimeout,
	})
	const opener = {
		isConnected: true,
		focus() {
			focus++
		},
	} as HTMLElement
	return {
		controller,
		events,
		states,
		module,
		reservations,
		navigations,
		loaded,
		opener,
		expire: () => expire(),
		logout: () => logout(),
		advance: (milliseconds: number) => {
			time += milliseconds
		},
		get released() {
			return released
		},
		get focus() {
			return focus
		},
		get notifications() {
			return notifications
		},
		get factories() {
			return factories
		},
		get disposed() {
			return disposed
		},
	}
}

test('SSR construction does no I/O; the click reserves once before loading and listener precedes adoption', async () => {
	const f = fixture()
	try {
		assert.deepEqual(f.events, [])
		assert.deepEqual(f.controller.getServerSnapshot(), {
			phase: 'idle',
			error: null,
		})
		f.controller.begin({ intent: 'portal', callbackPath: '/account' }, f.opener)
		f.controller.begin({ intent: 'admin', callbackPath: '/dashboard' })
		assert.deepEqual(f.events, ['reserve', 'load'])
		assert.equal(f.reservations.length, 1)
		assert.equal(f.focus, 1)
		assert.equal(f.controller.getSnapshot().phase, 'loading')
		f.loaded.resolve(f.module)
		await flush()
		assert.deepEqual(f.events, ['reserve', 'load', 'subscribed', 'adopted'])
		assert.equal(f.controller.getSnapshot().phase, 'waiting')
		f.states[0].verified(f.reservations[0].options)
		assert.deepEqual(f.navigations, ['/account'])
		assert.equal(f.notifications, 1)
		assert.equal(f.disposed, 1)
		f.states[0].verified({ callbackPath: '/dashboard' })
		assert.equal(f.navigations.length, 1)
	} finally {
		f.controller.dispose()
	}
})

test('a blocked reservation does not load private runtime or create cleanup resources', () => {
	const f = fixture(true)
	f.controller.begin({ register: true })
	assert.deepEqual(f.events, ['reserve'])
	assert.equal(f.reservations.length, 0)
	assert.equal(f.controller.getSnapshot().phase, 'idle')
	assert.equal(f.notifications, 0)
})

test('cancelling during lazy loading releases the reserved window and ignores the late module', async () => {
	const f = fixture()
	f.controller.begin({ callbackPath: '/account' }, f.opener)
	f.controller.cancel()
	f.loaded.resolve(f.module)
	await flush()
	assert.equal(f.released, 1)
	assert.equal(f.factories, 0)
	assert.equal(f.focus, 1)
	assert.deepEqual(f.navigations, [])
	assert.equal(f.notifications, 0)
	assert.equal(f.controller.getSnapshot().phase, 'idle')
})

test('synchronous cancellation when loading is published never starts the lazy runtime', async () => {
	const f = fixture()
	const unsubscribe = f.controller.subscribe(() => {
		if (f.controller.getSnapshot().phase === 'loading') f.controller.cancel()
	})
	try {
		f.controller.begin({ callbackPath: '/account' }, f.opener)
		assert.deepEqual(f.events, ['reserve'])
		assert.equal(f.released, 1)
		assert.equal(f.controller.getSnapshot().phase, 'idle')
		f.loaded.resolve(f.module)
		await flush()
		assert.equal(f.factories, 0)
		assert.equal(f.notifications, 0)
		assert.deepEqual(f.navigations, [])
	} finally {
		unsubscribe()
		f.controller.dispose()
	}
})

test('an expired lazy load shows a safe retry error and retry uses a distinct transaction', async () => {
	const f = fixture()
	try {
		f.controller.begin(
			{ intent: 'admin', callbackPath: '/dashboard' },
			f.opener
		)
		f.advance(AUTH_POPUP_TIMEOUT_MS)
		f.expire()
		assert.equal(f.released, 1)
		assert.equal(f.controller.getSnapshot().error, 'popup_expired')
		f.controller.retry()
		assert.notEqual(f.reservations[0].requestId, f.reservations[1].requestId)
		f.loaded.resolve(f.module)
		await flush()
		assert.equal(f.factories, 1)
		f.states[0].verified(f.reservations[1].options)
		assert.deepEqual(f.navigations, ['/dashboard'])
	} finally {
		f.controller.dispose()
	}
})

test('load rejection closes the blank popup, restores focus and does not expose exception text', async () => {
	const f = fixture()
	f.controller.begin({ register: true }, f.opener)
	f.loaded.reject(new Error('private diagnostic secret marker'))
	await flush()
	assert.equal(f.released, 1)
	assert.equal(f.focus, 1)
	assert.deepEqual(f.controller.getSnapshot(), {
		phase: 'error',
		error: 'runtime_unavailable',
	})
	assert.deepEqual(f.navigations, [])
})

test('dismissing an authentication error restores its opener and discards the failed retry target', async () => {
	const f = fixture()
	f.controller.begin({ callbackPath: '/account' }, f.opener)
	f.loaded.reject(new Error('load failed'))
	await flush()
	assert.equal(f.controller.getSnapshot().phase, 'error')
	assert.equal(f.focus, 1)
	f.controller.cancel()
	assert.equal(f.focus, 2)
	assert.equal(f.controller.getSnapshot().phase, 'idle')
	f.controller.retry()
	assert.equal(f.reservations.length, 1)
})

for (const cancellation of ['cancel', 'logout', 'dispose'] as const) {
	test(`${cancellation} during verification ignores stale success and cleans the active runtime once`, async () => {
		const f = fixture()
		f.controller.begin(
			{ intent: 'admin', callbackPath: '/dashboard' },
			f.opener
		)
		f.loaded.resolve(f.module)
		await flush()
		f.states[0].emit({ phase: 'verifying', error: null })
		if (cancellation === 'logout') f.logout()
		else f.controller[cancellation]()
		f.states[0].verified({ callbackPath: '/dashboard' })
		assert.equal(f.disposed, 1)
		assert.equal(f.notifications, 0)
		assert.deepEqual(f.navigations, [])
		assert.equal(f.controller.getSnapshot().phase, 'idle')
	})
}

test('server rejection finishes the attempt; its late success cannot override a new retry', async () => {
	const f = fixture()
	try {
		f.controller.begin({ callbackPath: '/account' })
		f.loaded.resolve(f.module)
		await flush()
		f.states[0].emit({ phase: 'error', error: 'oidc_failed' })
		assert.equal(f.controller.getSnapshot().error, 'oidc_failed')
		assert.equal(f.disposed, 1)
		f.controller.retry()
		await flush()
		f.states[0].verified({ callbackPath: '/dashboard' })
		assert.deepEqual(f.navigations, [])
		assert.equal(f.controller.getSnapshot().phase, 'waiting')
		f.states[1].verified(f.reservations[1].options)
		assert.deepEqual(f.navigations, ['/account'])
	} finally {
		f.controller.dispose()
	}
})

test('verified completion after its absolute deadline is never notified or navigated', async () => {
	const f = fixture()
	f.controller.begin({ callbackPath: '/account' })
	f.loaded.resolve(f.module)
	await flush()
	f.advance(AUTH_POPUP_TIMEOUT_MS)
	f.states[0].verified({ callbackPath: '/account' })
	assert.equal(f.disposed, 1)
	assert.equal(f.notifications, 0)
	assert.deepEqual(f.navigations, [])
	assert.equal(f.controller.getSnapshot().error, 'popup_expired')
})
