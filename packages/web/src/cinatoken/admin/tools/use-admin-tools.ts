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
import type { AdminToolsApi } from './tools-api'
import {
	toolAccessDenied,
	toolWriteUnknown,
	toolErrorKey,
	ToolSubjectError,
	ToolReadError,
} from './tools-errors'
import type { ToolMarkerInput, ToolMarker } from './tools-marker'
import { toolRecovery } from './tools-recovery'

export type AdminToolsProps = {
	api: AdminToolsApi
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	consoleSubject: string
	revalidate: () => Promise<void>
}
export function useAdminTools(props: AdminToolsProps) {
	const stores = toolRecovery(props.api),
		identity = props.reconciliationKey
	const blocked = useSyncExternalStore(
		stores.read.subscribe,
		() => stores.read.getSnapshot(identity),
		() => false
	)
	const deniedWrite = useSyncExternalStore(
		stores.writeAccess.subscribe,
		() => stores.writeAccess.getSnapshot(identity),
		() => false
	)
	const deniedReveal = useSyncExternalStore(
		stores.revealAccess.subscribe,
		() => stores.revealAccess.getSnapshot(identity),
		() => false
	)
	const deniedAudit = useSyncExternalStore(
		stores.auditAccess.subscribe,
		() => stores.auditAccess.getSnapshot(identity),
		() => false
	)
	const writeStatus = useSyncExternalStore(
		stores.write.subscribe,
		() => stores.write.status(identity),
		() => 'unavailable' as const
	)
	const active = useRef(true),
		busy = useRef(false),
		controller = useRef<AbortController | null>(null),
		action = useRef<(() => Promise<void>) | null>(null)
	const [error, setError] = useState<string | null>(null),
		[saved, setSaved] = useState(false)
	const query = useQuery({
		queryKey: ['cinatoken', 'admin', props.scopeKey, 'tools'],
		queryFn: ({ signal }) => props.api.adminToolsOverview({ signal }),
		enabled: !blocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const mutation = useMutation({
		mutationKey: ['cinatoken', 'admin', props.scopeKey, 'tools', 'write'],
		mutationFn: async () => {
			if (!action.current) throw new Error('Tools action unavailable')
			await action.current()
			return undefined
		},
		retry: false,
		gcTime: 0,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			action.current = null
		}
	}, [])
	const revalidate = props.revalidate
	const accessLost = useCallback(
		(kind: 'read' | 'write' | 'reveal' | 'audit', failure: unknown) => {
			if (!toolAccessDenied(failure)) return
			let store = stores.read
			if (
				!(failure instanceof ToolSubjectError) &&
				!(failure instanceof ToolReadError) &&
				!(failure instanceof CinaTokenApiError && failure.status === 401)
			) {
				if (kind === 'write') store = stores.writeAccess
				if (kind === 'reveal') store = stores.revealAccess
				if (kind === 'audit') store = stores.auditAccess
			}
			if (store.block(identity)) void revalidate().catch(() => undefined)
		},
		[stores, identity, revalidate]
	)
	useEffect(() => {
		if (query.error) accessLost('read', query.error)
	}, [query.error, accessLost])
	const authorized =
		props.canWrite &&
		!blocked &&
		!deniedWrite &&
		!query.error &&
		Boolean(query.data?.capabilities.can_write)
	const canWrite =
		authorized &&
		writeStatus === 'ready' &&
		!query.isFetching &&
		!mutation.isPending
	useEffect(() => {
		if (!authorized) controller.current?.abort()
	}, [authorized])
	async function perform(
		descriptor: ToolMarkerInput,
		run: (signal: AbortSignal) => Promise<void>
	): Promise<boolean> {
		const allowed =
			descriptor.operation === 'reveal'
				? props.canWrite &&
					!blocked &&
					!deniedReveal &&
					!query.error &&
					Boolean(query.data?.capabilities.can_reveal) &&
					writeStatus === 'ready'
				: canWrite
		if (!allowed || busy.current) return false
		let marker: ToolMarker
		try {
			marker = stores.write.markPending(identity, descriptor)
		} catch (failure) {
			setError(toolErrorKey(failure))
			return false
		}
		const abort = new AbortController()
		controller.current = abort
		busy.current = true
		setError(null)
		setSaved(false)
		action.current = () => run(abort.signal)
		try {
			await mutation.mutateAsync()
			if (!active.current || abort.signal.aborted) return false
			try {
				stores.write.settleKnown(identity, 'confirmed-2xx', marker)
			} catch {
				setError('confirmedLocked')
			}
			setSaved(true)
			void query.refetch()
			return true
		} catch (failure) {
			if (!active.current || abort.signal.aborted) return false
			if (!toolWriteUnknown(failure))
				try {
					stores.write.settleKnown(identity, 'definitive-rejection', marker)
				} catch {
					setError('storageUnavailable')
				}
			setError(
				toolWriteUnknown(failure) ? 'unknownWrite' : toolErrorKey(failure)
			)
			accessLost(
				descriptor.operation === 'reveal' ? 'reveal' : 'write',
				failure
			)
			if (failure instanceof CinaTokenApiError && failure.status === 409)
				void query.refetch()
			return false
		} finally {
			action.current = null
			controller.current = null
			busy.current = false
		}
	}
	return {
		query,
		blocked,
		deniedWrite,
		deniedReveal,
		deniedAudit,
		writeStatus,
		canWrite,
		canReveal:
			props.canWrite &&
			!blocked &&
			!deniedReveal &&
			Boolean(query.data?.capabilities.can_reveal) &&
			writeStatus === 'ready' &&
			!mutation.isPending,
		error,
		saved,
		busy: mutation.isPending,
		perform,
		accessLost,
		stores,
		identity,
	}
}
export type ToolsManager = ReturnType<typeof useAdminTools>
