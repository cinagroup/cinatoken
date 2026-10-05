/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { configAccessIdentityKey } from '../config/config-access-recovery'
import {
	chainOperationsApi,
	type ChainWriteOptions,
} from './chain-operations-api'
import type {
	AdminWithdrawalRow,
	ChainList,
} from './chain-operations-contracts'
import {
	ChainOperationError,
	chainAccessDenied,
} from './chain-operations-errors'
import { reviewUnknownChainOperation } from './chain-operations-manual-recovery'
import {
	chainOperationRecovery,
	type ChainPendingMarker,
} from './chain-operations-recovery'
import type { ChainOperationsScreenProps } from './types'

export function useChainOperations(props: ChainOperationsScreenProps) {
	const api = props.api ?? chainOperationsApi
	const recovery = chainOperationRecovery(api)
	const identity = configAccessIdentityKey(props.session.reconciliationKey)
	const accessIdentity = identity + ':' + props.kind
	const queryClient = useQueryClient()
	const listSearch = useMemo(
		() => ({
			status: props.search.status,
			page: 1,
			limit: 5,
			invalid: props.search.invalid,
		}),
		[props.search.status, props.search.invalid]
	)
	const queryKey = [
		'cinatoken',
		'admin',
		props.session.scopeKey,
		'chain-operations',
		props.kind,
		listSearch,
		props.session.subject,
	]
	const [error, setError] = useState<unknown>(null)
	const [notice, setNotice] = useState<{
		kind: 'queued' | 'rejected' | 'released'
		count?: number
	} | null>(null)
	const [recovering, setRecovering] = useState(false)
	const active = useRef(true)
	const action = useRef<AbortController | null>(null)
	const readBlocked = useSyncExternalStore(
		recovery.read.subscribe,
		() => recovery.read.getSnapshot(accessIdentity),
		() => false
	)
	const writeDenied = useSyncExternalStore(
		recovery.writeAccess.subscribe,
		() => recovery.writeAccess.getSnapshot(accessIdentity),
		() => false
	)
	const writeStatus = useSyncExternalStore(
		recovery.write.subscribe,
		() => recovery.write.status(identity, props.kind),
		() => 'ready' as const
	)
	const query = useQuery<ChainList>({
		queryKey,
		queryFn: ({ signal }) =>
			props.kind === 'withdrawals'
				? api.chainWithdrawalList(listSearch, {
						signal,
						expectedConsoleSubject: props.session.subject,
					})
				: api.chainNftMintList(listSearch, {
						signal,
						expectedConsoleSubject: props.session.subject,
					}),
		enabled: props.session.enabled && !props.search.invalid && !readBlocked,
		retry: false,
		staleTime: 0,
		gcTime: 0,
		refetchOnWindowFocus: false,
	})
	const queryDenied = chainAccessDenied(query.error)
	const revalidate = props.session.revalidate
	useEffect(() => {
		if (queryDenied && recovery.read.block(accessIdentity))
			void revalidate?.().catch(() => undefined)
	}, [queryDenied, recovery, accessIdentity, revalidate])
	const scopeKey = props.session.scopeKey
	const kind = props.kind
	useEffect(() => {
		active.current = true
		const stop = () => {
			active.current = false
			action.current?.abort()
			const prefix = ['cinatoken', 'admin', scopeKey, 'chain-operations', kind]
			void queryClient.cancelQueries({ queryKey: prefix })
			queryClient.removeQueries({ queryKey: prefix })
		}
		const resume = (event: PageTransitionEvent) => {
			if (event.persisted) void revalidate?.().catch(() => undefined)
		}
		window.addEventListener('pagehide', stop)
		window.addEventListener('pageshow', resume)
		return () => {
			stop()
			window.removeEventListener('pagehide', stop)
			window.removeEventListener('pageshow', resume)
		}
	}, [queryClient, scopeKey, kind, revalidate])
	const mutation = useMutation({
		mutationKey: [
			'cinatoken',
			'admin',
			scopeKey,
			'chain-operations',
			kind,
			'write',
		],
		mutationFn: async (input: {
			operation: 'process' | 'reject'
			row?: AdminWithdrawalRow
			reason?: string
		}) => {
			if (
				action.current ||
				!active.current ||
				!props.session.enabled ||
				readBlocked ||
				writeDenied ||
				writeStatus !== 'ready' ||
				props.search.invalid
			)
				return false
			const controller = new AbortController()
			action.current = controller
			let marker: ChainPendingMarker | null = null
			const options: ChainWriteOptions = {
				signal: controller.signal,
				expectedConsoleSubject: props.session.subject,
				onDispatch: () => {
					if (!active.current || controller.signal.aborted)
						throw new ChainOperationError('subject')
					marker = recovery.write.markPending(identity, kind, input.operation)
				},
			}
			setError(null)
			setNotice(null)
			try {
				if (input.operation === 'process') {
					const result = await api.processChainOperations(
						kind,
						props.search.limit,
						options
					)
					if (marker)
						recovery.write.settleKnown(identity, kind, marker, 'confirmed-2xx')
					if (active.current && !controller.signal.aborted)
						setNotice({ kind: 'queued', count: result.queued })
				} else {
					if (!input.row) throw new ChainOperationError('input')
					await api.rejectChainWithdrawal(
						input.row,
						input.reason ?? '',
						options
					)
					if (marker)
						recovery.write.settleKnown(identity, kind, marker, 'confirmed-2xx')
					if (active.current && !controller.signal.aborted)
						setNotice({ kind: 'rejected' })
				}
				if (!active.current || controller.signal.aborted) return false
				await queryClient.invalidateQueries({
					queryKey: ['cinatoken', 'admin', scopeKey, 'chain-operations', kind],
				})
				return true
			} catch (failure) {
				if (
					marker &&
					failure instanceof ChainOperationError &&
					failure.causeCode === 'rejected'
				) {
					try {
						recovery.write.settleKnown(
							identity,
							kind,
							marker,
							'definitive-rejection'
						)
					} catch {
						/* Keep the operation locked if persistence cannot be confirmed. */
					}
				}
				if (!active.current || controller.signal.aborted) return false
				setError(failure)
				if (
					chainAccessDenied(failure) &&
					recovery.writeAccess.block(accessIdentity)
				)
					void revalidate?.().catch(() => undefined)
				return false
			} finally {
				if (action.current === controller) action.current = null
			}
		},
		retry: false,
		gcTime: 0,
	})
	const canWrite =
		props.session.enabled &&
		!props.search.invalid &&
		!readBlocked &&
		!queryDenied &&
		!writeDenied &&
		writeStatus === 'ready' &&
		!mutation.isPending &&
		!query.isFetching &&
		!query.error &&
		!!query.data
	function refresh(): void {
		if (query.isFetching || action.current) return
		recovery.read.settle(accessIdentity)
		recovery.writeAccess.settle(accessIdentity)
		if (readBlocked || writeDenied) void revalidate?.().catch(() => undefined)
		else void query.refetch()
	}
	async function releaseUnknown(checked: {
		reviewedExternal: boolean
		acceptsUnknown: boolean
	}): Promise<boolean> {
		if (
			!checked.reviewedExternal ||
			!checked.acceptsUnknown ||
			!active.current ||
			action.current ||
			readBlocked ||
			writeDenied ||
			!props.session.enabled ||
			props.search.invalid
		)
			return false
		const marker = recovery.write.marker(identity, kind)
		if (!marker) return false
		const controller = new AbortController()
		action.current = controller
		setRecovering(true)
		setError(null)
		const options = {
			signal: controller.signal,
			expectedConsoleSubject: props.session.subject,
		}
		try {
			const observation = await reviewUnknownChainOperation({
				api,
				kind,
				search: props.search,
				options,
				...checked,
			})
			if (!active.current || controller.signal.aborted) return false
			recovery.write.acknowledgeUnknown(identity, kind, marker)
			queryClient.setQueryData(queryKey, observation)
			setNotice({ kind: 'released' })
			return true
		} catch (failure) {
			if (active.current && !controller.signal.aborted) {
				setError(failure)
				if (
					chainAccessDenied(failure) &&
					recovery.writeAccess.block(accessIdentity)
				)
					void revalidate?.().catch(() => undefined)
			}
			return false
		} finally {
			if (action.current === controller) action.current = null
			if (active.current) setRecovering(false)
		}
	}
	return {
		query,
		error,
		notice,
		readBlocked: readBlocked || queryDenied,
		writeDenied,
		writeStatus,
		canWrite: canWrite && !recovering,
		busy: mutation.isPending || recovering,
		refresh,
		releaseUnknown,
		canRelease:
			writeStatus === 'pending' &&
			!!recovery.write.marker(identity, kind) &&
			props.session.enabled &&
			!props.search.invalid &&
			!readBlocked &&
			!queryDenied &&
			!writeDenied &&
			!query.error &&
			!!query.data &&
			!query.isFetching &&
			!recovering &&
			!mutation.isPending,
		process: () => mutation.mutateAsync({ operation: 'process' }),
		reject: (row: AdminWithdrawalRow, reason: string) =>
			mutation.mutateAsync({ operation: 'reject', row, reason }),
	}
}
