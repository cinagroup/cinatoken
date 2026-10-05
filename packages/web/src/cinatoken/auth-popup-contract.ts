/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
export const AUTH_POPUP_MESSAGE = 'cinatoken:cinaauth-popup-complete'
export const AUTH_POPUP_STORAGE_PREFIX = 'cinatoken:cinaauth-popup:'
export const AUTH_POPUP_CHANNEL = 'cinatoken:cinaauth-popup:v1'
export const AUTH_POPUP_TIMEOUT_MS = 10 * 60 * 1000
const requestIdPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

export type LoginOptions = {
	intent?: 'portal' | 'admin'
	callbackPath?: string
	register?: boolean
}
export type PopupResult = {
	type: typeof AUTH_POPUP_MESSAGE
	requestId: string
	ok: boolean
	error?: string
}
export type AuthPopupReservation = Readonly<{
	requestId: string
	popup: Window
	options: LoginOptions
	startedAt: number
}>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function validOptions(value: unknown): value is LoginOptions {
	if (!isRecord(value)) return false
	if (
		(value.intent !== undefined &&
			value.intent !== 'portal' &&
			value.intent !== 'admin') ||
		(value.register !== undefined && typeof value.register !== 'boolean') ||
		(value.callbackPath !== undefined && typeof value.callbackPath !== 'string')
	)
		return false
	const path = value.callbackPath ?? '/account'
	return (
		path.startsWith('/') &&
		!path.startsWith('//') &&
		!path.includes('\\') &&
		!Array.from(path).some(
			(character) =>
				character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
		)
	)
}

export function parsePopupResult(
	value: unknown,
	expectedRequestId: string
): PopupResult | null {
	if (!isRecord(value)) return null
	if (
		value.type !== AUTH_POPUP_MESSAGE ||
		value.requestId !== expectedRequestId ||
		typeof value.requestId !== 'string' ||
		!requestIdPattern.test(value.requestId) ||
		typeof value.ok !== 'boolean'
	)
		return null
	if (
		value.error !== undefined &&
		(typeof value.error !== 'string' || !/^[a-z0-9_]{1,64}$/u.test(value.error))
	)
		return null
	if (value.ok && value.error !== undefined) return null
	return {
		type: AUTH_POPUP_MESSAGE,
		requestId: value.requestId,
		ok: value.ok,
		...(value.error === undefined ? {} : { error: value.error }),
	}
}

export function buildAuthStartPath(
	options: LoginOptions,
	requestId?: string
): string {
	if (!validOptions(options))
		throw new TypeError('Authentication options must contain a local callback')
	const params = new URLSearchParams({
		intent: options.intent ?? 'portal',
		callbackURL: options.callbackPath ?? '/account',
	})
	if (options.register) params.set('mode', 'register')
	if (requestId !== undefined) {
		if (!requestIdPattern.test(requestId))
			throw new TypeError('Invalid popup request id')
		params.set('presentation', 'popup')
		params.set('request', requestId)
	}
	return `/api/auth/cinaauth/login?${params.toString()}`
}

/** No browser reads happen until the caller's original click invokes this function. */
export function reserveAuthPopup(
	options: LoginOptions = {}
): AuthPopupReservation | null {
	const fallback = buildAuthStartPath(options)
	const copiedOptions = Object.freeze({
		...(options.intent === undefined ? {} : { intent: options.intent }),
		...(options.callbackPath === undefined
			? {}
			: { callbackPath: options.callbackPath }),
		...(options.register === undefined ? {} : { register: options.register }),
	})
	const requestId = crypto.randomUUID()
	const startedAt = Date.now()
	const left = Math.max(
		0,
		Math.round(window.screenX + (window.outerWidth - 520) / 2)
	)
	const top = Math.max(
		0,
		Math.round(window.screenY + (window.outerHeight - 760) / 2)
	)
	const popup = window.open(
		'about:blank',
		`cinatoken-cinaauth-${requestId}`,
		`popup=yes,width=520,height=760,left=${left},top=${top},resizable=yes,scrollbars=yes`
	)
	if (!popup) {
		window.location.assign(fallback)
		return null
	}
	return Object.freeze({ requestId, popup, options: copiedOptions, startedAt })
}

/** Validate metadata without consulting popup.closed, which COOP may report incorrectly. */
export function isAuthPopupReservationValid(
	value: unknown,
	now: number = Date.now()
): value is AuthPopupReservation {
	if (!isRecord(value)) return false
	return (
		typeof value.requestId === 'string' &&
		requestIdPattern.test(value.requestId) &&
		typeof value.startedAt === 'number' &&
		Number.isSafeInteger(value.startedAt) &&
		Number.isSafeInteger(now) &&
		value.startedAt <= now &&
		now - value.startedAt < AUTH_POPUP_TIMEOUT_MS &&
		value.startedAt >= 0 &&
		validOptions(value.options) &&
		isRecord(value.popup) &&
		typeof value.popup.close === 'function' &&
		typeof value.popup.focus === 'function' &&
		!released.get(value.popup)?.has(value.requestId)
	)
}

const released = new WeakMap<object, Set<string>>()
/** Releases only this window and correlation key; it does not revoke a server session. */
export function releaseAuthPopupReservation(
	reservation: AuthPopupReservation
): void {
	const popup = reservation.popup
	if (typeof popup === 'object' && popup !== null) {
		const ids = released.get(popup) ?? new Set<string>()
		if (ids.has(reservation.requestId)) return
		ids.add(reservation.requestId)
		released.set(popup, ids)
	}
	try {
		popup?.close()
	} catch {
		/* COOP can detach the handle. */
	}
	try {
		if (requestIdPattern.test(reservation.requestId))
			localStorage.removeItem(
				`${AUTH_POPUP_STORAGE_PREFIX}${reservation.requestId}`
			)
	} catch {
		/* Storage is an optional completion transport. */
	}
}
