/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type {
	AuthPopupReservation,
	LoginOptions,
} from '../../auth-popup-contract'

export type PublicAuthPhase =
	'idle' | 'loading' | 'waiting' | 'verifying' | 'error'
export type PublicAuthSnapshot = Readonly<{
	phase: PublicAuthPhase
	error: string | null
}>
export type PublicAuthRuntime = {
	getSnapshot: () => PublicAuthSnapshot
	subscribe: (listener: () => void) => () => void
	begin: (reservation: AuthPopupReservation) => void
	refocus: () => void
	dispose: () => void
}
export type PublicAuthRuntimeModule = {
	createPublicAuthRuntime: (
		verified: (options: LoginOptions) => void
	) => PublicAuthRuntime
}
