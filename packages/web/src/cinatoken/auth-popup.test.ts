import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CinaTokenApiError } from './api'
import {
	AUTH_POPUP_MESSAGE,
	AUTH_POPUP_STORAGE_PREFIX,
	AUTH_POPUP_TIMEOUT_MS,
	CinaAuthPopupController,
	buildAuthStartPath,
	isAuthPopupReservationValid,
	parsePopupResult,
	reserveAuthPopup,
} from './auth-popup'
import { parseSessionMessage } from './session-events'
import { deferred } from './test-fixtures'

const requestId = 'b63376d9-cb4b-4a4d-836a-2d552396c4f6'

test('popup start path follows the existing CinaAuth callback contract', () => {
	const url = new URL(
		buildAuthStartPath(
			{ intent: 'portal', callbackPath: '/account/keys', register: true },
			requestId
		),
		'https://cinatoken.example'
	)
	assert.equal(url.pathname, '/api/auth/cinaauth/login')
	assert.equal(url.searchParams.get('callbackURL'), '/account/keys')
	assert.equal(url.searchParams.get('intent'), 'portal')
	assert.equal(url.searchParams.get('mode'), 'register')
	assert.equal(url.searchParams.get('presentation'), 'popup')
	assert.equal(url.searchParams.get('request'), requestId)
})

test('full page fallback omits popup transaction parameters', () => {
	const url = new URL(buildAuthStartPath({}), 'https://cinatoken.example')
	assert.equal(url.searchParams.get('callbackURL'), '/account')
	assert.equal(url.searchParams.has('request'), false)
	assert.equal(url.searchParams.has('presentation'), false)
})

test('authentication callbacks cannot redirect out of the application', () => {
	for (const callbackPath of [
		'https://attacker.example',
		'//attacker.example',
		'/\\attacker.example',
		'/\t/attacker.example',
	]) {
		assert.throws(() => buildAuthStartPath({ callbackPath }))
	}
})

test('popup result must match the pending request and exact server schema', () => {
	const result = { type: AUTH_POPUP_MESSAGE, requestId, ok: true }
	assert.deepEqual(parsePopupResult(result, requestId), result)
	assert.equal(
		parsePopupResult(result, '1da197de-9a71-4a52-a454-3ea8cfa5f185'),
		null
	)
	assert.equal(parsePopupResult({ ...result, ok: 'true' }, requestId), null)
	assert.equal(
		parsePopupResult({ ...result, error: 'unexpected' }, requestId),
		null
	)
	assert.equal(
		parsePopupResult({ ...result, ok: false, error: '<script>' }, requestId),
		null
	)
})

test('cross-tab session events contain no identity or credential proof', () => {
	assert.deepEqual(
		parseSessionMessage({
			type: 'cinatoken:session-changed',
			change: 'login',
			id: requestId,
			token: 'untrusted',
		}),
		{
			type: 'cinatoken:session-changed',
			change: 'login',
			id: requestId,
		}
	)
	assert.equal(
		parseSessionMessage({
			type: 'cinatoken:session-changed',
			change: 'admin',
			id: requestId,
		}),
		null
	)
})

