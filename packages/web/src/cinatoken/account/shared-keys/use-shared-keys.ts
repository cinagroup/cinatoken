import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, cinatokenApi, CinaTokenApiError } from '../../api'
import { useCinaTokenSession } from '../../session-context'
import { SharedKeyHistoryConflict } from '../../shared-key-api'
import type { PatchSharedKeyInput, SharedKey } from '../../shared-key-contracts'
import {
	isAccountContextMismatch,
	isUserMismatch,
	isWorkspaceMismatch,
	requiresSessionRevalidation,
} from '../account-access'
import {
	sharedKeyCreateInput,
	sharedKeyPatchInput,
	type SharedKeyForm,
} from './shared-key-form'

export type SharedKeyScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
}
type Task =
	| { kind: 'save'; values: SharedKeyForm; id?: string }
	| { kind: 'patch'; id: string; patch: PatchSharedKeyInput }
	| { kind: 'validate' | 'delete'; id: string }
export function sharedKeyAccessFailure(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 ||
			error.status === 403 ||
			error.code === 'invalid-response' ||
			isAccountContextMismatch(error))
	)
}
export function sharedKeyErrorKey(
	error: unknown,
	action: 'save' | 'delete' | 'validate' | 'patch' = 'save'
): string {
	const prefix = 'cinatoken.account.sharedKeys.'
	if (error instanceof SharedKeyHistoryConflict) return prefix + 'historyLocked'
	if (error instanceof CinaTokenApiError) {
		if (isUserMismatch(error)) return 'cinatoken.account.sessionChanged'
		if (isWorkspaceMismatch(error)) return 'cinatoken.shell.workspaceChanged'
		if (error.status === 404) return prefix + 'notFound'
		if (error.status === 400) return prefix + 'invalid'
		if (error.status === 413) return prefix + 'tooLarge'
		if (error.status === 409)
			return prefix + (action === 'save' ? 'duplicate' : 'conflict')
		if (error.status === 403)
			return (
				prefix + (action === 'validate' ? 'adminDisabled' : 'operationDenied')
			)
	}
	return prefix + 'saveFailed'
}
export function sharedKeyQueryKey(scope: SharedKeyScope) {
	return accountQueryKey(
		scope.userId,
		scope.workspaceId,
		'shared-keys',
		'seller',
		scope.scopeVersion
	)
}

