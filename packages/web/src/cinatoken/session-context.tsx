import {
	createContext,
	useContext,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { cinatokenApi } from './api'
import { CinaAuthPopupController, type LoginOptions } from './auth-popup'
import { confirmsRestoredLogin } from './login-session'
import { CinaTokenSessionController, type SessionSnapshot } from './session'
import { notifySessionChanged, subscribeSessionChanges } from './session-events'

type SessionContextValue = SessionSnapshot & {
	isLoginPending: boolean
	loginError: string | null
	refresh: () => Promise<void>
	revalidateScope: () => Promise<void>
	login: (options?: LoginOptions) => void
	cancelLogin: () => void
	refocusLogin: () => void
	logout: () => Promise<void>
	switchWorkspace: (workspaceId: string) => Promise<void>
}

const SessionContext = createContext<SessionContextValue | null>(null)

export function CinaTokenSessionProvider(props: { children: ReactNode }) {
	const queryClient = useQueryClient()
	const [controller] = useState(
		() =>
			new CinaTokenSessionController(cinatokenApi, async () => {
				await queryClient.cancelQueries({ queryKey: ['cinatoken', 'account'] })
				queryClient.removeQueries({ queryKey: ['cinatoken', 'account'] })
			})
	)
	const [popup] = useState(
		() =>
			new CinaAuthPopupController(async (options, signal) => {
				// Popup completion is never identity proof; validate the server's HttpOnly cookie.
				const identity = await cinatokenApi.me({ signal })
				if (options.intent === 'admin') {
					const check = await cinatokenApi.authCheck({ signal })
					if (!check.authenticated) throw new Error('admin_forbidden')
					if (check.verification !== 'verified')
						throw new Error('session_unavailable')
					if (check.principalType !== 'console')
						throw new Error('admin_forbidden')
					if (check.subject !== identity.subject)
						throw new Error('admin_forbidden')
				}
				if (signal.aborted) return
				await controller.refresh()
				if (signal.aborted) return
				if (
					!confirmsRestoredLogin(
						controller.getSnapshot(),
						identity,
						options.intent
					)
				)
					throw new Error('session_unavailable')
				notifySessionChanged('login')
			})
	)
	const session = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot
	)
	const popupState = useSyncExternalStore(
		popup.subscribe,
		popup.getSnapshot,
		popup.getSnapshot
	)

	useEffect(() => {
		void controller.refresh()
		const detachPopup = popup.attach()
		const unsubscribe = subscribeSessionChanges((change) => {
			if (change === 'logout') {
				popup.cancelLogin()
				controller.clear()
			} else void controller.revalidateScope()
		})
		const refreshVisible = (): void => {
			if (document.visibilityState === 'visible') void controller.refresh()
		}
		window.addEventListener('focus', refreshVisible)
		document.addEventListener('visibilitychange', refreshVisible)
		return () => {
			unsubscribe()
			detachPopup()
			controller.dispose()
			window.removeEventListener('focus', refreshVisible)
			document.removeEventListener('visibilitychange', refreshVisible)
		}
	}, [controller, popup])

	const value = useMemo<SessionContextValue>(
		() => ({
			...session,
			...popupState,
			refresh: controller.refresh,
			revalidateScope: controller.revalidateScope,
			login: popup.login,
			cancelLogin: popup.cancelLogin,
			refocusLogin: popup.refocus,
			logout: async () => {
				popup.cancelLogin()
				await controller.logout()
				if (controller.getSnapshot().status === 'unauthenticated')
					notifySessionChanged('logout')
			},
			switchWorkspace: async (workspaceId: string) => {
				await controller.switchWorkspace(workspaceId)
				if (
					controller.getSnapshot().workspaceContext?.currentWorkspace.id ===
					workspaceId
				)
					notifySessionChanged('workspace')
			},
		}),
		[controller, popup, popupState, session]
	)

	return (
		<SessionContext.Provider value={value}>
			{props.children}
		</SessionContext.Provider>
	)
}

// The session provider and its consumer hook form one public context API.
// eslint-disable-next-line react-refresh/only-export-components
export function useCinaTokenSession(): SessionContextValue {
	const context = useContext(SessionContext)
	if (!context) throw new Error('CinaTokenSessionProvider is missing')
	return context
}
