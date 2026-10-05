import { authCheckSchema, type AuthCheck } from '../contracts'

export type ConsoleSessionIdentity = Readonly<{
	userId: string
	subject: string
	/** The portal controller must advance this when the shared cookie or identity changes. */
	epoch: number
}>

export type ConsoleSessionStatus =
	'checking' | 'verified' | 'forbidden' | 'degraded'

export type ConsoleSessionSnapshot = Readonly<{
	status: ConsoleSessionStatus
	identity: ConsoleSessionIdentity | null
	canWrite: boolean
	isRefreshing: boolean
	accessVersion: number
	error:
		| 'console_check_unavailable'
		| 'console_check_cancelled'
		| 'console_cleanup_failed'
		| null
	reason:
		'identity_required' | 'console_required' | 'logged_out' | 'disposed' | null
}>

export type ConsoleSessionApi = {
	authCheck: (options?: { signal?: AbortSignal }) => Promise<AuthCheck>
}

export type ConsoleScopeInvalidation = Readonly<{
	identity: ConsoleSessionIdentity | null
	accessVersion: number
	reason: 'identity_changed' | 'recheck' | 'clear' | 'logout' | 'dispose'
}>

type Attempt = {
	version: number
	identity: ConsoleSessionIdentity
	signal: AbortSignal
}

function sameIdentity(
	left: ConsoleSessionIdentity | null,
	right: ConsoleSessionIdentity | null
): boolean {
	if (!left || !right) return left === right
	return (
		left.userId === right.userId &&
		left.subject === right.subject &&
		left.epoch === right.epoch
	)
}

/** Cancellation settles even when an injected transport ignores AbortSignal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const aborted = () => reject(new Error('Console check cancelled'))
		if (signal.aborted) {
			// Observe the work's rejection even if cancellation already won.
			void work.catch(() => undefined)
			aborted()
			return
		}
		signal.addEventListener('abort', aborted, { once: true })
		void work.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', aborted)
		})
	})
}

/**
 * Local console access gate; protected APIs must still authorize every request.
 * A live verified console subject must exactly match the caller's current portal
 * subject. Legacy responses without that proof never grant console access.
 * No isAdmin, popup completion, API-key principal, or browser storage grants access.
 */
export class CinaTokenConsoleSessionController {
	private snapshot: ConsoleSessionSnapshot = Object.freeze({
		status: 'forbidden',
		identity: null,
		canWrite: false,
		isRefreshing: false,
		accessVersion: 0,
		error: null,
		reason: 'identity_required',
	})
	private listeners = new Set<() => void>()
	private requestVersion = 0
	private request: AbortController | null = null
	private refreshPromise: Promise<void> | null = null
	private cleanup: Promise<boolean> = Promise.resolve(true)
	private pendingInvalidations = new Map<string, ConsoleScopeInvalidation>()
	private disposed = false

	constructor(
		private readonly api: ConsoleSessionApi,
		private readonly invalidateScope: (
			event: ConsoleScopeInvalidation
		) => void | Promise<void> = () => undefined
	) {}

	getSnapshot = (): ConsoleSessionSnapshot => this.snapshot

