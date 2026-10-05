import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, cinatokenApi, CinaTokenApiError } from '../../api'
import type {
	ByokKey,
	ByokListPage,
	PatchByokKeyInput,
} from '../../byok-contracts'
import type { ManagementKeyAccount } from '../../contracts'
import { useCinaTokenSession } from '../../session-context'
import {
	invalidatesAccountAccess as permissionFailure,
	isAccountContextMismatch,
	isUserMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import {
	byokCreateInput,
	byokPatchInput,
	type ByokForm,
} from './byok-form-schema'

export type ByokScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
	account: ManagementKeyAccount
}
type Task =
	| { kind: 'save'; values: ByokForm; id?: string }
	| { kind: 'patch'; id: string; patch: PatchByokKeyInput }
	| { kind: 'delete'; id: string }
export type ByokSelection = { id: string; mode: 'details' | 'edit' }

export function byokErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (isUserMismatch(error)) return 'cinatoken.account.sessionChanged'
		if (error.code === 'workspace-mismatch')
			return 'cinatoken.account.byok.mismatch'
		if (error.status === 409) return 'cinatoken.account.byok.conflict'
		if (error.status === 404) return 'cinatoken.account.byok.notFound'
		if (error.status === 400) return 'cinatoken.account.byok.invalid'
		if (error.status === 413) return 'cinatoken.account.byok.tooLarge'
	}
	return 'cinatoken.account.byok.saveFailed'
}

export function byokQueryKey(scope: ByokScope, ...parts: readonly unknown[]) {
	return accountQueryKey(
		scope.userId,
		scope.workspaceId,
		'byok',
		scope.scopeVersion,
		...parts
	)
}

