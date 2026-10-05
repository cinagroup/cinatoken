/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { reviewAdminDomainUnknown } from './domain-manual-recovery'
import type { AdminDomainRequestOptions } from './domain-transport'
import {
	adminDomainIdentity,
	adminDomainWriteRecovery,
	AdminDomainWriteError,
	type AdminDomainPendingMarker,
	type AdminWriteDomain,
} from './domain-write-recovery'

export type AdminDomainRecoveryController = {
	status: 'ready' | 'pending' | 'unavailable'
	open: boolean
	pending: boolean
	error: boolean
	readonly allowed: boolean
	readonly busy: boolean
	show: () => void
	close: () => void
	review: (reviewedExternal: boolean, acceptsUnknown: boolean) => Promise<void>
}
export type AdminDomainSessionProps = {
	reconciliationKey: string
	subject?: string
	userId?: string
}
const automaticRechecks = new Set<string>()
export function reserveDomainAutomaticRecheck(
	identity: string,
	domain: AdminWriteDomain
): boolean {
	const stable = adminDomainIdentity(identity)
	if (!stable) return false
	const key = JSON.stringify([stable.userId, stable.subject, domain])
	if (automaticRechecks.has(key)) return false
	automaticRechecks.add(key)
	return true
}
export function useDomainWriteRecovery(
	props: AdminDomainSessionProps & {
		domain: AdminWriteDomain
		enabled: boolean
		verify: (options: AdminDomainRequestOptions) => Promise<string>
		observe: (options: AdminDomainRequestOptions) => Promise<unknown>
		onRecovered: () => void
		onFailure: (error: unknown) => void
		isWriting?: () => boolean
	}
) {
	const recovery = adminDomainWriteRecovery()
	const identity = adminDomainIdentity(props.reconciliationKey)
	const subject = props.subject ?? identity?.subject ?? ''
	const userId = props.userId ?? identity?.userId ?? ''
	const snapshot = useCallback(
		() => recovery.status(props.reconciliationKey, props.domain),
		[recovery, props.reconciliationKey, props.domain]
	)
	const status = useSyncExternalStore(
		recovery.subscribe,
		snapshot,
		() => 'unavailable' as const
	)
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState(false)
	const live = useRef(true)
	const controller = useRef<AbortController | null>(null)
	const dispatched = useRef<AdminDomainPendingMarker | null>(null)
	const reviewedMarker = useRef<AdminDomainPendingMarker | null>(null)
	const current = useRef(props)
	useLayoutEffect(() => {
		current.current = props
	}, [props])
	function isCurrent(): boolean {
		const liveIdentity = adminDomainIdentity(current.current.reconciliationKey)
		return (
			live.current &&
			current.current.enabled &&
			current.current.reconciliationKey === props.reconciliationKey &&
			Boolean(subject) &&
			Boolean(userId) &&
			(current.current.subject ?? liveIdentity?.subject) === subject &&
			(current.current.userId ?? liveIdentity?.userId) === userId
		)
	}
	useLayoutEffect(() => {
		live.current = true
		return () => {
			live.current = false
			controller.current?.abort()
			reviewedMarker.current = null
			setOpen(false)
			setPending(false)
			setError(false)
		}
	}, [props.reconciliationKey, subject, userId, props.enabled])
	useEffect(() => {
		if (!props.enabled) {
			controller.current?.abort()
			reviewedMarker.current = null
		}
	}, [props.enabled])
	function close(): void {
		controller.current?.abort()
		controller.current = null
		reviewedMarker.current = null
		setOpen(false)
		setPending(false)
	}
	function readOptions(signal?: AbortSignal): AdminDomainRequestOptions {
		return { signal, expectedConsoleSubject: subject, expectedUserId: userId }
	}
	function writeOptions(
		signal: AbortSignal,
		domain: AdminWriteDomain = props.domain
	): AdminDomainRequestOptions {
		return {
			...readOptions(signal),
			onDispatch: (operation) => {
				if (!isCurrent() || signal.aborted || dispatched.current)
					throw new AdminDomainWriteError('storage')
				dispatched.current = recovery.markPending(
					props.reconciliationKey,
					domain,
					operation
				)
			},
		}
	}
	function settleKnown(
		outcome: 'confirmed-2xx' | 'definitive-rejection'
	): void {
		if (!isCurrent()) throw new AdminDomainWriteError('subject', 401)
		const marker = dispatched.current
		if (marker) recovery.settleKnown(props.reconciliationKey, marker, outcome)
		dispatched.current = null
	}
	function resetDispatch(): void {
		dispatched.current = null
	}
	async function review(
		reviewedExternal: boolean,
		acceptsUnknown: boolean
	): Promise<void> {
		if (
			pending ||
			controller.current ||
			current.current.isWriting?.() ||
			!isCurrent() ||
			!reviewedExternal ||
			!acceptsUnknown
		)
			return
		const marker = reviewedMarker.current
		if (!marker) {
			close()
			setError(true)
			return
		}
		const abort = new AbortController()
		controller.current = abort
		setPending(true)
		setError(false)
		try {
			const options = readOptions(abort.signal)
			await reviewAdminDomainUnknown({
				options,
				verify: current.current.verify,
				observe: current.current.observe,
				reviewedExternal,
				acceptsUnknown,
			})
			if (!isCurrent() || abort.signal.aborted) return
			recovery.acknowledgeUnknown(props.reconciliationKey, marker)
			dispatched.current = null
			reviewedMarker.current = null
			setOpen(false)
			current.current.onRecovered()
		} catch (failure) {
			if (isCurrent() && !abort.signal.aborted) {
				close()
				setError(true)
				current.current.onFailure(failure)
			}
		} finally {
			if (controller.current === abort) {
				controller.current = null
				if (live.current) setPending(false)
			}
		}
	}
	return {
		recovery,
		status,
		subject,
		userId,
		readOptions,
		writeOptions,
		settleKnown,
		resetDispatch,
		manualRecovery: {
			status,
			open: open && props.enabled,
			pending,
			error,
			allowed: props.enabled && Boolean(subject) && Boolean(userId),
			get busy() {
				return Boolean(current.current.isWriting?.())
			},
			show: () => {
				if (!isCurrent() || controller.current || current.current.isWriting?.())
					return
				reviewedMarker.current = recovery.marker(
					props.reconciliationKey,
					props.domain
				)
				setError(false)
				setOpen(true)
			},
			close,
			review,
		} satisfies AdminDomainRecoveryController,
	}
}
