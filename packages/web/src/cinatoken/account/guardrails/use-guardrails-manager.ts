import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
	accountQueryKey,
	CinaTokenApiError,
	type CinaTokenApi,
} from '../../api'
import type { GuardrailsApi } from '../../guardrail-api'
import type {
	Guardrail,
	GuardrailInput,
	GuardrailPatch,
} from '../../guardrail-contracts'
import { useCinaTokenSession } from '../../session-context'
import {
	invalidatesAccountAccess,
	requiresSessionRevalidation,
} from '../account-access'

export type GuardrailsAccountApi = GuardrailsApi &
	Pick<CinaTokenApi, 'gatewayKeyContext'>
export type GuardrailScope = {
	userId: string
	workspaceId: string
	accountScopeKey: string
	scopeVersion: number
	canManageGatewayKeys: boolean
}
export type GuardrailAction =
	| { type: 'create'; input: GuardrailInput }
	| { type: 'version'; id: string; input: GuardrailInput }
	| { type: 'metadata'; id: string; input: GuardrailPatch }
	| { type: 'archive' | 'restore'; id: string }
	| { type: 'designate'; id: string; version: number }
	| { type: 'bind'; id: string; scopeType: 'user' | 'api_key'; scopeId: string }
	| {
			type: 'unbind'
			id: string
			scopeType: 'user' | 'api_key'
			scopeId: string
	  }