export function useByokManager(scope: ByokScope) {
	const session = useCinaTokenSession()
	const queryClient = useQueryClient()
	const active = useRef(false)
	const pendingTask = useRef<Task | null>(null)
	const controllers = useRef(new Set<AbortController>())
	const [page, setPage] = useState(0)
	const [provider, setProvider] = useState('')
	const [createOpen, setCreateOpen] = useState(false)
	const [selected, setSelected] = useState<ByokSelection | null>(null)
	const [removeKey, setRemoveKey] = useState<ByokKey | null>(null)
	const [orderProvider, setOrderProvider] = useState<string | null>(null)
	const [accessDenied, setAccessDenied] = useState(false)
	const [accessError, setAccessError] = useState<unknown>(null)
	const [notice, setNotice] = useState<string | null>(null)
	const queryKey = useMemo(() => byokQueryKey(scope), [scope])
	const options = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
			expectedManagementAccount: scope.account,
		}),
		[scope]
	)
	const listQueryKey = useMemo(
		() => [...queryKey, 'list', page, provider, options],
		[queryKey, page, provider, options]
	)
	const query = useQuery({
		queryKey: listQueryKey,
		queryFn: ({ signal }) =>
			cinatokenApi.byokKeys({
				...options,
				offset: page * 50,
				limit: 50,
				...(provider ? { provider } : {}),
				signal,
			}),
		retry: false,
		staleTime: 15_000,
	})

	useEffect(() => {
		active.current = true
		const pending = controllers.current
		return () => {
			active.current = false
			pendingTask.current = null
			for (const controller of pending) controller.abort()
			pending.clear()
		}
	}, [])

	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				if (
					event.type === 'updated' &&
					event.action.type === 'success' &&
					queryClient
						.getQueryCache()
						.find({ queryKey: listQueryKey, exact: true }) === event.query
				) {
					const data = event.query.state.data as ByokListPage
					const lastPage = Math.max(0, Math.ceil(data.total / 50) - 1)
					setPage((current) => Math.min(current, lastPage))
				}
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!permissionFailure(event.query.state.error)
				)
					return
				if (
					!queryKey.every((part, index) => event.query.queryKey[index] === part)
				)
					return
				setAccessError(event.query.state.error)
				setAccessDenied(true)
				pendingTask.current = null
				setCreateOpen(false)
				setSelected(null)
				setRemoveKey(null)
				setOrderProvider(null)
				for (const controller of controllers.current) controller.abort()
			}),
		[queryClient, queryKey, listQueryKey]
	)

	const refresh = () => queryClient.invalidateQueries({ queryKey })
	const mutation = useMutation({
		mutationKey: [...queryKey, 'change'],
		retry: false,
		gcTime: 0,
		// No arguments: provider secrets must never enter React Query mutation.variables.
		mutationFn: async (): Promise<void> => {
			const task = pendingTask.current
			pendingTask.current = null
			if (!task) return
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const requestOptions = { ...options, signal: controller.signal }
				let nextNotice = 'updated'
				if (task.kind === 'save') {
					if (task.id)
						await cinatokenApi.updateByokKey(
							task.id,
							byokPatchInput(task.values),
							requestOptions
						)
					else {
						await cinatokenApi.createByokKey(
							byokCreateInput(task.values, scope.workspaceId),
							requestOptions
						)
						nextNotice = 'created'
					}
				} else if (task.kind === 'patch')
					await cinatokenApi.updateByokKey(task.id, task.patch, requestOptions)
				else {
					await cinatokenApi.deleteByokKey(task.id, requestOptions)
					nextNotice = 'removed'
				}
				if (!active.current || controller.signal.aborted) return
				setCreateOpen(false)
				setSelected(null)
				setRemoveKey(null)
				setNotice('cinatoken.account.byok.' + nextNotice)
			} finally {
				if (task.kind === 'save') task.values.key = ''
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void refresh()
		},
		onError: (error) => {
			if (!active.current) return
			if (permissionFailure(error)) {
				setAccessError(error)
				setAccessDenied(true)
				setCreateOpen(false)
				setSelected(null)
				setRemoveKey(null)
				setOrderProvider(null)
			}
			void refresh()
		},
	})
	const run = (task: Task) => {
		if (
			accessDenied ||
			permissionFailure(query.error) ||
			mutation.isPending ||
			pendingTask.current
		)
			return
		setNotice(null)
		pendingTask.current = task
		mutation.mutate()
	}
	const open = (operation: () => void) => {
		if (!query.isSuccess || accessDenied || mutation.isPending) return
		mutation.reset()
		setNotice(null)
		operation()
	}
	const retryAccess = () => {
		const revalidate = [accessError, query.error, mutation.error].some(
			requiresSessionRevalidation
		)
		mutation.reset()
		setAccessDenied(false)
		setAccessError(null)
		setNotice(null)
		if (revalidate) void session.revalidateScope()
		else void query.refetch()
	}
	return {
		query,
		mutation,
		page,
		setPage,
		provider,
		accessDenied: accessDenied || permissionFailure(query.error),
		userMismatch: [accessError, query.error, mutation.error].some(
			isUserMismatch
		),
		contextMismatch: [accessError, query.error, mutation.error].some(
			isAccountContextMismatch
		),
		notice,
		denyAccess: (error: unknown) => {
			setAccessError(error)
			setAccessDenied(true)
			setOrderProvider(null)
		},
		setProvider: (value: string) => {
			setPage(0)
			setProvider(value)
		},
		createOpen,
		selected,
		removeKey,
		orderProvider,
		setCreateOpen,
		setSelected,
		setRemoveKey,
		setOrderProvider,
		refresh,
		retryAccess,
		openCreate: () => open(() => setCreateOpen(true)),
		openDetails: (key: ByokKey, mode: ByokSelection['mode']) =>
			open(() => setSelected({ id: key.id, mode })),
		openRemove: (key: ByokKey) => open(() => setRemoveKey(key)),
		openOrder: (slug: string) => open(() => setOrderProvider(slug)),
		save: (values: ByokForm, id?: string) =>
			run({ kind: 'save', values: { ...values }, id }),
		toggle: (key: ByokKey) =>
			run({ kind: 'patch', id: key.id, patch: { disabled: !key.disabled } }),
		remove: (key: ByokKey) => run({ kind: 'delete', id: key.id }),
	}
}
