/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	AUTH_POPUP_MESSAGE,
	AUTH_POPUP_STORAGE_PREFIX,
	AUTH_POPUP_TIMEOUT_MS,
	buildAuthStartPath,
	isAuthPopupReservationValid,
	parsePopupResult,
	releaseAuthPopupReservation,
	reserveAuthPopup,
} from './auth-popup-contract'

function browserFixture(blocked = false) {
	const globals = ['window', 'localStorage'] as const
	const descriptors = globals.map((name) =>
		Object.getOwnPropertyDescriptor(globalThis, name)
	)
	const events: string[] = []
	let closed = 0
	const popup = {
		close() {
			closed++
		},
		focus() {},
		get closed() {
			throw new Error('COOP closed is not a completion signal')
		},
	}
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		value: {
			screenX: 0,
			screenY: 0,
			outerWidth: 1200,
			outerHeight: 900,
			open(url: string, name: string, features: string) {
				events.push(`open:${url}:${name}:${features}`)
				return blocked ? null : popup
			},
			location: {
				assign(path: string) {
					events.push(`assign:${path}`)
				},
			},
		},
	})
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: {
			removeItem(key: string) {
				events.push(`remove:${key}`)
			},
		},
	})
	return {
		events,
		closed: () => closed,
		restore() {
			globals.forEach((name, index) => {
				const descriptor = descriptors[index]
				if (descriptor) Object.defineProperty(globalThis, name, descriptor)
				else Reflect.deleteProperty(globalThis, name)
			})
		},
	}
}

test('the pure popup contract imports without reading browser or network globals', async () => {
	const globals = ['window', 'localStorage', 'fetch'] as const
	const descriptors = globals.map((name) =>
		Object.getOwnPropertyDescriptor(globalThis, name)
	)
	try {
		for (const name of globals)
			Object.defineProperty(globalThis, name, {
				configurable: true,
				get() {
					throw new Error(`Initial contract import read ${name}`)
				},
			})
		const module = await import(
			new URL('./auth-popup-contract.ts?server-import-proof', import.meta.url)
				.href
		)
		assert.equal(module.AUTH_POPUP_TIMEOUT_MS, 600_000)
	} finally {
		globals.forEach((name, index) => {
			const descriptor = descriptors[index]
			if (descriptor) Object.defineProperty(globalThis, name, descriptor)
			else Reflect.deleteProperty(globalThis, name)
		})
	}
})

test('reservation opens synchronously and freezes a copy before lazy runtime can load', () => {
	const browser = browserFixture()
	try {
		const options = {
			callbackPath: '/account/keys?q=a%20b#keys',
			register: true,
			untrustedToken: 'must-not-copy',
		}
		const reservation = reserveAuthPopup(options)
		assert.ok(reservation)
		assert.equal(browser.events.length, 1)
		assert.match(browser.events[0], /^open:about:blank:cinatoken-cinaauth-/)
		assert.ok(Object.isFrozen(reservation))
		assert.ok(Object.isFrozen(reservation.options))
		assert.equal('untrustedToken' in reservation.options, false)
		options.callbackPath = '/changed'
		assert.equal(reservation.options.callbackPath, '/account/keys?q=a%20b#keys')
		assert.ok(isAuthPopupReservationValid(reservation))
		releaseAuthPopupReservation(reservation)
	} finally {
		browser.restore()
	}
})

test('invalid callback is rejected before opening or navigating a window', () => {
	const browser = browserFixture()
	try {
		for (const callbackPath of ['//evil.invalid', '/\\evil.invalid', '/\n'])
			assert.throws(() => reserveAuthPopup({ callbackPath }), TypeError)
		assert.deepEqual(browser.events, [])
	} finally {
		browser.restore()
	}
})

test('blocked reservation immediately uses ordinary full-page auth with registration and destination', () => {
	const browser = browserFixture(true)
	try {
		const options = { callbackPath: '/account?tab=keys#active', register: true }
		assert.equal(reserveAuthPopup(options), null)
		assert.equal(browser.events.length, 2)
		assert.equal(browser.events[1], `assign:${buildAuthStartPath(options)}`)
		const url = new URL(browser.events[1].slice(7), 'https://fixture.invalid')
		assert.equal(url.searchParams.get('callbackURL'), options.callbackPath)
		assert.equal(url.searchParams.get('mode'), 'register')
		assert.equal(url.searchParams.has('presentation'), false)
		assert.equal(url.searchParams.has('request'), false)
	} finally {
		browser.restore()
	}
})

test('reservation validation enforces exact deadline, timestamps, UUID and target metadata', () => {
	const browser = browserFixture()
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		const start = reservation.startedAt
		assert.equal(isAuthPopupReservationValid(reservation, start - 1), false)
		assert.equal(
			isAuthPopupReservationValid(
				reservation,
				start + AUTH_POPUP_TIMEOUT_MS - 1
			),
			true
		)
		assert.equal(
			isAuthPopupReservationValid(reservation, start + AUTH_POPUP_TIMEOUT_MS),
			false
		)
		for (const patch of [
			{ startedAt: Number.NaN },
			{ startedAt: start + 0.5 },
			{ startedAt: -1 },
			{ requestId: 'wrong-id' },
			{ options: { intent: 'unexpected' } },
			{ options: { register: 'true' } },
			{ options: { callbackPath: '//evil.invalid' } },
			{ popup: {} },
			{ popup: null },
		])
			assert.equal(
				isAuthPopupReservationValid({ ...reservation, ...patch }),
				false
			)
		releaseAuthPopupReservation(reservation)
		assert.equal(isAuthPopupReservationValid(reservation), false)
	} finally {
		browser.restore()
	}
})

test('release is idempotent and removes only its correlation key without reading closed', () => {
	const browser = browserFixture()
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		releaseAuthPopupReservation(reservation)
		releaseAuthPopupReservation({ ...reservation })
		assert.equal(browser.closed(), 1)
		assert.deepEqual(browser.events.slice(1), [
			`remove:${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`,
		])
	} finally {
		browser.restore()
	}
})

test('release tolerates detached handles and unavailable storage', () => {
	const browser = browserFixture()
	try {
		const reservation = reserveAuthPopup()
		assert.ok(reservation)
		Object.defineProperty(reservation.popup, 'close', {
			value() {
				throw new Error('Detached handle')
			},
		})
		Object.defineProperty(globalThis, 'localStorage', {
			configurable: true,
			get() {
				throw new Error('Storage unavailable')
			},
		})
		assert.doesNotThrow(() => releaseAuthPopupReservation(reservation))
	} finally {
		browser.restore()
	}
})

test('popup results project only safe correlation fields and reject old or malformed completion', () => {
	const requestId = 'b63376d9-cb4b-4a4d-836a-2d552396c4f6'
	const result = { type: AUTH_POPUP_MESSAGE, requestId, ok: true }
	assert.deepEqual(
		parsePopupResult({ ...result, identity: 'forged' }, requestId),
		result
	)
	for (const value of [
		null,
		[],
		{ ...result, requestId: 'old' },
		{ ...result, ok: 1 },
		{ ...result, error: 'invalid' },
	])
		assert.equal(parsePopupResult(value, requestId), null)
})
