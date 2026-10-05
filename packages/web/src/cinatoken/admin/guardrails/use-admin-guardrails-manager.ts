/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AdminDomainWriteError } from '../domain-write-recovery'
import {
	reserveDomainAutomaticRecheck,
	useDomainWriteRecovery,
} from '../use-domain-write-recovery'
import type { AdminGuardrailsApi } from './guardrails-api'
import type {
	AdminGuardrailAssignment,
	AdminGuardrailList,
	AdminGuardrailScopeType,
	AdminGuardrailSummary,
} from './guardrails-contracts'
import {
	adminGuardrailAccessLost,
	adminGuardrailErrorKey,
} from './guardrails-errors'

export type AdminGuardrailsManagerProps = {
	api: AdminGuardrailsApi
	scopeKey: string
	reconciliationKey: string
	subject: string
	userId: string
	canWrite: boolean
	revalidate: () => Promise<void>
}
export type AdminGuardrailChange =
	| { kind: 'archive' | 'restore' }
	| { kind: 'designate'; version: number }
	| { kind: 'bind'; scopeType: AdminGuardrailScopeType; scopeId: string }
	| { kind: 'unbind'; assignment: AdminGuardrailAssignment }
export type AdminGuardrailPanel =
	| { kind: 'details'; row: AdminGuardrailSummary }
	| {
			kind: 'confirm'
			row: AdminGuardrailSummary
			change: AdminGuardrailChange
			authority: AdminGuardrailList
	  }
	| null

