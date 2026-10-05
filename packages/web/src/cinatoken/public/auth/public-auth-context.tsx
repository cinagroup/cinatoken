/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	createContext,
	useContext,
	useEffect,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from 'react'
import type { LoginOptions } from '../../auth-popup-contract'
import { createPublicAuthController } from './public-auth-controller'
import type { PublicAuthSnapshot } from './public-auth-types'

type PublicAuthValue = PublicAuthSnapshot & {
	begin: (options: LoginOptions, opener?: HTMLElement) => void
	cancel: () => void
	refocus: () => void
	retry: () => void
}
const PublicAuthContext = createContext<PublicAuthValue | null>(null)

export function PublicAuthProvider(props: { children?: ReactNode }) {
	const [controller] = useState(createPublicAuthController)
	const snapshot = useSyncExternalStore(
		controller.subscribe,
		controller.getSnapshot,
		controller.getServerSnapshot
	)
	useEffect(() => {
		window.addEventListener('pagehide', controller.cancel)
		return () => {
			window.removeEventListener('pagehide', controller.cancel)
			controller.dispose()
		}
	}, [controller])
	return (
		<PublicAuthContext.Provider
			value={{
				...snapshot,
				begin: controller.begin,
				cancel: controller.cancel,
				refocus: controller.refocus,
				retry: controller.retry,
			}}
		>
			{props.children}
		</PublicAuthContext.Provider>
	)
}

// Provider and consumer form one public context API.
// eslint-disable-next-line react-refresh/only-export-components
export function usePublicAuth(): PublicAuthValue {
	const context = useContext(PublicAuthContext)
	if (!context) throw new Error('PublicAuthProvider is missing')
	return context
}
