/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { adminDomainIdentity } from '../domain-write-recovery'
import type { AdminDomainRecoveryController } from '../use-domain-write-recovery'
import type { UserChargedCostFactors } from '../user-charged-factors'
import { userWriteOutcomeUnknown } from '../users/users-errors'
import type { AdminUserDetailApi } from './user-detail-api'
import type { UserDetail } from './user-detail-contracts'
import { userFactorRecovery } from './user-factor-recovery'

export function useUserFactorWrite(props: {
	api: AdminUserDetailApi
	identity: string
	userId: string
	allowed: boolean
	onFailure: (error: unknown) => void
	onRecovered: (user: UserDetail) => void
}) {
	const store = userFactorRecovery(),
		identity = adminDomainIdentity(props.identity),
		controller = useRef<AbortController | null>(null),
		live = useRef(true),
		reviewed = useRef<string | null>(null)
	const options = {
		expectedConsoleSubject: identity?.subject,
		expectedUserId: identity?.userId,
	}
	const snapshot = useCallback(
			() => store.status(props.identity, props.userId),
			[store, props.identity, props.userId]
		),
		status = useSyncExternalStore(
			store.subscribe,
			snapshot,
			() => 'unavailable' as const
		)
	const [busy, setBusy] = useState(false),
		[open, setOpen] = useState(false),
		[error, setError] = useState(false)
	useEffect(() => {
		live.current = true
		return () => {
			live.current = false
			controller.current?.abort()
		}
	}, [props.identity, props.userId])
	useEffect(() => {
		if (!props.allowed) controller.current?.abort()
	}, [props.allowed])
	async function save(
		factors: UserChargedCostFactors,
		reason: string
	): Promise<UserDetail> {
		if (!props.allowed || status !== 'ready' || busy || controller.current)
			throw new Error('Factor write unavailable')
		const request = new AbortController()
		controller.current = request
		setBusy(true)
		let generation: string | null = null
		try {
			const result = await props.api.saveUserFactors(
				props.userId,
				props.userId,
				factors,
				reason,
				{
					...options,
					signal: request.signal,
					onDispatch: () => {
						generation = store.mark(props.identity, props.userId)
					},
				}
			)
			if (!live.current || request.signal.aborted)
				throw new Error('Factor write cancelled')
			if (!generation) throw new Error('Missing dispatch marker')
			store.settle(props.identity, props.userId, generation)
			return result
		} catch (e) {
			if (generation && !userWriteOutcomeUnknown(e))
				store.settle(props.identity, props.userId, generation)
			throw e
		} finally {
			controller.current = null
			if (live.current) setBusy(false)
		}
	}
	function close() {
		controller.current?.abort()
		setOpen(false)
		reviewed.current = null
	}
	const recovery: AdminDomainRecoveryController = {
		status,
		open,
		pending: busy,
		error,
		allowed: props.allowed,
		busy,
		show: () => {
			if (!busy && props.allowed) {
				reviewed.current = store.marker(props.identity, props.userId)
				setError(false)
				setOpen(true)
			}
		},
		close,
		review: async (external, accepts) => {
			if (
				!external ||
				!accepts ||
				!reviewed.current ||
				!props.allowed ||
				busy ||
				controller.current
			)
				return
			const generation = reviewed.current,
				request = new AbortController()
			controller.current = request
			setBusy(true)
			setError(false)
			try {
				await props.api.verifyUserFactorSubject({
					...options,
					signal: request.signal,
				})
				const user = await props.api.readUserFactorState(props.userId, {
					...options,
					signal: request.signal,
				})
				await props.api.verifyUserFactorSubject({
					...options,
					signal: request.signal,
				})
				if (!live.current || request.signal.aborted) return
				store.settle(props.identity, props.userId, generation)
				setOpen(false)
				reviewed.current = null
				props.onRecovered(user)
			} catch (e) {
				if (!request.signal.aborted) {
					setError(true)
					props.onFailure(e)
				}
			} finally {
				controller.current = null
				if (live.current) setBusy(false)
			}
		},
	}
	return { save, recovery, options }
}