function fakeBrowser(): {
	restore: () => void
	getRequestId: () => string
	getOpens: () => number
	getPaths: () => string[]
	getCloses: () => number
	getListeners: () => number
	getChannelCloses: () => number
	getRemovedKeys: () => string[]
	emitMessage: (data: unknown, origin: string, source: unknown) => void
	emitStorage: (key: string, newValue: string) => void
	emitChannel: (data: unknown) => void
} {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
	const previousStorage = Object.getOwnPropertyDescriptor(
		globalThis,
		'localStorage'
	)
	const previousChannel = Object.getOwnPropertyDescriptor(
		globalThis,
		'BroadcastChannel'
	)
	let opens = 0
	let popupPath = ''
	const paths: string[] = []
	let closes = 0
	let channelCloses = 0
	const removed: string[] = []
	const listeners = new Map<string, Set<(event: unknown) => void>>()
	const channels: FakeChannel[] = []
	class FakeChannel {
		onmessage: ((event: MessageEvent<unknown>) => void) | null = null
		constructor() {
			channels.push(this)
		}
		close() {
			channelCloses++
		}
	}
	const createPopup = () => ({
		location: {
			replace: (path: string) => {
				popupPath = path
				paths.push(path)
			},
		},
		focus: () => undefined,
		close: () => {
			closes++
		},
		get closed() {
			throw new Error(
				'COOP detached handles must not be used as completion evidence'
			)
		},
	})
	function emit(name: string, event: unknown) {
		listeners.get(name)?.forEach((listener) => listener(event))
	}
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			screenX: 0,
			screenY: 0,
			outerWidth: 1200,
			outerHeight: 900,
			open: () => {
				opens += 1
				return createPopup()
			},
			location: {
				origin: 'https://cinatoken.example',
				assign: () => undefined,
			},
			addEventListener(name: string, listener: (event: unknown) => void) {
				const values = listeners.get(name) ?? new Set()
				values.add(listener)
				listeners.set(name, values)
			},
			removeEventListener(name: string, listener: (event: unknown) => void) {
				listeners.get(name)?.delete(listener)
			},
		},
	})
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			removeItem: (key: string) => {
				removed.push(key)
			},
			getItem: () => null,
		},
	})
	Object.defineProperty(globalThis, 'BroadcastChannel', {
		configurable: true,
		value: FakeChannel,
	})
	return {
		getRequestId: () =>
			new URL(popupPath, 'https://cinatoken.example').searchParams.get(
				'request'
			) ?? '',
		getOpens: () => opens,
		getPaths: () => paths,
		getCloses: () => closes,
		getListeners: () =>
			[...listeners.values()].reduce((sum, values) => sum + values.size, 0),
		getChannelCloses: () => channelCloses,
		getRemovedKeys: () => removed,
		emitMessage: (data, origin, source) =>
			emit('message', { data, origin, source }),
		emitStorage: (key, newValue) => emit('storage', { key, newValue }),
		emitChannel: (data) =>
			channels.forEach((channel) =>
				channel.onmessage?.(new MessageEvent('message', { data }))
			),
		restore: () => {
			if (previousWindow)
				Object.defineProperty(globalThis, 'window', previousWindow)
			else Reflect.deleteProperty(globalThis, 'window')
			if (previousStorage)
				Object.defineProperty(globalThis, 'localStorage', previousStorage)
			else Reflect.deleteProperty(globalThis, 'localStorage')
			if (previousChannel)
				Object.defineProperty(globalThis, 'BroadcastChannel', previousChannel)
			else Reflect.deleteProperty(globalThis, 'BroadcastChannel')
		},
	}
}

test('one active popup accepts a matching completion only after server revalidation', async () => {
	const browser = fakeBrowser()
	const verification = deferred<void>()
	let checks = 0
	const popup = new CinaAuthPopupController(async () => {
		checks += 1
		await verification.promise
	})
	try {
		popup.login()
		popup.login({ register: true })
		assert.equal(browser.getOpens(), 1)
		const result = {
			type: AUTH_POPUP_MESSAGE,
			requestId: browser.getRequestId(),
			ok: true,
		}
		const completion = popup.receive(result)
		await popup.receive(result)
		assert.equal(checks, 1)
		assert.equal(popup.getSnapshot().isLoginPending, true)
		verification.resolve()
		await completion
		assert.equal(popup.getSnapshot().isLoginPending, false)
		assert.equal(popup.getSnapshot().loginError, null)
	} finally {
		popup.cancelLogin()
		browser.restore()
	}
})

