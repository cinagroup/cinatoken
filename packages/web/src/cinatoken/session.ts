import { CinaTokenApiError, cinatokenApi, type CinaTokenApi } from './api'
import type { PortalMe, WorkspaceContext } from './contracts'

export type SessionStatus =
	'loading' | 'authenticated' | 'unauthenticated' | 'unavailable'
export type SessionError =
	'session_unavailable' | 'logout_failed' | 'workspace_switch_failed' | null
export type SessionSnapshot = {
	status: SessionStatus
	user: PortalMe | null
	workspaceContext: WorkspaceContext | null
	error: SessionError
	isRefreshing: boolean
	isSwitchingWorkspace: boolean
	isLoggingOut: boolean
	scopeVersion: number
}

const initialSnapshot: SessionSnapshot = {
	status: 'loading',
	user: null,
	workspaceContext: null,
	error: null,
	isRefreshing: false,
	isSwitchingWorkspace: false,
	isLoggingOut: false,
	scopeVersion: 0,
}

function identityPermissions(user: PortalMe): string {
	return JSON.stringify({
		userId: user.userId,
		subject: user.subject,
		isAdmin: user.isAdmin,
		capabilities: [...new Set(user.capabilities)].sort(),
		organizations: user.organizations
			.map((organization) => ({
				id: organization.organizationId,
				status: organization.status,
				organizationStatus: organization.organizationStatus,
				roles: [...new Set(organization.roles)].sort(),
			}))
			.sort((a, b) => a.id.localeCompare(b.id)),
	})
}

function workspacePermissions(context: WorkspaceContext): string {
	const workspace = context.currentWorkspace
	return JSON.stringify({
		id: workspace.id,
		scopeType: workspace.scopeType,
		status: workspace.status,
		personalOwnerUserId: workspace.personalOwnerUserId,
		organizationId: workspace.organizationId,
		role: workspace.role,
		accessSource: workspace.accessSource,
		organizationRoles: [...new Set(workspace.organizationRoles ?? [])].sort(),
	})
}

/** A monotonically increasing epoch prevents late checks from resurrecting a logged-out identity. */
export class CinaTokenSessionController {
	private snapshot: SessionSnapshot = { ...initialSnapshot }
	private listeners = new Set<() => void>()
	private epoch = 0
	private request: AbortController | null = null
	private refreshPromise: Promise<void> | null = null
	private pendingScopeRevalidation = false

	constructor(
		private readonly api: CinaTokenApi = cinatokenApi,
		private readonly invalidateScope: () => void | Promise<void> = () =>
			undefined
	) {}

