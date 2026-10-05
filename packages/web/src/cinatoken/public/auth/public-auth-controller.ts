/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	AUTH_POPUP_TIMEOUT_MS,
	reserveAuthPopup,
	releaseAuthPopupReservation,
	type AuthPopupReservation,
	type LoginOptions,
} from '../../auth-popup-contract'
import {
	notifySessionChanged,
	subscribeSessionChanges,
} from '../../session-events'
import type {
	PublicAuthRuntime,
	PublicAuthRuntimeModule,
	PublicAuthSnapshot,
} from './public-auth-types'

type ActiveLogin = {
	reservation: AuthPopupReservation
	opener?: HTMLElement
	runtime?: PublicAuthRuntime
	detach?: () => void
	stopLogout?: () => void
	timer?: ReturnType<typeof setTimeout>
}
export type PublicAuthDependencies = {
	loadRuntime: () => Promise<PublicAuthRuntimeModule>
	reserve: (options: LoginOptions) => AuthPopupReservation | null
	release: (reservation: AuthPopupReservation) => void
	logout: (cancel: () => void) => () => void
	notify: () => void
	navigate: (path: string) => void
	now: () => number
	schedule: (
		expire: () => void,
		milliseconds: number
	) => ReturnType<typeof setTimeout>
	clear: (timer: ReturnType<typeof setTimeout>) => void
}

const idleSnapshot: PublicAuthSnapshot = { phase: 'idle', error: null }

/** Construction and subscriptions perform no browser or session I/O. */
export class PublicAuthController {
	private snapshot = idleSnapshot
	private listeners = new Set<() => void>()
	private active: ActiveLogin | null = null
	private retryTarget: { options: LoginOptions; opener?: HTMLElement } | null =
		null
	constructor(private readonly dependencies: PublicAuthDependencies) {}
	getSnapshot = (): PublicAuthSnapshot => this.snapshot
	getServerSnapshot = (): PublicAuthSnapshot => idleSnapshot
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(snapshot: PublicAuthSnapshot): void {
		this.snapshot = snapshot
		this.listeners.forEach((listener) => listener())
	}
	private isCurrent(attempt: ActiveLogin): boolean {
		return (
			this.active === attempt &&
			this.dependencies.now() - attempt.reservation.startedAt <
				AUTH_POPUP_TIMEOUT_MS
		)
	}
	private finish(
		attempt: ActiveLogin,
		error: string | null,
		restoreFocus: boolean
	): void {
		if (this.active !== attempt) return
		this.active = null
		if (attempt.timer !== undefined) this.dependencies.clear(attempt.timer)
		attempt.stopLogout?.()
		attempt.detach?.()
		if (attempt.runtime) attempt.runtime.dispose()
		else this.dependencies.release(attempt.reservation)
		this.update(error ? { phase: 'error', error } : idleSnapshot)
		if (restoreFocus && attempt.opener?.isConnected) attempt.opener.focus()
	}
	private verified(attempt: ActiveLogin, options: LoginOptions): void {
		if (!this.isCurrent(attempt)) {
			this.finish(attempt, 'popup_expired', true)
			return
		}
		this.finish(attempt, null, false)
		this.dependencies.notify()
		this.dependencies.navigate(options.callbackPath ?? '/account')
	}
	begin = (options: LoginOptions, opener?: HTMLElement): void => {
		if (this.active) {
			this.refocus()
			return
		}
		// Reserve in the click stack, before even invoking the asynchronous loader.
		const reservation = this.dependencies.reserve(options)
		if (!reservation) return
		const attempt: ActiveLogin = { reservation, opener }
		this.active = attempt
		this.retryTarget = { options: reservation.options, opener }
		attempt.timer = this.dependencies.schedule(
			() => this.finish(attempt, 'popup_expired', true),
			Math.max(
				0,
				AUTH_POPUP_TIMEOUT_MS -
					(this.dependencies.now() - reservation.startedAt)
			)
		)
		attempt.stopLogout = this.dependencies.logout(() => {
			this.finish(attempt, null, true)
			this.retryTarget = null
		})
		// Install cleanup before observers can synchronously cancel this attempt.
		this.update({ phase: 'loading', error: null })
		if (this.active === attempt) void this.load(attempt)
	}
	private async load(attempt: ActiveLogin): Promise<void> {
		try {
			const module = await this.dependencies.loadRuntime()
			if (!this.isCurrent(attempt)) {
				this.finish(attempt, 'popup_expired', true)
				return
			}
			const runtime = module.createPublicAuthRuntime((options) =>
				this.verified(attempt, options)
			)
			attempt.runtime = runtime
			attempt.detach = runtime.subscribe(() => {
				if (this.active !== attempt) return
				const snapshot = runtime.getSnapshot()
				if (snapshot.phase === 'error')
					this.finish(attempt, snapshot.error ?? 'session_unavailable', true)
				else if (snapshot.phase === 'idle') this.finish(attempt, null, true)
				else this.update(snapshot)
			})
			runtime.begin(attempt.reservation)
			if (this.active === attempt) this.update(runtime.getSnapshot())
		} catch {
			this.finish(attempt, 'runtime_unavailable', true)
		}
	}
	cancel = (): void => {
		const opener = this.retryTarget?.opener
		this.retryTarget = null
		if (this.active) this.finish(this.active, null, true)
		else {
			this.update(idleSnapshot)
			if (opener?.isConnected) opener.focus()
		}
	}
	refocus = (): void => {
		if (this.active?.runtime) this.active.runtime.refocus()
		else {
			try {
				this.active?.reservation.popup.focus()
			} catch {
				/* COOP may detach the handle. */
			}
		}
	}
	retry = (): void => {
		if (this.retryTarget)
			this.begin(this.retryTarget.options, this.retryTarget.opener)
	}
	dispose = (): void => {
		this.cancel()
	}
}

export function createPublicAuthController(): PublicAuthController {
	return new PublicAuthController({
		loadRuntime: () => import('./public-auth-runtime'),
		reserve: reserveAuthPopup,
		release: releaseAuthPopupReservation,
		logout: (cancel) =>
			subscribeSessionChanges((change) => {
				if (change === 'logout') cancel()
			}),
		notify: () => notifySessionChanged('login'),
		navigate: (path) => window.location.assign(path),
		now: () => Date.now(),
		schedule: (expire, milliseconds) => setTimeout(expire, milliseconds),
		clear: (timer) => clearTimeout(timer),
	})
}
