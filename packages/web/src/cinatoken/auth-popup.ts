import { CinaTokenApiError } from './api'
import {
	AUTH_POPUP_CHANNEL,
	AUTH_POPUP_STORAGE_PREFIX,
	AUTH_POPUP_TIMEOUT_MS,
	buildAuthStartPath,
	isAuthPopupReservationValid,
	parsePopupResult,
	releaseAuthPopupReservation,
	reserveAuthPopup,
	type AuthPopupReservation,
	type LoginOptions,
} from './auth-popup-contract'

export {
	AUTH_POPUP_MESSAGE,
	AUTH_POPUP_CHANNEL,
	AUTH_POPUP_STORAGE_PREFIX,
	AUTH_POPUP_TIMEOUT_MS,
	buildAuthStartPath,
	isAuthPopupReservationValid,
	parsePopupResult,
	releaseAuthPopupReservation,
	reserveAuthPopup,
	type AuthPopupReservation,
	type LoginOptions,
	type PopupResult,
} from './auth-popup-contract'

type PopupSnapshot = { isLoginPending: boolean; loginError: string | null }
type Attempt = {
	reservation: AuthPopupReservation
	verifying: boolean
	abort: AbortController
}

/** Uses the existing callback's message/storage/BroadcastChannel contract. Signals only trigger server checks. */
export class CinaAuthPopupController {
	private snapshot: PopupSnapshot = { isLoginPending: false, loginError: null }
	private listeners = new Set<() => void>()
	private attempt: Attempt | null = null
	private timer: ReturnType<typeof setInterval> | null = null

	constructor(
		private readonly verify: (
			options: LoginOptions,
			signal: AbortSignal
		) => Promise<void>
	) {}
	getSnapshot = (): PopupSnapshot => this.snapshot
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	private update(patch: Partial<PopupSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		this.listeners.forEach((listener) => listener())
	}

	private cleanupAttempt(): void {
		const attempt = this.attempt
		this.attempt = null
		if (this.timer !== null) clearInterval(this.timer)
		this.timer = null
		attempt?.abort.abort()
		if (attempt) releaseAuthPopupReservation(attempt.reservation)
	}

	cancelLogin = (): void => {
		this.cleanupAttempt()
		this.update({ isLoginPending: false, loginError: null })
	}

	refocus = (): void => {
		try {
			this.attempt?.reservation.popup.focus()
		} catch {
			/* Detached handle. */
		}
	}

	private fail(attempt: Attempt, code: string): void {
		if (this.attempt !== attempt) return
		this.cleanupAttempt()
		this.update({ isLoginPending: false, loginError: code })
	}

	receive = async (value: unknown): Promise<void> => {
		const attempt = this.attempt
		if (!attempt || attempt.verifying) return
		const result = parsePopupResult(value, attempt.reservation.requestId)
		if (!result) return
		if (Date.now() - attempt.reservation.startedAt >= AUTH_POPUP_TIMEOUT_MS) {
			this.fail(attempt, 'popup_expired')
			return
		}
		if (!result.ok) {
			this.fail(attempt, result.error ?? 'oidc_failed')
			return
		}
		attempt.verifying = true
		try {
			await this.verify(attempt.reservation.options, attempt.abort.signal)
			if (this.attempt !== attempt || attempt.abort.signal.aborted) return
			if (Date.now() - attempt.reservation.startedAt >= AUTH_POPUP_TIMEOUT_MS)
				this.fail(attempt, 'popup_expired')
			else this.cancelLogin()
		} catch (error) {
			let code = 'session_unavailable'
			if (
				error instanceof CinaTokenApiError &&
				(error.status === 401 || error.status === 403)
			)
				code = 'oidc_failed'
			if (error instanceof Error && error.message === 'admin_forbidden')
				code = 'admin_forbidden'
			this.fail(attempt, code)
		}
	}

	login = (options: LoginOptions = {}): void => {
		if (this.attempt) {
			this.refocus()
			return
		}
		this.update({ loginError: null })
		const reservation = reserveAuthPopup(options)
		if (reservation) this.adoptReservedAttempt(reservation)
	}

	/** Takes over the original click's window after the public Auth chunk has loaded. */
	adoptReservedAttempt = (reservation: AuthPopupReservation): void => {
		const now = Date.now()
		const startedAt = reservation.startedAt
		if (!isAuthPopupReservationValid(reservation, now)) {
			const expired =
				isAuthPopupReservationValid(reservation, startedAt) &&
				now - startedAt >= AUTH_POPUP_TIMEOUT_MS
			releaseAuthPopupReservation(reservation)
			if (expired) {
				if (!this.attempt)
					this.update({ isLoginPending: false, loginError: 'popup_expired' })
				return
			}
			throw new TypeError('Invalid authentication popup reservation')
		}
		if (this.attempt) {
			if (
				this.attempt.reservation.popup !== reservation.popup ||
				this.attempt.reservation.requestId !== reservation.requestId
			)
				releaseAuthPopupReservation(reservation)
			this.refocus()
			return
		}
		const attempt: Attempt = {
			reservation: Object.freeze({
				...reservation,
				options: Object.freeze({ ...reservation.options }),
			}),
			verifying: false,
			abort: new AbortController(),
		}
		this.attempt = attempt
		this.timer = setInterval(() => {
			if (Date.now() - attempt.reservation.startedAt >= AUTH_POPUP_TIMEOUT_MS) {
				this.fail(attempt, 'popup_expired')
				return
			}
			// Do not inspect popup.closed: COOP can report it while CinaAuth remains open.
			try {
				const stored = localStorage.getItem(
					`${AUTH_POPUP_STORAGE_PREFIX}${attempt.reservation.requestId}`
				)
				if (stored) void this.receive(JSON.parse(stored) as unknown)
			} catch {
				/* Other transports remain available. */
			}
		}, 500)
		this.update({ isLoginPending: true, loginError: null })
		if (this.attempt !== attempt || attempt.abort.signal.aborted) return
		try {
			reservation.popup.location.replace(
				buildAuthStartPath(attempt.reservation.options, reservation.requestId)
			)
			reservation.popup.focus()
		} catch {
			this.fail(attempt, 'oidc_failed')
		}
	}

	attach = (): (() => void) => {
		const message = (event: MessageEvent<unknown>): void => {
			if (
				this.attempt &&
				event.origin === window.location.origin &&
				event.source === this.attempt.reservation.popup
			)
				void this.receive(event.data)
		}
		const storage = (event: StorageEvent): void => {
			if (
				!this.attempt ||
				event.key !==
					`${AUTH_POPUP_STORAGE_PREFIX}${this.attempt.reservation.requestId}` ||
				!event.newValue
			)
				return
			try {
				void this.receive(JSON.parse(event.newValue) as unknown)
			} catch {
				/* Invalid signal. */
			}
		}
		let channel: BroadcastChannel | undefined
		try {
			channel = new BroadcastChannel(AUTH_POPUP_CHANNEL)
			channel.onmessage = (event: MessageEvent<unknown>) => {
				void this.receive(event.data)
			}
		} catch {
			/* Other transports cover unsupported browsers. */
		}
		window.addEventListener('message', message)
		window.addEventListener('storage', storage)
		return () => {
			window.removeEventListener('message', message)
			window.removeEventListener('storage', storage)
			channel?.close()
			this.cancelLogin()
		}
	}
}
