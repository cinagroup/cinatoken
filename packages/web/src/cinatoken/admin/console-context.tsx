/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
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
import { cinatokenApi } from '../api'
import { useCinaTokenSession } from '../session-context'
import {
	consoleIdentityForPortal,
	consoleMatchesPortal,
	consoleScopeKey,
} from './console-identity'
import {
	CinaTokenConsoleSessionController,
	type ConsoleSessionSnapshot,
} from './console-session'

type ConsoleContextValue = ConsoleSessionSnapshot & {
	scopeKey: string | null
	isVerified: boolean
	revalidate: () => Promise<void>
}
const ConsoleContext = createContext<ConsoleContextValue | null>(null)

export function CinaTokenConsoleProvider(props: { children: ReactNode }) {
	const queryClient = useQueryClient()
	const portal = useCinaTokenSession()
	const revalidatePortal = portal.revalidateScope
	const [controller] = useState(
		() =>
			new CinaTokenConsoleSessionController(cinatokenApi, async () => {
				await queryClient.cancelQueries({ queryKey: ['cinatoken', 'admin'] })
				queryClient.removeQueries({ queryKey: ['cinatoken', 'admin'] })
			})
	)
	const snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getSnapshot
	)
	const association = consoleIdentityForPortal(portal)
	const userId = association?.userId
	const subject = association?.subject
	const epoch = association?.epoch
	useEffect(() => {
		if (userId !== undefined && subject !== undefined && epoch !== undefined) {
			controller.setIdentity({ userId, subject, epoch })
			void controller.refresh()
		} else controller.clear()
	}, [controller, userId, subject, epoch])
	useEffect(() => {
		const visible = () => {
			if (document.visibilityState === 'visible') void controller.refresh()
		}
		window.addEventListener('focus', visible)
		document.addEventListener('visibilitychange', visible)
		return () => {
			window.removeEventListener('focus', visible)
			document.removeEventListener('visibilitychange', visible)
			// clear is reusable during React StrictMode's setup-cleanup-setup lifecycle.
			controller.clear()
		}
	}, [controller])
	const isVerified = consoleMatchesPortal(snapshot, association)
	const value = useMemo<ConsoleContextValue>(
		() => ({
			...snapshot,
			canWrite: isVerified,
			isVerified,
			scopeKey:
				isVerified && snapshot.identity
					? consoleScopeKey(snapshot.identity, snapshot.accessVersion)
					: null,
			revalidate: async () => {
				// Revoke console writes immediately, even if portal identity/capabilities stay unchanged.
				const check = controller.refresh()
				await Promise.all([check, revalidatePortal()])
			},
		}),
		[controller, isVerified, revalidatePortal, snapshot]
	)
	return (
		<ConsoleContext.Provider value={value}>
			{props.children}
		</ConsoleContext.Provider>
	)
}

// The provider and hook form one context API.
// eslint-disable-next-line react-refresh/only-export-components
export function useCinaTokenConsole(): ConsoleContextValue {
	const context = useContext(ConsoleContext)
	if (!context) throw new Error('CinaTokenConsoleProvider is missing')
	return context
}