export function guardrailErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.code === 'user-mismatch') return 'sessionChanged'
		if (error.code === 'workspace-mismatch') return 'mismatch'
		if (error.status === 401) return 'sessionExpired'
		if (error.status === 403) return 'forbidden'
		if (error.status === 409) return 'conflict'
		if (error.status === 400) return 'invalid'
	}
	return 'failed'
}
export function permitsGuardrailAction(
	row: Guardrail | undefined,
	action: GuardrailAction,
	userId: string,
	keys: readonly { id: string; status: string }[]
): boolean {
	if (action.type === 'create') return true
	if (!row || row.id !== action.id) return false
	if (action.type === 'archive') return row.canArchive
	if (action.type === 'restore') return row.canRestore
	if (action.type === 'unbind') return true // Individual assignment permission is checked by manager and server.
	if (action.type === 'bind')
		return (
			row.canAssign &&
			(action.scopeType === 'user'
				? action.scopeId === userId
				: keys.some(
						(key) => key.id === action.scopeId && key.status === 'active'
					))
		)
	return row.canEdit
}
export function useGuardrailsManager(
	api: GuardrailsAccountApi,
	scope: GuardrailScope
) {
	const session = useCinaTokenSession()
	const client = useQueryClient()
	const active = useRef(false)
	const controller = useRef<AbortController | null>(null)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [apiKeyId, setApiKeyId] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<unknown>(null)
	const [notice, setNotice] = useState(false)
	const [blocked, setBlocked] = useState<string | null>(null)
	const [keysDenied, setKeysDenied] = useState(false)
	const options = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
			expectedAccountScopeKey: scope.accountScopeKey,
		}),
		[scope.userId, scope.workspaceId, scope.accountScopeKey]
	)
	const baseKey = useMemo(
		() =>
			accountQueryKey(
				scope.userId,
				scope.workspaceId,
				'guardrails',
				scope.scopeVersion
			),
		[scope.userId, scope.workspaceId, scope.scopeVersion]
	)
	const list = useQuery({
		queryKey: [...baseKey, 'list', options],
		queryFn: ({ signal }) => api.guardrails({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const keys = useQuery({
		queryKey: [...baseKey, 'keys', options],
		queryFn: ({ signal }) => api.gatewayKeyContext({ ...options, signal }),
		enabled: scope.canManageGatewayKeys && !keysDenied,
		retry: false,
		staleTime: 15_000,
	})
	const versions = useQuery({
		queryKey: [...baseKey, 'versions', selectedId, options],
		queryFn: ({ signal }) =>
			api.guardrailVersions(selectedId!, { ...options, signal }),
		enabled: selectedId !== null,
		retry: false,
	})
	const assignments = useQuery({
		queryKey: [...baseKey, 'assignments', selectedId, options],
		queryFn: ({ signal }) =>
			api.guardrailAssignments(selectedId!, { ...options, signal }),
		enabled: selectedId !== null,
		retry: false,
	})
	const effectiveKeyId =
		scope.canManageGatewayKeys && !keysDenied ? apiKeyId : null
	const preview = useQuery({
		queryKey: [...baseKey, 'preview', effectiveKeyId, options],
		queryFn: ({ signal }) =>
			api.effectiveGuardrails(effectiveKeyId, { ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	useEffect(() => {
		active.current = true
		return () => {
			active.current = false
			controller.current?.abort()
			void client.cancelQueries({ queryKey: baseKey })
			client.removeQueries({ queryKey: baseKey })
		}
	}, [client, baseKey])
	useEffect(
		() =>
			client.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!baseKey.every((part, index) => event.query.queryKey[index] === part)
				)
					return
				const failure = event.query.state.error
				if (
					event.query.queryKey[baseKey.length] === 'keys' &&
					failure instanceof CinaTokenApiError &&
					failure.status === 403
				) {
					setKeysDenied(true)
					setApiKeyId(null)
					return
				}
				if (!invalidatesAccountAccess(failure)) return
				setBlocked(guardrailErrorKey(failure))
				controller.current?.abort()
				if (requiresSessionRevalidation(failure))
					void session.revalidateScope().catch(() => undefined)
			}),
		[client, baseKey, session]
	)
	const failed =
		list.isError ||
		preview.isError ||
		(selectedId !== null && (versions.isError || assignments.isError))
	const canWrite =
		!blocked &&
		!pending &&
		!failed &&
		!list.isFetching &&
		!preview.isFetching &&
		list.isSuccess &&
		preview.isSuccess
	const canUseKeys =
		scope.canManageGatewayKeys &&
		!keysDenied &&
		!keys.isError &&
		keys.isSuccess &&
		!keys.isFetching
	const selected = list.data?.guardrails.find((row) => row.id === selectedId)
	async function mutate(action: GuardrailAction): Promise<boolean> {
		if (!active.current || controller.current || !canWrite) return false
		const row =
			'id' in action
				? list.data?.guardrails.find((row) => row.id === action.id)
				: undefined
		if (
			!permitsGuardrailAction(
				row,
				action,
				scope.userId,
				canUseKeys ? (keys.data?.keys ?? []) : []
			)
		)
			return false
		if (
			action.type === 'unbind' &&
			(!assignments.isSuccess ||
				!assignments.data.data.some(
					(row) =>
						row.guardrailId === action.id &&
						row.scopeType === action.scopeType &&
						row.scopeId === action.scopeId &&
						row.canUnbind
				))
		)
			return false
		const current = new AbortController()
		controller.current = current
		setPending(true)
		setError(null)
		setNotice(false)
		try {
			const args = { ...options, signal: current.signal }
			switch (action.type) {
				case 'create':
					await api.createGuardrail(action.input, args)
					break
				case 'version':
					await api.addGuardrailVersion(action.id, action.input, args)
					break
				case 'metadata':
					await api.patchGuardrail(action.id, action.input, args)
					break
				case 'archive':
					await api.archiveGuardrail(action.id, args)
					break
				case 'restore':
					await api.patchGuardrail(action.id, { status: 'active' }, args)
					break
				case 'designate':
					await api.designateGuardrailVersion(action.id, action.version, args)
					break
				case 'bind':
					await api.bindGuardrail(action.id, action, args)
					break
				case 'unbind':
					await api.unbindGuardrail(action, args)
					break
			}
			if (!active.current || current.signal.aborted) return false
			setNotice(true)
			return true
		} catch (failure) {
			if (!active.current || current.signal.aborted) return false
			setError(failure)
			if (
				invalidatesAccountAccess(failure) ||
				(failure instanceof CinaTokenApiError && failure.status === 409)
			)
				setBlocked(guardrailErrorKey(failure))
			if (requiresSessionRevalidation(failure))
				void session.revalidateScope().catch(() => undefined)
			return false
		} finally {
			if (controller.current === current) controller.current = null
			if (active.current && !current.signal.aborted) {
				setPending(false)
				// A response may be lost after a successful write. Read current state; never replay mutations.
				await client.invalidateQueries({ queryKey: baseKey })
			}
		}
	}
	async function refresh() {
		const results = await Promise.all([
			list.refetch(),
			preview.refetch(),
			...(selectedId ? [versions.refetch(), assignments.refetch()] : []),
		])
		const keyResult = scope.canManageGatewayKeys ? await keys.refetch() : null
		if (active.current && keyResult?.isSuccess) setKeysDenied(false)
		const keyInvalidatesSession =
			keyResult?.error &&
			invalidatesAccountAccess(keyResult.error) &&
			!(
				keyResult.error instanceof CinaTokenApiError &&
				keyResult.error.status === 403
			)
		if (
			active.current &&
			!keyInvalidatesSession &&
			results.every((value) => value.isSuccess)
		) {
			setBlocked(null)
			setError(null)
		}
	}
	return {
		list,
		keys,
		versions,
		assignments,
		preview,
		selected,
		selectedId,
		setSelectedId,
		apiKeyId: effectiveKeyId,
		setApiKeyId,
		pending,
		error,
		notice,
		blocked,
		canWrite,
		canUseKeys,
		keySelectionAllowed: scope.canManageGatewayKeys && !keysDenied,
		mutate,
		refresh,
	}
}
export type GuardrailsManager = ReturnType<typeof useGuardrailsManager>
