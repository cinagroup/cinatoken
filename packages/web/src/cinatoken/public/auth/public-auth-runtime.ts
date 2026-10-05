/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { cinatokenApi } from '../../api'
import { CinaAuthPopupController } from '../../auth-popup'
import {
	releaseAuthPopupReservation,
	type AuthPopupReservation,
	type LoginOptions,
} from '../../auth-popup-contract'
import type { PublicAuthRuntime, PublicAuthSnapshot } from './public-auth-types'

export type PublicAuthApi = Pick<typeof cinatokenApi, 'me' | 'authCheck'>

/** Completion messages initiate cookie revalidation; they never supply identity. */
export async function verifyPublicLogin(
	api: PublicAuthApi,
	options: LoginOptions,
	signal: AbortSignal
): Promise<void> {
	signal.throwIfAborted()
	const identity = await api.me({ signal })
	signal.throwIfAborted()
	if (options.intent === 'admin') {
		const check = await api.authCheck({ signal })
		signal.throwIfAborted()
		if (!check.authenticated) throw new Error('admin_forbidden')
		if (check.verification !== 'verified')
			throw new Error('session_unavailable')
		if (check.principalType !== 'console' || check.subject !== identity.subject)
			throw new Error('admin_forbidden')
	}
}

export function createPublicAuthRuntime(
	verified: (options: LoginOptions) => void,
	api: PublicAuthApi = cinatokenApi
): PublicAuthRuntime {
	let snapshot: PublicAuthSnapshot = { phase: 'waiting', error: null }
	const listeners = new Set<() => void>()
	const update = (value: PublicAuthSnapshot): void => {
		snapshot = value
		listeners.forEach((listener) => listener())
	}
	const popup = new CinaAuthPopupController(async (options, signal) => {
		update({ phase: 'verifying', error: null })
		await verifyPublicLogin(api, options, signal)
		if (!signal.aborted) verified(options)
	})
	const unsubscribe = popup.subscribe(() => {
		const current = popup.getSnapshot()
		if (current.loginError)
			update({ phase: 'error', error: current.loginError })
		else if (!current.isLoginPending) update({ phase: 'idle', error: null })
		else if (snapshot.phase !== 'verifying')
			update({ phase: 'waiting', error: null })
	})
	let detach: (() => void) | undefined
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener) => {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		begin(reservation: AuthPopupReservation) {
			try {
				detach = popup.attach()
				popup.adoptReservedAttempt(reservation)
			} catch (error) {
				releaseAuthPopupReservation(reservation)
				throw error
			}
		},
		refocus: popup.refocus,
		dispose() {
			unsubscribe()
			detach?.()
			if (!detach) popup.cancelLogin()
			listeners.clear()
		},
	}
}
