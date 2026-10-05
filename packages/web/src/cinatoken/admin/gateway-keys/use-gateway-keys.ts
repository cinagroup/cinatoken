/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import type { AdminUsersApi } from '../users/users-api'
import type { AdminGatewayKeysApi } from './gateway-key-api'
import { GatewayKeyInputError } from './gateway-key-input'
import {
	gatewayKeyRecovery,
	gatewayKeyAccessDenied,
	gatewayKeyWriteUnknown,
	GatewayKeyPersistenceError,
} from './gateway-key-recovery'
import type { GatewayKeySearch } from './gateway-key-search'

export type GatewayKeysProps = {
	api: AdminGatewayKeysApi & Pick<AdminUsersApi, 'userCurrency'>
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
	search: GatewayKeySearch
}
type Outcome = 'saved' | 'rejected' | 'conflict' | 'unknown'
function errorKey(error: unknown): string {
	if (error instanceof GatewayKeyInputError) return 'invalidInput'
	if (error instanceof GatewayKeyPersistenceError) return 'storageUnavailable'
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'conflict'
	if (error instanceof CinaTokenApiError && error.status === 428)
		return 'revisionRequired'
	if (gatewayKeyAccessDenied(error)) return 'writeDenied'
	return gatewayKeyWriteUnknown(error) ? 'unknownWrite' : 'writeFailed'
}
export function useGatewayKeys(props: GatewayKeysProps) {
	const stores = gatewayKeyRecovery(props.api)
	const identity = props.reconciliationKey
	const readSnapshot = useCallback(
		() => stores.access.getSnapshot(identity),
		[stores.access, identity]
	)
	const deniedWriteSnapshot = useCallback(
		() => stores.writeAccess.getSnapshot(identity),
		[stores.writeAccess, identity]
	)
	const pendingSnapshot = useCallback(
		() => stores.write.status(identity),
		[stores.write, identity]
	)
	const guardrailSnapshot = useCallback(
		() => stores.guardrailAccess.getSnapshot(identity),
		[stores.guardrailAccess, identity]
	)
	const blocked = useSyncExternalStore(
		stores.access.subscribe,
		readSnapshot,
		readSnapshot
	)
	const deniedWrite = useSyncExternalStore(
		stores.writeAccess.subscribe,
		deniedWriteSnapshot,
		deniedWriteSnapshot
	)
	const writeStatus = useSyncExternalStore(
		stores.write.subscribe,
		pendingSnapshot,
		pendingSnapshot
	)
	const guardrailBlocked = useSyncExternalStore(
		stores.guardrailAccess.subscribe,
		guardrailSnapshot,
		guardrailSnapshot
	)
	const active = useRef(true)
	const busyRef = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const actionRef = useRef<(() => Promise<unknown>) | null>(null)
	const [writeError, setWriteError] = useState<string | null>(null)
	const [saved, setSaved] = useState(false)
	const query = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'gateway-keys',
			props.search,
		],
		queryFn: ({ signal }) => props.api.gatewayKeyList(props.search, { signal }),
		enabled: !blocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const currencyQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'gateway-keys',
			'currency',
		],
		queryFn: ({ signal }) => props.api.userCurrency({ signal }),
		enabled: !blocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'gateway-keys',
			'write',
		],
		mutationFn: async () => {
			if (!actionRef.current) throw new Error('No Gateway key operation')
			await actionRef.current()
			return { confirmed: true }
		},
		retry: false,
		gcTime: 0,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			actionRef.current = null
		}
	}, [])
	const revalidate = props.revalidate
	const invalidateRead = useCallback(() => {
		if (stores.access.block(identity)) void revalidate().catch(() => undefined)
	}, [stores.access, identity, revalidate])
	const invalidateGuardrail = useCallback(() => {
		if (stores.guardrailAccess.block(identity))
			void revalidate().catch(() => undefined)
	}, [stores.guardrailAccess, identity, revalidate])
	const readDenied = gatewayKeyAccessDenied(query.error)
	useEffect(() => {
		if (readDenied) invalidateRead()
	}, [readDenied, invalidateRead])
	const writeAuthorized =
		props.canWrite &&
		Boolean(query.data?.capabilities.can_write) &&
		!blocked &&
		!readDenied &&
		!deniedWrite &&
		!query.error
	useEffect(() => {
		if (!writeAuthorized) controller.current?.abort()
	}, [writeAuthorized])
	const canWrite =
		writeAuthorized &&
		writeStatus === 'ready' &&
		!query.isFetching &&
		!query.error &&
		!mutation.isPending
	async function perform(
		action: (signal: AbortSignal) => Promise<unknown>
	): Promise<Outcome> {
		if (!canWrite || busyRef.current) return 'rejected'
		try {
			stores.write.markPending(identity)
		} catch (error) {
			setWriteError(errorKey(error))
			return 'rejected'
		}
		busyRef.current = true
		setWriteError(null)
		setSaved(false)
		const abort = new AbortController()
		controller.current = abort
		actionRef.current = () => action(abort.signal)
		try {
			await mutation.mutateAsync()
			try {
				stores.write.settleKnown(identity, 'confirmed-2xx')
			} catch {
				if (active.current) setWriteError('confirmedLocked')
			}
			if (active.current) {
				setSaved(true)
				void query.refetch()
			}
			return 'saved'
		} catch (error) {
			const unknown = gatewayKeyWriteUnknown(error)
			let message = errorKey(error)
			if (!unknown) {
				try {
					stores.write.settleKnown(identity, 'definitive-rejection')
				} catch {
					message = 'storageUnavailable'
				}
			}
			if (active.current) {
				setWriteError(message)
				if (error instanceof CinaTokenApiError && error.status === 401)
					invalidateRead()
				else if (error instanceof CinaTokenApiError && error.status === 403) {
					if (stores.writeAccess.block(identity))
						void revalidate().catch(() => undefined)
				}
				if (error instanceof CinaTokenApiError && error.status === 409) {
					void query.refetch()
					return 'conflict'
				}
			}
			return unknown ? 'unknown' : 'rejected'
		} finally {
			busyRef.current = false
			actionRef.current = null
			controller.current = null
			mutation.reset()
		}
	}
	return {
		query,
		blocked: blocked || readDenied,
		canWrite,
		busy: mutation.isPending,
		currency:
			!currencyQuery.isFetching && !currencyQuery.error
				? (currencyQuery.data?.value ?? null)
				: null,
		writeStatus,
		deniedWrite,
		writeError,
		saved,
		perform,
		invalidateRead,
		guardrailBlocked,
		invalidateGuardrail,
	}
}