test('adoption preserves the pre-opened window and original destination without a second open', async () => {
	const browser = fakeBrowser()
	let checks = 0
	const controller = new CinaAuthPopupController(async (options) => {
		checks++
		assert.equal(options.intent, 'admin')
		assert.equal(options.callbackPath, '/dashboard?tab=recent#active')
	})
	try {
		const options = {
			intent: 'admin' as const,
			callbackPath: '/dashboard?tab=recent#active',
		}
		const reservation = reserveAuthPopup(options)
		assert.ok(reservation)
		options.callbackPath = '/changed-after-click'
		assert.equal(browser.getPaths().length, 0)
		assert.equal(checks, 0)
		controller.adoptReservedAttempt(reservation)
		assert.equal(browser.getOpens(), 1)
		assert.equal(browser.getRequestId(), reservation.requestId)
		assert.equal(
			browser.getPaths()[0],
			buildAuthStartPath(reservation.options, reservation.requestId)
		)
		await controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: reservation.requestId,
			ok: true,
		})
		assert.equal(checks, 1)
		assert.equal(controller.getSnapshot().isLoginPending, false)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('message requires both exact application origin and the pending popup source', async () => {
	const browser = fakeBrowser()
	let checks = 0
	const controller = new CinaAuthPopupController(async () => {
		checks++
	})
	const detach = controller.attach()
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		controller.adoptReservedAttempt(reservation)
		const result = {
			type: AUTH_POPUP_MESSAGE,
			requestId: reservation.requestId,
			ok: true,
		}
		browser.emitMessage(result, 'https://evil.invalid', reservation.popup)
		browser.emitMessage(result, 'https://cinatoken.example', null)
		browser.emitMessage(result, 'https://cinatoken.example', {})
		browser.emitMessage(
			{ ...result, requestId: crypto.randomUUID() },
			'https://cinatoken.example',
			reservation.popup
		)
		assert.equal(checks, 0)
		assert.equal(controller.getSnapshot().isLoginPending, true)
		browser.emitMessage(result, 'https://cinatoken.example', reservation.popup)
		await Promise.resolve()
		assert.equal(checks, 1)
		assert.equal(controller.getSnapshot().isLoginPending, false)
	} finally {
		detach()
		browser.restore()
	}
})