export function useSharedKeys(scope: SharedKeyScope) {
	const session = useCinaTokenSession()
	const queryClient = useQueryClient()
	const key = useMemo(() => sharedKeyQueryKey(scope), [scope])
	const options = useMemo(
		() => ({
			expectedSellerUserId: scope.userId,
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
		}),
		[scope]
	)
	const query = useQuery({
		queryKey: [...key, 'list', options],
		queryFn: ({ signal }) => cinatokenApi.sharedKeys({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const catalog = useQuery({
		queryKey: [...key, 'catalog', options],
		queryFn: ({ signal }) =>
			cinatokenApi.sharedKeyChannels({ ...options, signal }),
		retry: false,
		staleTime: 15_000,
	})
	const active = useRef(false)
	const pending = useRef<Task | null>(null)
	const controllers = useRef(new Set<AbortController>())
	const [form, setForm] = useState<{ row: SharedKey | null } | null>(null)
	const [remove, setRemove] = useState<SharedKey | null>(null)
	const [accessError, setAccessError] = useState<unknown>(null)
	const [action, setAction] = useState<Task['kind']>('save')
	const [notice, setNotice] = useState<string | null>(null)
	const closeSensitive = () => {
		setForm(null)
		setRemove(null)
		if (pending.current?.kind === 'save') pending.current.values.apiKey = ''
		pending.current = null
		for (const controller of controllers.current) controller.abort()
	}
	useEffect(() => {
		active.current = true
		const requests = controllers.current
		return () => {
			active.current = false
			if (pending.current?.kind === 'save') pending.current.values.apiKey = ''
			pending.current = null
			for (const controller of requests) controller.abort()
			requests.clear()
		}
	}, [])
	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					event.action.type !== 'error' ||
					!key.every((part, index) => event.query.queryKey[index] === part) ||
					!sharedKeyAccessFailure(event.query.state.error)
				)
					return
				setAccessError(event.query.state.error)
				setForm(null)
				setRemove(null)
				setNotice(null)
				if (pending.current?.kind === 'save') pending.current.values.apiKey = ''
				pending.current = null
				for (const controller of controllers.current) controller.abort()
			}),
		[key, queryClient]
	)
	const refresh = () => queryClient.invalidateQueries({ queryKey: key })
	const blocked =
		Boolean(accessError) ||
		sharedKeyAccessFailure(query.error) ||
		sharedKeyAccessFailure(catalog.error)
	const mutation = useMutation({
		mutationKey: [...key, 'change'],
		retry: false,
		gcTime: 0,
		// Neither input secrets nor creation responses belong in mutation.variables/data.
		mutationFn: async (): Promise<void> => {
			const task = pending.current
			pending.current = null
			if (!task) return
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const requestOptions = { ...options, signal: controller.signal }
				let nextNotice = 'saved'
				if (task.kind === 'save') {
					if (task.id)
						await cinatokenApi.updateSharedKey(
							task.id,
							sharedKeyPatchInput(task.values),
							requestOptions
						)
					else {
						const created = await cinatokenApi.createSharedKey(
							sharedKeyCreateInput(task.values),
							requestOptions
						)
						nextNotice = 'created_' + created.validation
					}
				} else if (task.kind === 'patch')
					await cinatokenApi.updateSharedKey(
						task.id,
						task.patch,
						requestOptions
					)
				else if (task.kind === 'delete') {
					await cinatokenApi.deleteSharedKey(task.id, requestOptions)
					nextNotice = 'removed'
				} else {
					const row = await cinatokenApi.revalidateSharedKey(
						task.id,
						requestOptions
					)
					nextNotice = 'validated_' + row.status
				}
				if (!active.current || controller.signal.aborted) return
				setForm(null)
				setRemove(null)
				setNotice('cinatoken.account.sharedKeys.' + nextNotice)
			} finally {
				if (task.kind === 'save') task.values.apiKey = ''
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void refresh()
		},
		onError: (error) => {
			if (!active.current) return
			// Action 403 may mean a closed channel or administrator-disabled key, not loss of seller identity.
			if (
				error instanceof CinaTokenApiError &&
				(error.status === 401 ||
					isAccountContextMismatch(error) ||
					error.code === 'invalid-response')
			) {
				setAccessError(error)
				closeSensitive()
			}
			void refresh()
		},
	})
	function run(task: Task) {
		if (blocked || mutation.isPending || pending.current) return
		setNotice(null)
		setAction(task.kind)
		pending.current = task
		mutation.mutate()
	}
	function open(row: SharedKey | null) {
		if (blocked || !query.isSuccess || !catalog.isSuccess || mutation.isPending)
			return
		mutation.reset()
		setNotice(null)
		setForm({ row })
	}
	return {
		query,
		catalog,
		mutation,
		form,
		remove,
		blocked,
		notice,
		action,
		userMismatch: [accessError, query.error, catalog.error].some(
			isUserMismatch
		),
		contextMismatch: [accessError, query.error, catalog.error].some(
			isAccountContextMismatch
		),
		openCreate: () => open(null),
		openEdit: (row: SharedKey) => open(row),
		closeForm: () => setForm(null),
		closeRemove: () => setRemove(null),
		openRemove: (row: SharedKey) => {
			if (!blocked && !mutation.isPending) {
				mutation.reset()
				setAction('delete')
				setRemove(row)
			}
		},
		save: (values: SharedKeyForm) =>
			run({
				kind: 'save',
				values: { ...values },
				...(form?.row ? { id: form.row.id } : {}),
			}),
		toggle: (row: SharedKey) => {
			if (row.status === 'active' || row.status === 'paused')
				run({
					kind: 'patch',
					id: row.id,
					patch: { status: row.status === 'active' ? 'paused' : 'active' },
				})
		},
		validate: (row: SharedKey) => {
			if (row.status === 'invalid' || row.status === 'validating')
				run({ kind: 'validate', id: row.id })
		},
		delete: () => {
			if (remove) run({ kind: 'delete', id: remove.id })
		},
		pauseInstead: () => {
			if (remove?.status === 'active')
				run({ kind: 'patch', id: remove.id, patch: { status: 'paused' } })
		},
		retry: () => {
			const revalidate = [accessError, query.error, catalog.error].some(
				requiresSessionRevalidation
			)
			mutation.reset()
			setAccessError(null)
			setNotice(null)
			if (revalidate) void session.revalidateScope()
			else void refresh()
		},
	}
}
