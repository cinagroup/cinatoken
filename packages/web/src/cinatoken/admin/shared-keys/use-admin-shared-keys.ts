/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import {
	AdminSharedKeyConflictError,
	type AdminSharedKeysApi,
} from './shared-key-api'
import {
	adminSharedKeyAccessDenied,
	adminSharedKeyWriteUnknown,
	AdminSharedKeyInputError,
	AdminSharedKeyPersistenceError,
} from './shared-key-errors'
import type {
	AdminSharedKeyMarker,
	AdminSharedKeyMarkerInput,
} from './shared-key-marker'
import { adminSharedKeyRecovery } from './shared-key-recovery'
import type { AdminSharedKeySearch } from './shared-key-search'
import {
	useSharedKeyAccess,
	useSharedKeyPending,
} from './use-shared-key-access'

export type AdminSharedKeysProps = {
	api: AdminSharedKeysApi
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	consoleSubject: string
	revalidate: () => Promise<void>
	search: AdminSharedKeySearch
}
export type SharedKeyWriteOutcome =
	'saved' | 'rejected' | 'conflict' | 'unknown'
export function sharedKeyWriteErrorKey(error: unknown): string {
	if (error instanceof AdminSharedKeyInputError) return 'invalidInput'
	if (error instanceof AdminSharedKeyPersistenceError)
		return 'storageUnavailable'
	if (
		error instanceof AdminSharedKeyConflictError &&
		error.conflict === 'shared_key_earning_history_immutable'
	)
		return 'historyImmutable'
	if (error instanceof CinaTokenApiError && error.status === 409)
		return 'conflict'
	if (error instanceof CinaTokenApiError && error.status === 428)
		return 'revisionRequired'
	if (adminSharedKeyAccessDenied(error)) return 'writeDenied'
	return adminSharedKeyWriteUnknown(error) ? 'unknownWrite' : 'writeFailed'
}
export function useAdminSharedKeys(props: AdminSharedKeysProps) {
	const stores = adminSharedKeyRecovery(props.api)
	const identity = props.reconciliationKey
	const blocked = useSharedKeyAccess(stores.read, identity)
	const deniedWrite = useSharedKeyAccess(stores.writeAccess, identity)
	const deniedAudit = useSharedKeyAccess(stores.auditAccess, identity)
	const writeStatus = useSharedKeyPending(stores.write, identity)
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
			'shared-keys',
			props.search,
		],
		queryFn: ({ signal }) =>
			props.api.adminSharedKeyList(props.search, { signal }),
		enabled: !blocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const mutation = useMutation({
		mutationKey: ['cinatoken', 'admin', props.scopeKey, 'shared-keys', 'write'],
		mutationFn: async () => {
			if (!actionRef.current) throw new AdminSharedKeyInputError()
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
		if (stores.read.block(identity)) void revalidate().catch(() => undefined)
	}, [stores.read, identity, revalidate])
	const invalidateAudit = useCallback(() => {
		if (stores.auditAccess.block(identity))
			void revalidate().catch(() => undefined)
	}, [stores.auditAccess, identity, revalidate])
	const invalidateWrite = useCallback(() => {
		if (stores.writeAccess.block(identity))
			void revalidate().catch(() => undefined)
	}, [stores.writeAccess, identity, revalidate])
	const readDenied = adminSharedKeyAccessDenied(query.error)
	useEffect(() => {
		if (readDenied) invalidateRead()
	}, [readDenied, invalidateRead])
	const authorized =
		props.canWrite &&
		Boolean(query.data?.capabilities.can_write) &&
		!blocked &&
		!readDenied &&
		!deniedWrite &&
		!query.error
	useEffect(() => {
		if (!authorized) controller.current?.abort()
	}, [authorized])
	const canWrite =
		authorized &&
		writeStatus === 'ready' &&
		!query.isFetching &&
		!mutation.isPending
	async function perform(
		descriptor: AdminSharedKeyMarkerInput,
		action: (signal: AbortSignal) => Promise<unknown>
	): Promise<SharedKeyWriteOutcome> {
		if (!canWrite || busyRef.current) return 'rejected'
		let marker: AdminSharedKeyMarker
		try {
			marker = stores.write.markPending(identity, descriptor)
		} catch (error) {
			setWriteError(sharedKeyWriteErrorKey(error))
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
			if (!active.current || abort.signal.aborted) return 'unknown'
			try {
				stores.write.settleKnown(identity, 'confirmed-2xx', marker)
			} catch {
				if (active.current) setWriteError('confirmedLocked')
			}
			if (active.current) {
				setSaved(true)
				void query.refetch()
			}
			return 'saved'
		} catch (error) {
			const unknown = adminSharedKeyWriteUnknown(error)
			let message = sharedKeyWriteErrorKey(error)
			if (!unknown && active.current && !abort.signal.aborted)
				try {
					stores.write.settleKnown(identity, 'definitive-rejection', marker)
				} catch {
					message = 'storageUnavailable'
				}
			if (active.current) {
				setWriteError(message)
				if (error instanceof CinaTokenApiError && error.status === 401)
					invalidateRead()
				else if (
					error instanceof CinaTokenApiError &&
					error.status === 403 &&
					stores.writeAccess.block(identity)
				)
					void revalidate().catch(() => undefined)
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
		deniedWrite,
		deniedAudit,
		writeStatus,
		writeError,
		saved,
		busy: mutation.isPending,
		authorized,
		canWrite,
		perform,
		invalidateRead,
		invalidateAudit,
		invalidateWrite,
		clearNotification: () => {
			setWriteError(null)
			setSaved(false)
		},
	}
}