test('COOP storage and channel signals coalesce into one server verification and detach cleans listeners', async () => {
	const browser = fakeBrowser()
	const verification = deferred<void>()
	let checks = 0
	const controller = new CinaAuthPopupController(async () => {
		checks++
		await verification.promise
	})
	const detach = controller.attach()
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		controller.adoptReservedAttempt(reservation)
		const result = {
			type: AUTH_POPUP_MESSAGE,
			requestId: reservation.requestId,
			ok: true,
		}
		browser.emitStorage(
			`${AUTH_POPUP_STORAGE_PREFIX}old`,
			JSON.stringify(result)
		)
		browser.emitStorage(
			`${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`,
			'broken-json'
		)
		assert.equal(checks, 0)
		browser.emitStorage(
			`${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`,
			JSON.stringify(result)
		)
		browser.emitChannel(result)
		assert.equal(checks, 1)
		verification.resolve()
		await Promise.resolve()
		await Promise.resolve()
		assert.equal(controller.getSnapshot().isLoginPending, false)
		assert.ok(
			browser
				.getRemovedKeys()
				.includes(`${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`)
		)
		detach()
		assert.equal(browser.getListeners(), 0)
		assert.equal(browser.getChannelCloses(), 1)
		browser.emitMessage(result, 'https://cinatoken.example', reservation.popup)
		browser.emitStorage(
			`${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`,
			JSON.stringify(result)
		)
		assert.equal(checks, 1)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('adoption rejects a reservation that expired while the lazy module loaded', (context) => {
	context.mock.timers.enable({ apis: ['Date'], now: 1000 })
	const browser = fakeBrowser()
	const controller = new CinaAuthPopupController(async () => {
		assert.fail('Expired attempt must not verify')
	})
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		context.mock.timers.setTime(1000 + AUTH_POPUP_TIMEOUT_MS)
		controller.adoptReservedAttempt(reservation)
		assert.deepEqual(controller.getSnapshot(), {
			isLoginPending: false,
			loginError: 'popup_expired',
		})
		assert.equal(browser.getPaths().length, 0)
		assert.equal(browser.getCloses(), 1)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('a completion at the absolute deadline cannot verify before the next timer poll', async (context) => {
	context.mock.timers.enable({ apis: ['Date'], now: 1000 })
	const browser = fakeBrowser()
	let checks = 0
	const controller = new CinaAuthPopupController(async () => {
		checks++
	})
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		controller.adoptReservedAttempt(reservation)
		context.mock.timers.setTime(1000 + AUTH_POPUP_TIMEOUT_MS)
		await controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: reservation.requestId,
			ok: true,
		})
		assert.equal(checks, 0)
		assert.equal(controller.getSnapshot().loginError, 'popup_expired')
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('timeout aborts pending verification and late success cannot clear the timeout error', async (context) => {
	context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
	const browser = fakeBrowser()
	const verification = deferred<void>()
	let signal: AbortSignal | undefined
	const controller = new CinaAuthPopupController(
		async (_options, requestSignal) => {
			signal = requestSignal
			await verification.promise
		}
	)
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		controller.adoptReservedAttempt(reservation)
		const completion = controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: reservation.requestId,
			ok: true,
		})
		context.mock.timers.tick(AUTH_POPUP_TIMEOUT_MS)
		assert.equal(signal?.aborted, true)
		assert.equal(controller.getSnapshot().loginError, 'popup_expired')
		verification.resolve()
		await completion
		assert.equal(controller.getSnapshot().loginError, 'popup_expired')
		assert.equal(controller.getSnapshot().isLoginPending, false)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('invalid reservation metadata is released before any auth navigation', () => {
	const browser = fakeBrowser()
	const controller = new CinaAuthPopupController(async () => {})
	try {
		for (const patch of [
			{ requestId: 'invalid' },
			{ startedAt: Date.now() + 60_000 },
			{ options: { callbackPath: '//evil.invalid' } },
		]) {
			const reservation = reserveAuthPopup()
			assert.ok(reservation)
			assert.throws(
				() => controller.adoptReservedAttempt({ ...reservation, ...patch }),
				TypeError
			)
		}
		assert.equal(browser.getCloses(), 3)
		assert.equal(browser.getPaths().length, 0)
		assert.equal(controller.getSnapshot().isLoginPending, false)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('repeat adoption preserves the active transaction and releases a second reserved window', () => {
	const browser = fakeBrowser()
	const controller = new CinaAuthPopupController(async () => {})
	try {
		const first = reserveAuthPopup()
		const second = reserveAuthPopup({ register: true })
		assert.ok(first && second)
		controller.adoptReservedAttempt(first)
		controller.adoptReservedAttempt(first)
		assert.equal(browser.getCloses(), 0)
		controller.adoptReservedAttempt(second)
		assert.equal(browser.getCloses(), 1)
		assert.equal(browser.getPaths().length, 1)
		assert.equal(browser.getRequestId(), first.requestId)
		assert.equal(isAuthPopupReservationValid(second), false)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('cancelled reservation cannot be adopted again and old completion cannot affect the next attempt', async () => {
	const browser = fakeBrowser()
	let checks = 0
	const controller = new CinaAuthPopupController(async () => {
		checks++
	})
	try {
		const old = reserveAuthPopup()
		assert.ok(old)
		controller.adoptReservedAttempt(old)
		controller.cancelLogin()
		assert.throws(() => controller.adoptReservedAttempt(old), TypeError)
		const current = reserveAuthPopup()
		assert.ok(current)
		controller.adoptReservedAttempt(current)
		await controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: old.requestId,
			ok: true,
		})
		assert.equal(checks, 0)
		assert.equal(controller.getSnapshot().isLoginPending, true)
		await controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: current.requestId,
			ok: true,
		})
		assert.equal(checks, 1)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('cancellation from a pending-state subscriber prevents subsequent auth navigation', (context) => {
	context.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 })
	const browser = fakeBrowser()
	const controller = new CinaAuthPopupController(async () => {})
	const unsubscribe = controller.subscribe(() => {
		if (controller.getSnapshot().isLoginPending) controller.cancelLogin()
	})
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		controller.adoptReservedAttempt(reservation)
		assert.equal(browser.getPaths().length, 0)
		assert.equal(browser.getCloses(), 1)
		context.mock.timers.tick(AUTH_POPUP_TIMEOUT_MS)
		assert.deepEqual(controller.getSnapshot(), {
			isLoginPending: false,
			loginError: null,
		})
	} finally {
		unsubscribe()
		controller.cancelLogin()
		browser.restore()
	}
})

test('late verification from a cancelled transaction cannot cancel a new pending transaction', async () => {
	const browser = fakeBrowser()
	const verification = deferred<void>()
	let checks = 0
	const controller = new CinaAuthPopupController(async () => {
		checks++
		await verification.promise
	})
	try {
		const old = reserveAuthPopup()
		assert.ok(old)
		controller.adoptReservedAttempt(old)
		const oldCompletion = controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: old.requestId,
			ok: true,
		})
		controller.cancelLogin()
		const current = reserveAuthPopup()
		assert.ok(current)
		controller.adoptReservedAttempt(current)
		verification.resolve()
		await oldCompletion
		assert.equal(checks, 1)
		assert.equal(controller.getSnapshot().isLoginPending, true)
		assert.ok(isAuthPopupReservationValid(current))
		await controller.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: current.requestId,
			ok: true,
		})
		assert.equal(checks, 2)
		assert.equal(controller.getSnapshot().isLoginPending, false)
	} finally {
		controller.cancelLogin()
		browser.restore()
	}
})

test('a successful popup message cannot override rejected server identity', async () => {
	const browser = fakeBrowser()
	const popup = new CinaAuthPopupController(async () => {
		throw new CinaTokenApiError('Unauthorized', 401, 'http')
	})
	try {
		popup.login()
		await popup.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: browser.getRequestId(),
			ok: true,
		})
		assert.equal(popup.getSnapshot().isLoginPending, false)
		assert.equal(popup.getSnapshot().loginError, 'oidc_failed')
	} finally {
		popup.cancelLogin()
		browser.restore()
	}
})

