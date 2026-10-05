/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	reserveDomainAutomaticRecheck,
	useDomainWriteRecovery,
	type AdminDomainSessionProps,
} from '../use-domain-write-recovery'
import type { DataPoliciesApi } from './data-policy-api'
import type {
	DataPolicyListRow,
	DataPolicyUpsertInput,
} from './data-policy-contracts'
import {
	dataPolicyAccessDenied,
	dataPolicyErrorKey,
	dataPolicyErrorStatus,
	dataPolicyInvalidResponse,
	dataPolicyWriteUncertain,
} from './data-policy-errors'
import { observeDataPolicyFailures } from './data-policy-query-scope'

export type DataPoliciesManagerProps = AdminDomainSessionProps & {
	api: DataPoliciesApi
	scopeKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
}
type Panel = { kind: 'editor' | 'audit'; row: DataPolicyListRow } | null
type Task = { row: DataPolicyListRow; input: DataPolicyUpsertInput }

export function useDataPoliciesManager(props: DataPoliciesManagerProps) {
	const client = useQueryClient()
	const prefix = useMemo(
		() =>
			[
				'cinatoken',
				'admin',
				props.scopeKey,
				'data-policies',
				props.reconciliationKey,
				props.subject,
				props.userId,
				props.canWrite,
			] as const,
		[
			props.scopeKey,
			props.reconciliationKey,
			props.subject,
			props.userId,
			props.canWrite,
		]
	)
	const [revoked, setRevoked] = useState(false)
	const [blockedError, setBlockedError] = useState<unknown>(null)
	const [panel, setPanel] = useState<Panel>(null)
	const [notice, setNotice] = useState(false)
	const active = useRef(true)
	const controller = useRef<AbortController | null>(null)
	const task = useRef<Task | null>(null)
	const revalidating = useRef(false)
	const current = useRef(props)
	useLayoutEffect(() => {
		current.current = props
	}, [props])
	const isCurrent = useCallback((): boolean => {
		return (
			active.current &&
			current.current.scopeKey === props.scopeKey &&
			current.current.reconciliationKey === props.reconciliationKey &&
			current.current.subject === props.subject &&
			current.current.userId === props.userId &&
			current.current.canWrite === props.canWrite
		)
	}, [
		props.scopeKey,
		props.reconciliationKey,
		props.subject,
		props.userId,
		props.canWrite,
	])
	const revalidate = props.revalidate
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'data-policies',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: async (options) => {
			const listing = await props.api.dataPolicyListing(options)
			if (!listing.canWrite) throw new AdminDomainWriteError('subject', 403)
			return listing
		},
		onRecovered: () => {
			setRevoked(false)
			setBlockedError(null)
			setPanel(null)
			setNotice(false)
			mutation.reset()
			void list.refetch()
		},
		onFailure: (error) => revoke(error),
		isWriting: () => task.current !== null,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const list = useQuery({
		queryKey: [...prefix, 'list'],
		queryFn: ({ signal }) =>
			props.api.dataPolicyListing(binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const revoke = useCallback(
		(error: unknown): void => {
			if (!isCurrent()) return
			if (
				!dataPolicyAccessDenied(error) &&
				!dataPolicyInvalidResponse(error) &&
				dataPolicyErrorStatus(error) < 500
			)
				return
			setRevoked(true)
			setBlockedError(error)
			setPanel(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				dataPolicyAccessDenied(error) &&
				!revalidating.current &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'data-policies')
			) {
				revalidating.current = true
				void revalidate().catch(() => undefined)
			}
		},
		[client, prefix, props.reconciliationKey, revalidate, isCurrent]
	)
	useEffect(
		() =>
			observeDataPolicyFailures(
				client.getQueryCache(),
				prefix,
				(error, key) => {
					if (!isCurrent()) return
					if (key[prefix.length] === 'list') setPanel(null)
					revoke(error)
				}
			),
		[client, prefix, revoke, isCurrent]
	)

	const mutation = useMutation<void, Error, void>({
		mutationKey: [...prefix, 'upsert'],
		retry: false,
		gcTime: 0,
		mutationFn: async () => {
			const pending = task.current
			if (!pending) return
			const abort = new AbortController()
			controller.current = abort
			try {
				await props.api.upsertDataPolicy(
					pending.row.route_target_id,
					pending.input,
					{ ...binding.writeOptions(abort.signal), expectedPolicy: pending.row }
				)
				if (!isCurrent() || abort.signal.aborted) return
				binding.settleKnown('confirmed-2xx')
				setPanel(null)
				setNotice(true)
				void client.invalidateQueries({ queryKey: prefix })
			} catch (error) {
				let failure = error
				if (isCurrent() && !abort.signal.aborted) {
					if (
						error instanceof AdminDomainWriteError &&
						error.code === 'rejected'
					) {
						try {
							binding.settleKnown('definitive-rejection')
						} catch (settlementError) {
							failure = settlementError
						}
					}
					if (dataPolicyWriteUncertain(failure)) setPanel(null)
					revoke(failure)
				}
				throw failure
			} finally {
				if (task.current === pending) task.current = null
				if (controller.current === abort) controller.current = null
			}
		},
	})
	const resetMutation = mutation.reset
	useLayoutEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			task.current = null
			revalidating.current = false
			setRevoked(false)
			setBlockedError(null)
			setPanel(null)
			setNotice(false)
			resetMutation()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
		}
	}, [client, prefix, resetMutation])
	const hidden =
		revoked ||
		dataPolicyAccessDenied(list.error) ||
		dataPolicyInvalidResponse(list.error)
	const rows =
		hidden || list.error || list.isFetching ? [] : (list.data?.data ?? [])
	const canWrite = props.canWrite && list.data?.canWrite === true
	const disabled =
		hidden ||
		!canWrite ||
		Boolean(list.error) ||
		list.isFetching ||
		mutation.isPending ||
		writeUnconfirmed
	function open(next: Panel): void {
		if (hidden || list.error || list.isFetching) return
		if (
			next?.kind === 'editor' &&
			(disabled ||
				!next.row.current_subject_fingerprint ||
				next.row.current_policy_fingerprint === undefined)
		)
			return
		mutation.reset()
		setNotice(false)
		setPanel(next)
	}
	function close(): void {
		if (mutation.isPending) return
		setPanel(null)
		mutation.reset()
	}
	function save(targetId: string, input: DataPolicyUpsertInput): void {
		if (
			!isCurrent() ||
			disabled ||
			task.current ||
			binding.status !== 'ready' ||
			panel?.kind !== 'editor' ||
			panel.row.route_target_id !== targetId
		)
			return
		// Bind to the row originally reviewed; a background read cannot advance its precondition.
		task.current = { row: panel.row, input }
		binding.resetDispatch()
		void mutation.mutateAsync().catch(() => undefined)
	}
	async function retry(): Promise<void> {
		if (hidden) {
			await props.revalidate()
			return
		}
		await list.refetch()
	}
	return {
		prefix,
		list,
		rows,
		canWrite,
		panel: hidden || list.error || list.isFetching ? null : panel,
		mutation,
		notice,
		blockedError,
		reconciliationErrorKey: blockedError
			? dataPolicyErrorKey(blockedError)
			: null,
		writeUnconfirmed,
		hidden,
		disabled,
		manualRecovery: binding.manualRecovery,
		readOptions: binding.readOptions,
		open,
		close,
		save,
		retry,
		revoke,
	}
}