	getSnapshot = (): SessionSnapshot => this.snapshot

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	private update(patch: Partial<SessionSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch }
		this.listeners.forEach((listener) => listener())
	}

	private begin(): { epoch: number; signal: AbortSignal } {
		this.epoch += 1
		this.request?.abort()
		this.refreshPromise = null
		this.request = new AbortController()
		return { epoch: this.epoch, signal: this.request.signal }
	}

	private isCurrent(epoch: number): boolean {
		return epoch === this.epoch
	}

	private isUnauthenticated(error: unknown): boolean {
		return (
			error instanceof CinaTokenApiError &&
			(error.status === 401 || error.status === 403)
		)
	}

	/** Cross-tab logout is only sent after server revocation succeeds. */
	clear = (): void => {
		this.pendingScopeRevalidation = false
		this.begin()
		this.update({
			...initialSnapshot,
			status: 'unauthenticated',
			scopeVersion: this.snapshot.scopeVersion + 1,
		})
		void this.invalidateScope()
	}

	refresh = (): Promise<void> => {
		if (this.snapshot.isLoggingOut || this.snapshot.isSwitchingWorkspace)
			return Promise.resolve()
		if (this.refreshPromise) return this.refreshPromise
		const next = this.performRefresh()
		this.refreshPromise = next
		void next.finally(() => {
			if (this.refreshPromise === next) this.refreshPromise = null
		})
		return next
	}

	private performRefresh = async (): Promise<void> => {
		const previous = this.snapshot
		const attempt = this.begin()
		this.update({ isRefreshing: true, error: null })
		try {
			const [identityResult] = await Promise.allSettled([
				this.api.me({ signal: attempt.signal }),
			])
			if (!this.isCurrent(attempt.epoch)) return
			if (identityResult.status === 'rejected') {
				if (this.isUnauthenticated(identityResult.reason)) this.clear()
				else
					this.update({
						status:
							previous.status === 'authenticated'
								? 'authenticated'
								: 'unavailable',
						isRefreshing: false,
						error: 'session_unavailable',
					})
				return
			}
			const user = identityResult.value
			// Workspace permissions depend on this freshly discovered identity.
			// The server precondition refuses a shared-cookie change between reads.
			const [workspaceResult] = await Promise.allSettled([
				this.api.workspaces({
					signal: attempt.signal,
					expectedUserId: user.userId,
				}),
			])
			if (!this.isCurrent(attempt.epoch)) return
			if (workspaceResult.status === 'rejected') {
				const lostWorkspaceAccess =
					this.isUnauthenticated(workspaceResult.reason) ||
					(workspaceResult.reason instanceof CinaTokenApiError &&
						workspaceResult.reason.code === 'user-mismatch')
				const changedIdentity =
					!previous.user ||
					identityPermissions(previous.user) !== identityPermissions(user)
				if (lostWorkspaceAccess || changedIdentity) {
					this.update({
						user,
						workspaceContext: null,
						status: 'unavailable',
						isRefreshing: false,
						scopeVersion: this.snapshot.scopeVersion + 1,
						error: 'session_unavailable',
					})
					await this.invalidateScope()
				} else
					this.update({
						user,
						status:
							previous.status === 'authenticated'
								? 'authenticated'
								: 'unavailable',
						isRefreshing: false,
						error: 'session_unavailable',
					})
				return
			}
			const workspaceContext = workspaceResult.value
			const changedScope =
				!this.snapshot.user ||
				!this.snapshot.workspaceContext ||
				identityPermissions(this.snapshot.user) !== identityPermissions(user) ||
				workspacePermissions(this.snapshot.workspaceContext) !==
					workspacePermissions(workspaceContext)
			if (changedScope) {
				// Hide old scope before removing its cache; no old rows remain visible during reconciliation.
				this.update({
					status: 'loading',
					scopeVersion: this.snapshot.scopeVersion + 1,
				})
				await this.invalidateScope()
				if (!this.isCurrent(attempt.epoch)) return
			}
			this.update({
				user,
				workspaceContext,
				status: 'authenticated',
				isRefreshing: false,
				error: null,
			})
		} catch (error) {
			if (!this.isCurrent(attempt.epoch)) return
			if (this.isUnauthenticated(error)) {
				this.clear()
				return
			}
			// Invalid JSON, a database outage, or cancellation never proves identity revocation.
			this.update({
				status:
					previous.status === 'authenticated' ? 'authenticated' : 'unavailable',
				isRefreshing: false,
				error: 'session_unavailable',
			})
		}
	}

	/** Another tab may have changed the shared cookie. Remove old rows before checking its new scope. */
	revalidateScope = async (): Promise<void> => {
		if (this.snapshot.isLoggingOut || this.snapshot.isSwitchingWorkspace) {
			this.pendingScopeRevalidation = true
			return
		}
		this.pendingScopeRevalidation = false
		const attempt = this.begin()
		this.update({
			status: 'loading',
			isRefreshing: true,
			error: null,
			scopeVersion: this.snapshot.scopeVersion + 1,
		})
		await this.invalidateScope()
		if (this.isCurrent(attempt.epoch)) await this.refresh()
	}

	logout = async (): Promise<void> => {
		if (this.snapshot.isLoggingOut) return
		const initiatingUserId = this.snapshot.user?.userId
		const attempt = this.begin()
		this.update({
			isLoggingOut: true,
			isRefreshing: false,
			isSwitchingWorkspace: false,
			error: null,
			scopeVersion: this.snapshot.scopeVersion + 1,
		})
		await this.invalidateScope()
		if (!this.isCurrent(attempt.epoch)) return
		try {
			await this.api.logout({ signal: attempt.signal })
			if (!this.isCurrent(attempt.epoch)) return
			const shouldRevalidate = this.pendingScopeRevalidation
			this.clear()
			// Successful revocation alone stays logged out. Only a queued cross-tab signal
			// permits a fresh server check, which can prove a subsequent different login.
			if (shouldRevalidate) await this.revalidateScope()
		} catch (error) {
			if (this.isCurrent(attempt.epoch)) {
				this.update({ isLoggingOut: false, error: 'logout_failed' })
				if (this.pendingScopeRevalidation) {
					await this.revalidateScope()
					if (
						this.snapshot.status === 'authenticated' &&
						this.snapshot.user?.userId === initiatingUserId
					)
						this.update({ error: 'logout_failed' })
				}
				throw error
			}
		}
	}

	switchWorkspace = async (workspaceId: string): Promise<void> => {
		if (this.snapshot.isLoggingOut || this.snapshot.isSwitchingWorkspace) return
		if (
			!this.snapshot.user ||
			!this.snapshot.workspaceContext?.workspaces.some(
				(workspace) => workspace.id === workspaceId
			)
		) {
			throw new CinaTokenApiError('Workspace access denied', 403, 'business')
		}
		if (this.snapshot.workspaceContext.currentWorkspace.id === workspaceId)
			return
		const startingWorkspaceId =
			this.snapshot.workspaceContext.currentWorkspace.id
		const initiatingUserId = this.snapshot.user.userId
		const attempt = this.begin()
		this.update({
			isSwitchingWorkspace: true,
			isRefreshing: false,
			error: null,
			scopeVersion: this.snapshot.scopeVersion + 1,
		})
		await this.invalidateScope()
		if (!this.isCurrent(attempt.epoch)) return
		try {
			const workspaceContext = await this.api.switchWorkspace(workspaceId, {
				signal: attempt.signal,
				expectedWorkspaceId: startingWorkspaceId,
				expectedUserId: initiatingUserId,
			})
			if (!this.isCurrent(attempt.epoch)) return
			if (this.pendingScopeRevalidation) {
				// The cookie changed elsewhere while this response was in flight. Do not
				// render its stale scope: resolve the server's latest identity and preference.
				this.update({ isSwitchingWorkspace: false, status: 'loading' })
				await this.revalidateScope()
				return
			}
			this.update({
				workspaceContext,
				status: 'authenticated',
				isSwitchingWorkspace: false,
			})
		} catch (error) {
			if (!this.isCurrent(attempt.epoch)) return
			if (error instanceof CinaTokenApiError && error.status === 401) {
				const shouldRevalidate = this.pendingScopeRevalidation
				this.clear()
				if (shouldRevalidate) await this.revalidateScope()
			} else {
				this.update({
					isSwitchingWorkspace: false,
					status: 'unavailable',
					error: 'workspace_switch_failed',
				})
				// A timeout may occur after the server changed its cookie. Re-read the authorized context
				// before restoring any account data instead of assuming the old preference survived.
				// This same reconciliation also consumes any queued cross-tab signal.
				await this.revalidateScope()
				if (
					this.snapshot.status === 'authenticated' &&
					this.snapshot.user?.userId === initiatingUserId
				)
					this.update({ error: 'workspace_switch_failed' })
			}
			throw error
		}
	}

	dispose = (): void => {
		this.epoch += 1
		this.request?.abort()
		this.request = null
		this.refreshPromise = null
		this.pendingScopeRevalidation = false
		// Effect remounts must be able to start a fresh check after an aborted mutation.
		this.snapshot = {
			...this.snapshot,
			isRefreshing: false,
			isSwitchingWorkspace: false,
			isLoggingOut: false,
		}
	}
}
