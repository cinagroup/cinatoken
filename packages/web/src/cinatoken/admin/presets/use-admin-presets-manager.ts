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
import {
	adminPresetAccessLost,
	adminPresetErrorKey,
	adminPresetReadFailed,
	adminPresetWriteUncertain,
} from './preset-errors'
import type { AdminPresetsApi } from './presets-api'
import type {
	AdminPresetMetadataPatch,
	AdminPresetSummary,
} from './presets-contracts'

export type AdminPresetsManagerProps = {
	api: AdminPresetsApi
	scopeKey: string
	reconciliationKey: string
	subject: string
	userId: string
	canWrite: boolean
	revalidate: () => Promise<void>
}
export type AdminPresetChange =
	| { kind: 'metadata'; patch: AdminPresetMetadataPatch }
	| { kind: 'archive' | 'restore' | 'public' | 'private' }
	| { kind: 'designate'; version: number }
export type AdminPresetPanel =
	| { kind: 'metadata'; row: AdminPresetSummary }
	| { kind: 'versions'; row: AdminPresetSummary }
	| { kind: 'confirm'; row: AdminPresetSummary; change: AdminPresetChange }
	| null

export function useAdminPresetsManager(props: AdminPresetsManagerProps) {
	const client = useQueryClient()
	const revalidate = props.revalidate
	const prefix = useMemo(
		() =>
			[
				'cinatoken',
				'admin',
				props.scopeKey,
				'presets',
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
	const [revoked, setRevoked] = useState(false)
	const [panel, setPanel] = useState<AdminPresetPanel>(null)
	const [versionTargetId, setVersionTargetId] = useState<string | null>(null)
	const [saving, setSaving] = useState(false)
	const [notice, setNotice] = useState(false)
	const [error, setError] = useState<unknown>(null)
	const [blockedError, setBlockedError] = useState<unknown>(null)
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
		setVersionTargetId(null)
		setSaving(false)
		setNotice(false)
		setError(null)
		setBlockedError(null)
	}
	const active = useRef(true)
	const writing = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const current = useRef(props)
	useLayoutEffect(() => {
		current.current = props
	}, [props])
	const isCurrent = useCallback(
		() =>
			active.current &&
			current.current.canWrite &&
			current.current.scopeKey === props.scopeKey &&
			current.current.reconciliationKey === props.reconciliationKey &&
			current.current.subject === props.subject &&
			current.current.userId === props.userId,
		[props.scopeKey, props.reconciliationKey, props.subject, props.userId]
	)
	const binding = useDomainWriteRecovery({
		...props,
		domain: 'presets',
		enabled: props.canWrite,
		verify: props.api.verifyAdminDomainSubject,
		observe: props.api.listPresets,
		onRecovered: recover,
		onFailure: (failure) => revoke(failure),
		isWriting: () => writing.current,
	})
	const writeUnconfirmed = binding.status !== 'ready'
	const list = useQuery({
		queryKey: [...prefix, 'list'],
		queryFn: ({ signal }) => props.api.listPresets(binding.readOptions(signal)),
		enabled: props.canWrite && !revoked,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const versions = useQuery({
		queryKey: [...prefix, 'versions', versionTargetId],
		queryFn: ({ signal }) =>
			props.api.listPresetVersions(
				versionTargetId!,
				binding.readOptions(signal)
			),
		enabled: props.canWrite && !revoked && versionTargetId !== null,
		retry: false,
		staleTime: 0,
		refetchOnWindowFocus: false,
	})
	const revoke = useCallback(
		(failure: unknown): void => {
			if (!adminPresetReadFailed(failure) || !isCurrent()) return
			setRevoked(true)
			setBlockedError(failure)
			setPanel(null)
			setVersionTargetId(null)
			setNotice(false)
			setError(null)
			controller.current?.abort()
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
			if (
				adminPresetAccessLost(failure) &&
				reserveDomainAutomaticRecheck(props.reconciliationKey, 'presets')
			)
				void revalidate().catch(() => undefined)
		},
		[client, prefix, props.reconciliationKey, revalidate, isCurrent]
	)
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
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
			controller.current = null
			writing.current = false
			void client.cancelQueries({ queryKey: prefix })
			client.removeQueries({ queryKey: prefix })
		}
	}, [client, prefix, scope])
	const hidden =
		revoked ||
		!props.canWrite ||
		Boolean(list.error) ||
		list.isFetching ||
		Boolean(versions.error) ||
		(writeUnconfirmed && !saving)
	const rows = hidden ? [] : (list.data ?? [])
	const disabled = hidden || writeUnconfirmed || saving
	function clearDrafts(): void {
		setPanel(null)
		setVersionTargetId(null)
		setError(null)
		setNotice(false)
	}
	/** Only the explicit fresh/observe/fresh protocol and generation CAS call this. */
	function recover(): void {
		if (!isCurrent()) return
		clearDrafts()
		setBlockedError(null)
		const resetting = client.resetQueries(
			{ queryKey: prefix },
			{ cancelRefetch: true }
		)
		setRevoked(false)
		void (async () => {
			await resetting
			if (isCurrent()) await list.refetch()
		})().catch((failure) => {
			if (isCurrent()) revoke(failure)
		})
	}
	function openMetadata(row: AdminPresetSummary): void {
		if (disabled || !rows.some((item) => item === row)) return
		setError(null)
		setNotice(false)
		setPanel({ kind: 'metadata', row })
	}
	function openVersions(row: AdminPresetSummary): void {
		if (hidden || saving || !rows.some((item) => item === row)) return
		setError(null)
		setVersionTargetId(row.id)
		setPanel({ kind: 'versions', row })
	}
	function stage(row: AdminPresetSummary, change: AdminPresetChange): void {
		if (disabled || !rows.some((item) => item === row)) return
		if (
			change.kind === 'designate' &&
			(row.status !== 'active' ||
				!versions.data?.some((version) => version.version === change.version))
		)
			return
		setError(null)
		setNotice(false)
		setPanel({ kind: 'confirm', row, change })
	}
	function close(): void {
		if (!writing.current) clearDrafts()
	}
	async function confirm(): Promise<void> {
		if (
			disabled ||
			writing.current ||
			!isCurrent() ||
			binding.status !== 'ready' ||
			panel?.kind !== 'confirm' ||
			!rows.some((row) => row === panel.row)
		)
			return
		const { row, change } = panel
		const abort = new AbortController()
		controller.current = abort
		writing.current = true
		binding.resetDispatch()
		setSaving(true)
		setError(null)
		setBlockedError(null)
		try {
			const writeOptions = binding.writeOptions(abort.signal)
			const options = {
				...writeOptions,
				onDispatch: (operation: string) => {
					if (!isCurrent() || abort.signal.aborted)
						throw new AdminDomainWriteError('subject', 401)
					writeOptions.onDispatch?.(operation)
				},
				expectedPreset: row,
			}
			if (change.kind === 'designate')
				await props.api.designatePreset(row.id, change.version, options)
			else if (change.kind === 'metadata')
				await props.api.patchPreset(row.id, change.patch, options)
			else if (change.kind === 'archive' || change.kind === 'restore')
				await props.api.patchPreset(
					row.id,
					{ status: change.kind === 'archive' ? 'archived' : 'active' },
					options
				)
			else
				await props.api.patchPreset(
					row.id,
					{ visibility: change.kind },
					options
				)
			if (!isCurrent() || abort.signal.aborted) return
			binding.settleKnown('confirmed-2xx')
			clearDrafts()
			setNotice(true)
			await client.invalidateQueries({ queryKey: [...prefix, 'list'] })
		} catch (failure) {
			if (!isCurrent() || abort.signal.aborted) return
			let writeError = failure
			if (
				failure instanceof AdminDomainWriteError &&
				failure.code === 'rejected'
			) {
				try {
					binding.settleKnown('definitive-rejection')
				} catch (settlementError) {
					writeError = settlementError
				}
			}
			setError(writeError)
			if (adminPresetWriteUncertain(writeError)) {
				setPanel(null)
				setVersionTargetId(null)
			}
			revoke(writeError)
		} finally {
			if (controller.current === abort) {
				controller.current = null
				writing.current = false
				if (isCurrent()) setSaving(false)
			}
		}
	}
	async function retry(): Promise<void> {
		if (revoked) {
			await props.revalidate()
			return
		}
		setError(null)
		if (versions.error && versionTargetId) await versions.refetch()
		else await list.refetch()
	}
	return {
		prefix,
		list,
		rows,
		versions,
		panel: hidden ? null : panel,
		notice,
		error,
		reconciliationError: blockedError,
		writeUnconfirmed,
		hidden,
		revoked,
		disabled,
		saving,
		manualRecovery: binding.manualRecovery,
		readOptions: binding.readOptions,
		openMetadata,
		openVersions,
		stage,
		close,
		confirm,
		retry,
		errorKey: adminPresetErrorKey,
	}
}