	subscribe = (listener: () => void): (() => void) => {
		if (this.disposed) return () => undefined
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private update(patch: Partial<ConsoleSessionSnapshot>): void {
		const next = { ...this.snapshot, ...patch }
		this.snapshot = Object.freeze({
			...next,
			canWrite: next.status === 'verified' && next.identity !== null,
		})
		this.listeners.forEach((listener) => listener())
	}

	private abortRequest(): void {
		this.requestVersion += 1
		this.request?.abort()
		this.request = null
		this.refreshPromise = null
	}

	private invalidate(reason: ConsoleScopeInvalidation['reason']): void {
		const event: ConsoleScopeInvalidation = Object.freeze({
			identity: this.snapshot.identity,
			accessVersion: this.snapshot.accessVersion,
			reason,
		})
		this.pendingInvalidations.set(this.invalidationKey(event), event)
		// Serialize cleanup and retain failed old identities. Successfully clearing the
		// new identity alone must not hide an earlier scope's failed cleanup.
		this.cleanup = this.cleanup.then(async () => {
			for (const pending of [...this.pendingInvalidations.values()]) {
				try {
					await this.invalidateScope(pending)
					const key = this.invalidationKey(pending)
					if (this.pendingInvalidations.get(key) === pending)
						this.pendingInvalidations.delete(key)
				} catch {
					// Retry still-pending cleanup before any subsequent grant.
				}
			}
			return this.pendingInvalidations.size === 0
		})
	}

	private invalidationKey(event: ConsoleScopeInvalidation): string {
		if (!event.identity) return 'null'
		return JSON.stringify([
			event.identity.userId,
			event.identity.subject,
			event.identity.epoch,
		])
	}

	setIdentity = (identity: ConsoleSessionIdentity | null): void => {
		if (this.disposed) return
		if (
			identity &&
			(!identity.userId.trim() ||
				!identity.subject.trim() ||
				!Number.isSafeInteger(identity.epoch) ||
				identity.epoch < 0)
		) {
			this.clear()
			throw new TypeError('Console portal identity is invalid')
		}
		if (sameIdentity(this.snapshot.identity, identity)) return
		this.abortRequest()
		this.update({
			status: 'forbidden',
			isRefreshing: false,
			accessVersion: this.snapshot.accessVersion + 1,
			error: null,
			reason: 'identity_required',
		})
		this.invalidate('identity_changed')
		this.update({
			identity: identity
				? Object.freeze({
						userId: identity.userId,
						subject: identity.subject,
						epoch: identity.epoch,
					})
				: null,
			status: identity ? 'checking' : 'forbidden',
			reason: identity ? null : 'identity_required',
		})
	}

	refresh = (): Promise<void> => {
		if (this.disposed || !this.snapshot.identity) return Promise.resolve()
		if (this.refreshPromise) return this.refreshPromise
		this.abortRequest()
		this.request = new AbortController()
		const attempt: Attempt = {
			version: this.requestVersion,
			identity: this.snapshot.identity,
			signal: this.request.signal,
		}
		this.update({
			status: 'checking',
			isRefreshing: true,
			accessVersion: this.snapshot.accessVersion + 1,
			error: null,
			reason: null,
		})
		// Rechecks revoke local writes synchronously and clear any previously privileged cache.
		this.invalidate('recheck')
		const next = this.performRefresh(attempt)
		this.refreshPromise = next
		void next.finally(() => {
			if (this.refreshPromise === next) {
				this.refreshPromise = null
				this.request = null
			}
		})
		return next
	}

	private isCurrent(attempt: Attempt): boolean {
		return (
			!this.disposed &&
			attempt.version === this.requestVersion &&
			attempt.identity === this.snapshot.identity
		)
	}

	private performRefresh = async (attempt: Attempt): Promise<void> => {
		try {
			const clean = await abortable(this.cleanup, attempt.signal)
			if (!this.isCurrent(attempt)) return
			if (!clean) {
				this.update({
					status: 'degraded',
					isRefreshing: false,
					error: 'console_cleanup_failed',
				})
				return
			}
			const result = await abortable(
				Promise.resolve().then(() => {
					if (!this.isCurrent(attempt) || attempt.signal.aborted)
						throw new Error('Console check cancelled')
					return this.api.authCheck({ signal: attempt.signal })
				}),
				attempt.signal
			)
			if (!this.isCurrent(attempt)) return
			const parsed = authCheckSchema.safeParse(result)
			if (!parsed.success) throw new Error('Invalid console check response')
			const check = parsed.data
			if (check.verification === 'degraded') {
				this.update({
					status: 'degraded',
					isRefreshing: false,
					error: 'console_check_unavailable',
				})
			} else {
				const verified =
					check.authenticated === true &&
					check.verification === 'verified' &&
					check.principalType === 'console' &&
					check.subject === attempt.identity.subject
				this.update({
					status: verified ? 'verified' : 'forbidden',
					isRefreshing: false,
					error: null,
					reason: verified ? null : 'console_required',
				})
			}
		} catch (error) {
			if (!this.isCurrent(attempt)) return
			const forbidden =
				typeof error === 'object' &&
				error !== null &&
				'status' in error &&
				(error.status === 401 || error.status === 403)
			this.update({
				status: forbidden ? 'forbidden' : 'degraded',
				isRefreshing: false,
				error: forbidden ? null : 'console_check_unavailable',
				reason: forbidden ? 'console_required' : null,
			})
		}
	}

	cancelRefresh = (): void => {
		if (this.disposed || !this.refreshPromise) return
		this.abortRequest()
		this.update({
			status: 'degraded',
			isRefreshing: false,
			error: 'console_check_cancelled',
			reason: null,
		})
	}

	private reset(reason: 'identity_required' | 'logged_out' | 'disposed'): void {
		this.abortRequest()
		this.update({
			status: 'forbidden',
			isRefreshing: false,
			accessVersion: this.snapshot.accessVersion + 1,
			error: null,
			reason,
		})
		let invalidationReason: ConsoleScopeInvalidation['reason'] = 'clear'
		if (reason === 'logged_out') invalidationReason = 'logout'
		if (reason === 'disposed') invalidationReason = 'dispose'
		this.invalidate(invalidationReason)
		this.update({ identity: null })
	}

	clear = (): void => {
		if (!this.disposed) this.reset('identity_required')
	}

	/** Local revocation only; the portal flow remains responsible for server logout. */
	logout = (): void => {
		if (!this.disposed) this.reset('logged_out')
	}

	/** Terminal lifecycle: create a new controller when mounting a new provider. */
	dispose = (): void => {
		if (this.disposed) return
		this.disposed = true
		this.reset('disposed')
		this.listeners.clear()
	}
}