for (const failure of ['callback', 'identity', 'admin'] as const) {
	test(`${failure} failure publishes one complete error before subscribers dispose`, async () => {
		const browser = fakeBrowser()
		const popup = new CinaAuthPopupController(async () => {
			if (failure === 'identity')
				throw new CinaTokenApiError('Unauthorized', 401, 'http')
			if (failure === 'admin') throw new Error('admin_forbidden')
		})
		const terminal: Array<ReturnType<typeof popup.getSnapshot>> = []
		const unsubscribe = popup.subscribe(() => {
			const snapshot = popup.getSnapshot()
			if (!snapshot.isLoginPending) {
				terminal.push(snapshot)
				unsubscribe()
			}
		})
		try {
			const reservation = reserveAuthPopup()
			assert.ok(reservation)
			popup.adoptReservedAttempt(reservation)
			await popup.receive({
				type: AUTH_POPUP_MESSAGE,
				requestId: reservation.requestId,
				ok: failure !== 'callback',
				...(failure === 'callback' ? { error: 'oidc_failed' } : {}),
			})
			assert.deepEqual(terminal, [
				{
					isLoginPending: false,
					loginError: failure === 'admin' ? 'admin_forbidden' : 'oidc_failed',
				},
			])
			assert.equal(browser.getCloses(), 1)
			assert.equal(isAuthPopupReservationValid(reservation), false)
		} finally {
			unsubscribe()
			popup.cancelLogin()
			browser.restore()
		}
	})
}

test('cancelling an attempt aborts verification and ignores its late completion', async () => {
	const browser = fakeBrowser()
	const verification = deferred<void>()
	let verifySignal: AbortSignal | undefined
	const popup = new CinaAuthPopupController(async (_options, signal) => {
		verifySignal = signal
		await verification.promise
	})
	try {
		popup.login()
		const completion = popup.receive({
			type: AUTH_POPUP_MESSAGE,
			requestId: browser.getRequestId(),
			ok: true,
		})
		popup.cancelLogin()
		assert.equal(verifySignal?.aborted, true)
		verification.resolve()
		await completion
		assert.equal(popup.getSnapshot().isLoginPending, false)
		assert.equal(popup.getSnapshot().loginError, null)
	} finally {
		popup.cancelLogin()
		browser.restore()
	}
})
