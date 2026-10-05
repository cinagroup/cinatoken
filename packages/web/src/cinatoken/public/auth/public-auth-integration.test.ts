/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCinaTokenApi } from '../../api'
import {
	AUTH_POPUP_MESSAGE,
	releaseAuthPopupReservation,
	reserveAuthPopup,
} from '../../auth-popup-contract'
import { PublicAuthController } from './public-auth-controller'
import { createPublicAuthRuntime } from './public-auth-runtime'

const identity = {
	userId: 'integration-user',
	subject: 'integration-subject',
	email: 'integration@example.invalid',
	isAdmin: true,
	capabilities: ['admin.console'],
	organizations: [],
}
const verifiedConsole = {
	authenticated: true,
	verification: 'verified',
	principalType: 'console',
	subject: identity.subject,
}

function browserFixture() {
	const globals = ['window', 'localStorage', 'BroadcastChannel']
	const previous = globals.map((key) =>
		Object.getOwnPropertyDescriptor(globalThis, key)
	)
	const listeners = new Map<string, Set<(event: unknown) => void>>()
	const popups: Array<{ path: string; closes: number }> = []
	let latestPopup: unknown
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			screenX: 0,
			screenY: 0,
			outerWidth: 1200,
			outerHeight: 900,
			location: { origin: 'https://integration.invalid' },
			open() {
				const record = { path: '', closes: 0 }
				popups.push(record)
				latestPopup = {
					location: {
						replace(path: string) {
							record.path = path
						},
					},
					focus() {},
					close() {
						record.closes++
					},
				}
				return latestPopup
			},
			addEventListener(key: string, callback: (event: unknown) => void) {
				const callbacks = listeners.get(key) ?? new Set()
				callbacks.add(callback)
				listeners.set(key, callbacks)
			},
			removeEventListener(key: string, callback: (event: unknown) => void) {
				listeners.get(key)?.delete(callback)
			},
		},
	})
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem: () => null, removeItem() {} },
	})
	Object.defineProperty(globalThis, 'BroadcastChannel', {
		configurable: true,
		value: class UnavailableChannel {
			constructor() {
				throw new Error('Optional transport unavailable')
			}
		},
	})
	return {
		popups,
		complete(ok: boolean) {
			const requestId = new URL(
				popups.at(-1)?.path ?? '',
				'https://integration.invalid'
			).searchParams.get('request')
			assert.ok(requestId)
			listeners.get('message')?.forEach((callback) =>
				callback({
					origin: 'https://integration.invalid',
					source: latestPopup,
					data: {
						type: AUTH_POPUP_MESSAGE,
						requestId,
						ok,
						...(ok ? {} : { error: 'oidc_failed' }),
					},
				})
			)
		},
		listenerCount: () =>
			[...listeners.values()].reduce(
				(sum, callbacks) => sum + callbacks.size,
				0
			),
		restore() {
			globals.forEach((key, index) => {
				const descriptor = previous[index]
				if (descriptor) Object.defineProperty(globalThis, key, descriptor)
				else Reflect.deleteProperty(globalThis, key)
			})
		},
	}
}

async function until(check: () => boolean): Promise<void> {
	for (let turn = 0; turn < 30 && !check(); turn++)
		await new Promise((resolve) => setImmediate(resolve))
	assert.ok(
		check(),
		'The real public Auth integration did not reach its terminal state'
	)
}

for (const failure of [
	'callback',
	'me401',
	'admin',
	'degraded',
	'timeout',
] as const) {
	test(`real popup, runtime and coordinator retain ${failure} failure and allow a fresh verified retry`, async () => {
		const browser = browserFixture()
		let failing = true
		const paths: string[] = [],
			navigations: string[] = []
		let notifications = 0
		let expire: () => void = () => undefined
		const api = createCinaTokenApi(async (input) => {
			const path = String(input)
			paths.push(path)
			if (path === '/api/user/me') {
				if (failing && failure === 'me401')
					return Response.json({ success: false }, { status: 401 })
				return Response.json({ success: true, data: identity })
			}
			if (failing && failure === 'admin')
				return Response.json({
					...verifiedConsole,
					subject: 'different-subject',
				})
			if (failing && failure === 'degraded')
				return Response.json({ ...verifiedConsole, verification: 'degraded' })
			return Response.json(verifiedConsole)
		})
		const controller = new PublicAuthController({
			loadRuntime: async () => ({
				createPublicAuthRuntime: (done) => createPublicAuthRuntime(done, api),
			}),
			reserve: reserveAuthPopup,
			release: releaseAuthPopupReservation,
			logout: () => () => undefined,
			notify: () => {
				notifications++
			},
			navigate: (path) => {
				navigations.push(path)
			},
			now: () => Date.now(),
			schedule(callback, milliseconds) {
				expire = callback
				const timer = setTimeout(callback, milliseconds)
				timer.unref()
				return timer
			},
			clear: clearTimeout,
		})
		try {
			controller.begin({ intent: 'admin', callbackPath: '/dashboard' })
			await until(() => controller.getSnapshot().phase === 'waiting')
			if (failure === 'timeout') expire()
			else browser.complete(failure !== 'callback')
			await until(() => controller.getSnapshot().phase === 'error')
			const errors = {
				admin: 'admin_forbidden',
				degraded: 'session_unavailable',
				timeout: 'popup_expired',
				callback: 'oidc_failed',
				me401: 'oidc_failed',
			}
			assert.equal(controller.getSnapshot().error, errors[failure])
			assert.equal(notifications, 0)
			assert.deepEqual(navigations, [])
			assert.equal(browser.popups[0].closes, 1)
			assert.equal(browser.listenerCount(), 0)
			if (failure === 'callback' || failure === 'timeout')
				assert.deepEqual(paths, [])
			const firstId = new URL(
				browser.popups[0].path,
				'https://integration.invalid'
			).searchParams.get('request')
			failing = false
			controller.retry()
			await until(() => controller.getSnapshot().phase === 'waiting')
			assert.notEqual(
				new URL(
					browser.popups[1].path,
					'https://integration.invalid'
				).searchParams.get('request'),
				firstId
			)
			browser.complete(true)
			await until(() => navigations.length === 1)
			assert.equal(notifications, 1)
			assert.deepEqual(navigations, ['/dashboard'])
			assert.equal(controller.getSnapshot().phase, 'idle')
			assert.equal(browser.popups[1].closes, 1)
			assert.equal(browser.listenerCount(), 0)
		} finally {
			controller.dispose()
			browser.restore()
		}
	})
}
