import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { accountQueryKey, cinatokenApi } from '../api'
import type { ManagementKey, ManagementKeyAccount } from '../contracts'
import { useCinaTokenSession } from '../session-context'
import {
	invalidatesAccountAccess,
	isAccountContextMismatch,
	isUserMismatch,
	requiresSessionRevalidation,
} from './account-access'
import {
	managementKeyInput,
	type ManagementKeyForm,
} from './management-key-form-schema'

type Scope = {
	userId: string
	workspaceId: string
	account: ManagementKeyAccount
}

export function useManagementKeyManager(scope: Scope) {
	const session = useCinaTokenSession()
	const queryClient = useQueryClient()
	const controllers = useRef(new Set<AbortController>())
	const active = useRef(false)
	const [secret, setSecret] = useState<string | null>(null)
	const [createOpen, setCreateOpen] = useState(false)
	const [revokeKey, setRevokeKey] = useState<ManagementKey | null>(null)
	const queryKey = accountQueryKey(
		scope.userId,
		scope.workspaceId,
		'management-keys',
		scope.account
	)
	const requestScope = {
		expectedUserId: scope.userId,
		expectedWorkspaceId: scope.workspaceId,
		expectedManagementAccount: scope.account,
	}
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			cinatokenApi.managementKeys({
				expectedUserId: scope.userId,
				expectedWorkspaceId: scope.workspaceId,
				expectedManagementAccount: scope.account,
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
			for (const controller of pending) controller.abort()
			pending.clear()
		}
	}, [])

	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				// Permission revocation observed by a background refetch must dispose of an open secret.
				if (event.type !== 'updated' || event.action.type !== 'error') return
				if (
					queryClient.getQueryCache().find({ queryKey, exact: true }) !==
					event.query
				)
					return
				const error = event.query.state.error
				if (invalidatesAccountAccess(error)) {
					setSecret(null)
					setCreateOpen(false)
					setRevokeKey(null)
					for (const controller of controllers.current) controller.abort()
				}
			}),
		[queryClient, queryKey]
	)

	const refresh = () => queryClient.invalidateQueries({ queryKey })
	const create = useMutation({
		mutationKey: accountQueryKey(
			scope.userId,
			scope.workspaceId,
			'create-management-key'
		),
		retry: false,
		gcTime: 0,
		mutationFn: async (values: ManagementKeyForm): Promise<void> => {
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const created = await cinatokenApi.createManagementKey(
					managementKeyInput(values),
					{ ...requestScope, signal: controller.signal }
				)
				if (!active.current || controller.signal.aborted) return
				// Neither the plaintext nor the creation response enters the mutation cache.
				setSecret(created.key)
				setCreateOpen(false)
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void refresh()
		},
		onError: (error) => {
			if (active.current && invalidatesAccountAccess(error)) {
				setSecret(null)
				setCreateOpen(false)
				setRevokeKey(null)
				for (const controller of controllers.current) controller.abort()
			}
		},
	})
	const revoke = useMutation({
		mutationKey: accountQueryKey(
			scope.userId,
			scope.workspaceId,
			'revoke-management-key'
		),
		retry: false,
		gcTime: 0,
		mutationFn: async (key: ManagementKey): Promise<void> => {
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				await cinatokenApi.revokeManagementKey(key.id, {
					...requestScope,
					signal: controller.signal,
				})
				if (!active.current || controller.signal.aborted) return
				setSecret(null)
				setRevokeKey(null)
			} finally {
				controllers.current.delete(controller)
			}
		},
		onSuccess: () => {
			if (active.current) void refresh()
		},
		onError: (error) => {
			if (active.current && invalidatesAccountAccess(error)) {
				setSecret(null)
				setCreateOpen(false)
				setRevokeKey(null)
				for (const controller of controllers.current) controller.abort()
			}
		},
	})
	const accessDenied = [query.error, create.error, revoke.error].some(
		invalidatesAccountAccess
	)
	const retryAccess = () => {
		const revalidate = [query.error, create.error, revoke.error].some(
			requiresSessionRevalidation
		)
		create.reset()
		revoke.reset()
		setSecret(null)
		setCreateOpen(false)
		setRevokeKey(null)
		if (revalidate) void session.revalidateScope()
		else void query.refetch()
	}
	const openCreate = () => {
		if (!query.isSuccess || accessDenied) return
		create.reset()
		setSecret(null)
		setCreateOpen(true)
	}
	const openRevoke = (key: ManagementKey) => {
		if (accessDenied) return
		revoke.reset()
		setRevokeKey(key)
	}

	return {
		query,
		create,
		revoke,
		secret,
		setSecret,
		createOpen,
		setCreateOpen,
		revokeKey,
		setRevokeKey,
		accessDenied,
		userMismatch: [query.error, create.error, revoke.error].some(
			isUserMismatch
		),
		contextMismatch: [query.error, create.error, revoke.error].some(
			isAccountContextMismatch
		),
		retryAccess,
		openCreate,
		openRevoke,
	}
}