export function useAdminGuardrailsManager(props: AdminGuardrailsManagerProps) {
	const client = useQueryClient()
	const { reconciliationKey, revalidate } = props
	const prefix = useMemo(
		() =>
			[
				'cinatoken',
				'admin',
				props.scopeKey,
				'guardrails',
				props.canWrite,
				props.subject,
				props.userId,
				props.reconciliationKey,
			] as const,
		[
			props.scopeKey,
			props.canWrite,
			props.subject,
			props.userId,
			props.reconciliationKey,
		]
	)
	const listKey = useMemo(() => [...prefix, 'list'] as const, [prefix])
	const [revoked, setRevoked] = useState(false)
	const [panel, setPanel] = useState<AdminGuardrailPanel>(null)
	const [target, setTarget] = useState<AdminGuardrailSummary | null>(null)
	const [saving, setSaving] = useState(false)
	const [notice, setNotice] = useState(false)
	const [error, setError] = useState<unknown>(null)
	const [reconciliationError, setReconciliationError] = useState<unknown>(null)
	const scope = JSON.stringify([
		props.scopeKey,
		props.reconciliationKey,
		props.subject,
		props.userId,
		props.canWrite,
	])
	const [previousScope, setPreviousScope] = useState(scope)
	if (previousScope !== scope) {
		setPreviousScope(scope)
		setRevoked(false)
		setPanel(null)
		setTarget(null)
		setSaving(false)
		setNotice(false)
		setError(null)
		setReconciliationError(null)
	}
	const active = useRef(true)
	const current = useRef(props)
	const controller = useRef<AbortController | null>(null)
	const writing = useRef(false)
	useLayoutEffect(() => {
		current.current = props
	}, [props])
	const isCurrentScope = useCallback(
		() =>
			active.current &&
			current.current.scopeKey === props.scopeKey &&
			current.current.reconciliationKey === props.reconciliationKey &&
			current.current.subject === props.subject &&
			current.current.userId === props.userId &&
			current.current.canWrite === props.canWrite,
		[
			props.scopeKey,
			props.reconciliationKey,
			props.subject,
			props.userId,
			props.canWrite,
		]
	)
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'guardrails',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: async (options) => {
			const listing = await props.api.listGuardrails(options)
			if (!listing.canWrite) throw new AdminDomainWriteError('subject', 403)
			return listing
		},
		onRecovered: () => {
			if (!isCurrentScope()) return
			setPanel(null)
			setTarget(null)
			setNotice(false)
			setError(null)
			setReconciliationError(null)
			const resetting = client.resetQueries({ queryKey: prefix })
			setRevoked(false)
			void resetting.then(() => {
				if (isCurrentScope() && !client.getQueryState(listKey)?.error)
					void list.refetch()
			})
		},
		onFailure: (failure) => revoke(failure),
		isWriting: () => writing.current,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const list = useQuery({
		queryKey: listKey,
		queryFn: ({ signal }) =>
			props.api.listGuardrails(binding.readOptions(signal)),
		enabled: !revoked,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const targetId = target?.id ?? null
	const targetWorkspaceId = target?.workspaceId ?? null
	const details = useQuery({
		queryKey: [...prefix, 'details', targetId, targetWorkspaceId],
		queryFn: async ({ signal }) => {
			const options = binding.readOptions(signal)
			const [versions, assignments] = await Promise.all([
				props.api.listGuardrailVersions(targetId!, options),
				props.api.listGuardrailAssignments(
					{ id: targetId!, workspaceId: targetWorkspaceId! },
					options
				),
			])
			return { versions, assignments }
		},
		enabled: !revoked && target !== null,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const revoke = useCallback(
		(readError: unknown): void => {
			const failed =
				adminGuardrailAccessLost(readError) ||
				(typeof readError === 'object' &&
					readError !== null &&
					'status' in readError &&
					Number(readError.status) >= 500)
			if (!failed || !isCurrentScope()) return
			setRevoked(true)
			setPanel(null)
			setTarget(null)
			setNotice(false)
			setError(readError)
			setReconciliationError(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				adminGuardrailAccessLost(readError) &&
				reserveDomainAutomaticRecheck(reconciliationKey, 'guardrails')
			) {
				void revalidate().catch(() => undefined)
			}
		},
		[client, prefix, isCurrentScope, reconciliationKey, revalidate]
	)
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (event.type !== 'updated' || event.action.type !== 'error') return
				if (
					!prefix.every((part, index) => event.query.queryKey[index] === part)
				)
					return
				revoke(event.query.state.error)
			}),
		[client, prefix, revoke]
	)
	useLayoutEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			writing.current = false
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
		}
	}, [client, prefix, scope])
	const hidden =
		revoked ||
		Boolean(list.error) ||
		list.isFetching ||
		Boolean(details.error) ||
		(writeUnconfirmed && !saving)
	const rows = hidden ? [] : (list.data?.rows ?? [])
	const canWrite = props.canWrite && list.data?.canWrite === true
	const disabled = hidden || writeUnconfirmed || !canWrite || saving
	function openDetails(row: AdminGuardrailSummary): void {
		if (
			hidden ||
			!rows.some(
				(value) => value.id === row.id && value.workspaceId === row.workspaceId
			)
		)
			return
		setError(null)
		setTarget(row)
		setPanel({ kind: 'details', row })
	}
	function stage(
		row: AdminGuardrailSummary,
		change: AdminGuardrailChange
	): void {
		if (
			disabled ||
			!rows.some(
				(value) => value.id === row.id && value.workspaceId === row.workspaceId
			)
		)
			return
		if (
			(change.kind === 'archive' || change.kind === 'restore') &&
			(row.isWorkspaceDefault || row.isAccountDefault)
		)
			return
		if (change.kind === 'designate' && row.status !== 'active') return
		if (
			change.kind === 'bind' &&
			(row.status !== 'active' ||
				row.isWorkspaceDefault ||
				row.isAccountDefault)
		)
			return
		if (
			change.kind === 'unbind' &&
			(change.assignment.workspaceId !== row.workspaceId ||
				change.assignment.guardrailId !== row.id)
		)
			return
		if (!list.data) return
		setError(null)
		setNotice(false)
		setPanel({ kind: 'confirm', row, change, authority: list.data })
	}
	function close(): void {
		if (saving) return
		setPanel(null)
		setTarget(null)
		setError(null)
	}
	async function confirm(): Promise<void> {
		if (
			disabled ||
			writing.current ||
			binding.status !== 'ready' ||
			panel?.kind !== 'confirm' ||
			panel.authority !== list.data ||
			!isCurrentScope()
		)
			return
		const { row, change } = panel
		const abort = new AbortController()
		controller.current = abort
		writing.current = true
		binding.resetDispatch()
		setSaving(true)
		setError(null)
		setReconciliationError(null)
		try {
			const options = binding.writeOptions(abort.signal)
			const markDispatch = options.onDispatch
			options.onDispatch = (operation) => {
				if (
					!isCurrentScope() ||
					abort.signal.aborted ||
					!current.current.canWrite
				)
					throw new AdminDomainWriteError('subject', 401)
				markDispatch?.(operation)
			}
			let removed = true
			if (change.kind === 'archive' || change.kind === 'restore')
				await props.api.setGuardrailStatus(
					row,
					change.kind === 'archive' ? 'archived' : 'active',
					options
				)
			else if (change.kind === 'designate')
				await props.api.designateGuardrail(row, change.version, options)
			else if (change.kind === 'bind')
				await props.api.bindGuardrail(
					row,
					change.scopeType,
					change.scopeId,
					options
				)
			else if (change.kind === 'unbind')
				removed = await props.api.unbindGuardrail(
					row,
					change.assignment,
					options
				)
			if (
				!isCurrentScope() ||
				abort.signal.aborted ||
				!current.current.canWrite
			)
				return
			binding.settleKnown('confirmed-2xx')
			setPanel(null)
			setTarget(null)
			setNotice(removed)
			setError(removed ? null : { status: 409 })
			await client.invalidateQueries({ queryKey: listKey })
		} catch (writeError) {
			if (!isCurrentScope() || abort.signal.aborted) return
			if (
				writeError instanceof AdminDomainWriteError &&
				writeError.code === 'rejected'
			) {
				try {
					binding.settleKnown('definitive-rejection')
				} catch (settleError) {
					setError(settleError)
					setPanel(null)
					setTarget(null)
					return
				}
			}
			setError(writeError)
			if (
				writeError instanceof AdminDomainWriteError &&
				(writeError.code === 'unknown' || writeError.code === 'storage')
			) {
				setPanel(null)
				setTarget(null)
			}
			revoke(writeError)
		} finally {
			if (controller.current === abort) {
				controller.current = null
				writing.current = false
				if (isCurrentScope()) setSaving(false)
			}
		}
	}
	async function retry(): Promise<void> {
		if (revoked) {
			await props.revalidate()
			return
		}
		setError(null)
		setReconciliationError(null)
		if (details.error && target) await details.refetch()
		else await list.refetch()
	}
	let visiblePanel = panel
	if (
		hidden ||
		(panel?.kind === 'confirm' &&
			(!canWrite || (!saving && panel.authority !== list.data)))
	)
		visiblePanel = null
	return {
		list,
		rows,
		details,
		panel: visiblePanel,
		notice,
		error,
		reconciliationError,
		writeUnconfirmed,
		hidden,
		revoked,
		disabled,
		canWrite,
		saving,
		manualRecovery: binding.manualRecovery,
		readOptions: binding.readOptions,
		openDetails,
		stage,
		close,
		confirm,
		retry,
		invalidateAccess: revoke,
		errorKey: adminGuardrailErrorKey,
	}
}
