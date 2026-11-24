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
	AdminGuardrailMetadataPatch,
	AdminGuardrailScopeType,
	AdminGuardrailSummary,
} from './guardrails-contracts'
import {
	adminGuardrailAccessLost,
	adminGuardrailCanResumeBinding,
	adminGuardrailCanResumeMetadata,
	adminGuardrailErrorKey,
	adminGuardrailReadFailed,
	adminGuardrailWriteUncertain,
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
export type AdminGuardrailBindingDraft = {
	scopeType: AdminGuardrailScopeType
	scopeId: string
}
export type AdminGuardrailChange =
	| { kind: 'archive' | 'restore' }
	| { kind: 'metadata'; patch: AdminGuardrailMetadataPatch }
	| { kind: 'designate'; version: number }
	| ({ kind: 'bind' } & AdminGuardrailBindingDraft)
	| { kind: 'unbind'; assignment: AdminGuardrailAssignment }
export type AdminGuardrailPanel =
	| {
			kind: 'metadata'
			row: AdminGuardrailSummary
			patch?: AdminGuardrailMetadataPatch
	  }
	| {
			kind: 'details'
			row: AdminGuardrailSummary
			draft?: AdminGuardrailBindingDraft
	  }
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
	const dispatchAuthority = useRef<AdminGuardrailList | null>(null)
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
			void (async () => {
				await resetting
				if (isCurrentScope()) await list.refetch()
			})().catch((failure) => {
				if (isCurrentScope()) revoke(failure)
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
			if (!adminGuardrailReadFailed(readError) || !isCurrentScope()) return
			setRevoked(true)
			setPanel(null)
			setTarget(null)
			setNotice(false)
			setError(null)
			setReconciliationError(readError)
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
	const hidden = revoked || Boolean(list.error) || list.isFetching
	const rows = hidden ? [] : (list.data?.rows ?? [])
	const canWrite = props.canWrite && !list.error && list.data?.canWrite === true
	const disabled = hidden || writeUnconfirmed || !canWrite || saving
	useLayoutEffect(() => {
		dispatchAuthority.current = canWrite && !hidden ? (list.data ?? null) : null
	}, [canWrite, hidden, list.data])
	if (
		panel !== null &&
		!saving &&
		!list.isFetching &&
		!list.error &&
		list.data &&
		(!list.data.rows.some((row) => row === panel.row) ||
			(panel.kind !== 'details' && !canWrite) ||
			(panel.kind === 'confirm' && panel.authority !== list.data))
	) {
		setPanel(null)
		setTarget(null)
	}
	const canResumeBinding =
		!disabled &&
		panel?.kind === 'confirm' &&
		panel.change.kind === 'bind' &&
		panel.authority === list.data &&
		rows.some((row) => row === panel.row) &&
		target === panel.row &&
		Boolean(details.data) &&
		!details.error &&
		!details.isFetching &&
		panel.row.status === 'active' &&
		!panel.row.isWorkspaceDefault &&
		!panel.row.isAccountDefault &&
		adminGuardrailCanResumeBinding(error)
	const canResumeMetadata =
		!disabled &&
		panel?.kind === 'confirm' &&
		panel.change.kind === 'metadata' &&
		panel.authority === list.data &&
		rows.some((row) => row === panel.row) &&
		adminGuardrailCanResumeMetadata(error)
	function openMetadata(row: AdminGuardrailSummary): void {
		if (disabled || writing.current || !rows.some((value) => value === row))
			return
		setError(null)
		setNotice(false)
		setTarget(null)
		setPanel({ kind: 'metadata', row })
	}
	function openDetails(row: AdminGuardrailSummary): void {
		if (
			hidden ||
			saving ||
			writing.current ||
			!rows.some((value) => value === row)
		)
			return
		setError(null)
		setNotice(false)
		setTarget(row)
		setPanel({ kind: 'details', row })
	}
	function stage(
		row: AdminGuardrailSummary,
		change: AdminGuardrailChange
	): void {
		if (
			disabled ||
			writing.current ||
			(panel?.kind === 'confirm' && error != null) ||
			!rows.some((value) => value === row)
		)
			return
		if (
			(change.kind === 'archive' || change.kind === 'restore') &&
			(row.isWorkspaceDefault || row.isAccountDefault)
		)
			return
		if (
			change.kind === 'metadata' &&
			(row.isWorkspaceDefault || row.isAccountDefault) &&
			change.patch.name !== undefined
		)
			return
		if (change.kind === 'designate' && row.status !== 'active') return
		if (
			(change.kind === 'bind' || change.kind === 'unbind') &&
			(row.isWorkspaceDefault || row.isAccountDefault)
		)
			return
		if (change.kind === 'bind' && row.status !== 'active') return
		if (
			(change.kind === 'bind' ||
				change.kind === 'unbind' ||
				change.kind === 'designate') &&
			(target !== row || !details.data || details.error || details.isFetching)
		)
			return
		if (
			change.kind === 'designate' &&
			!details.data?.versions.some(
				(version) => version.version === change.version
			)
		)
			return
		if (
			change.kind === 'unbind' &&
			(change.assignment.workspaceId !== row.workspaceId ||
				change.assignment.guardrailId !== row.id ||
				!details.data?.assignments.some((value) => value === change.assignment))
		)
			return
		if (!list.data) return
		setError(null)
		setNotice(false)
		setPanel({ kind: 'confirm', row, change, authority: list.data })
	}
	function close(): void {
		if (writing.current) return
		setPanel(null)
		setTarget(null)
	}
	function resumeBinding(): void {
		if (
			!isCurrentScope() ||
			!canResumeBinding ||
			panel?.kind !== 'confirm' ||
			panel.change.kind !== 'bind'
		)
			return
		setPanel({
			kind: 'details',
			row: panel.row,
			draft: {
				scopeType: panel.change.scopeType,
				scopeId: panel.change.scopeId,
			},
		})
		setError(null)
	}
	function resumeMetadata(): void {
		if (
			!isCurrentScope() ||
			!canResumeMetadata ||
			panel?.kind !== 'confirm' ||
			panel.change.kind !== 'metadata'
		)
			return
		setTarget(null)
		setPanel({ kind: 'metadata', row: panel.row, patch: panel.change.patch })
		setError(null)
	}
	async function confirm(): Promise<void> {
		if (
			disabled ||
			error != null ||
			writing.current ||
			binding.status !== 'ready' ||
			panel?.kind !== 'confirm' ||
			panel.authority !== list.data ||
			!isCurrentScope()
		)
			return
		const { row, change, authority } = panel
		const abort = new AbortController()
		controller.current = abort
		writing.current = true
		binding.resetDispatch()
		setSaving(true)
		setNotice(false)
		setError(null)
		setReconciliationError(null)
		try {
			const options = binding.writeOptions(abort.signal)
			const markDispatch = options.onDispatch
			options.onDispatch = (operation) => {
				if (
					!isCurrentScope() ||
					abort.signal.aborted ||
					!current.current.canWrite ||
					dispatchAuthority.current !== authority
				)
					throw new AdminDomainWriteError('subject', 401)
				markDispatch?.(operation)
			}
			let removed = true
			if (change.kind === 'metadata')
				await props.api.patchGuardrailMetadata(row, change.patch, options)
			else if (change.kind === 'archive' || change.kind === 'restore')
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
		} catch (failure) {
			if (!isCurrentScope() || abort.signal.aborted) return
			let writeError = failure
			if (
				failure instanceof AdminDomainWriteError &&
				failure.code === 'rejected'
			) {
				try {
					binding.settleKnown('definitive-rejection')
				} catch (settleError) {
					writeError = settleError
				}
			}
			setError(writeError)
			if (
				adminGuardrailWriteUncertain(writeError) ||
				(writeError instanceof AdminDomainWriteError &&
					writeError.code === 'subject')
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
		canResumeBinding,
		resumeBinding,
		canResumeMetadata,
		resumeMetadata,
		saving,
		manualRecovery: binding.manualRecovery,
		readOptions: binding.readOptions,
		openDetails,
		openMetadata,
		stage,
		close,
		confirm,
		retry,
		invalidateAccess: revoke,
		errorKey: adminGuardrailErrorKey,
	}
}
