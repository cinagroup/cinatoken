/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import { useAdminListDisplay } from './use-admin-list-display'
import {
	usersAccessIdentityKey,
	usersAccessRecovery,
} from './users-access-recovery'
import type { AdminUsersApi } from './users-api'
import { userAccessDenied, userWriteOutcomeUnknown } from './users-errors'
import { normalizeUserCreate, type UserCreateDraft } from './users-input'
import { usersListPath, type UsersSearch } from './users-search'
import { usersWriteRecovery } from './users-write-recovery'

export type AdminUsersManagerProps = {
	api: AdminUsersApi
	scopeKey: string
	reconciliationKey: string
	canWrite: boolean
	revalidate: () => Promise<void>
	search: UsersSearch
}

export function useAdminUsers(props: AdminUsersManagerProps) {
	const client = useQueryClient()
	const access = usersAccessRecovery(props.api)
	const accessKey = usersAccessIdentityKey(props.reconciliationKey)
	const write = usersWriteRecovery(props.api)
	const revalidate = props.revalidate
	const readSnapshot = useCallback(
		() => access.getReadSnapshot(accessKey),
		[access, accessKey]
	)
	const writeSnapshot = useCallback(
		() => access.getWriteSnapshot(accessKey),
		[access, accessKey]
	)
	const pendingSnapshot = useCallback(
		() => write.getSnapshot(accessKey),
		[write, accessKey]
	)
	const readBlocked = useSyncExternalStore(
		access.subscribe,
		readSnapshot,
		readSnapshot
	)
	const writeBlocked = useSyncExternalStore(
		access.subscribe,
		writeSnapshot,
		writeSnapshot
	)
	const writeUnknown = useSyncExternalStore(
		write.subscribe,
		pendingSnapshot,
		pendingSnapshot
	)
	const [createError, setCreateError] = useState<unknown>(null)
	const [created, setCreated] = useState(false)
	const [createdRefreshFailed, setCreatedRefreshFailed] = useState(false)
	const [confirmedButLocked, setConfirmedButLocked] = useState(false)
	const [retryVersion, setRetryVersion] = useState(0)
	const listPath = useMemo(() => usersListPath(props.search), [props.search])
	const listPrefix = useMemo(
		() => ['cinatoken', 'admin', props.scopeKey, 'users', 'list'] as const,
		[props.scopeKey]
	)
	const query = useQuery({
		queryKey: [...listPrefix, props.search, listPath, retryVersion],
		queryFn: ({ signal }) => props.api.userList(props.search, { signal }),
		enabled: !readBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const displayManager = useAdminListDisplay({
		api: props.api,
		scopeKey: props.scopeKey,
		reconciliationKey: props.reconciliationKey,
		domain: 'users',
		enabled: !readBlocked,
		revalidate: props.revalidate,
	})
	const currencyQuery = displayManager.query
	const retrying = useRef(false)
	const denied = userAccessDenied(query.error)
	useEffect(() => {
		if (!denied) return
		if (!access.blockRead(accessKey)) return
		void client.cancelQueries({ queryKey: listPrefix })
		client.removeQueries({ queryKey: listPrefix })
		void revalidate().catch(() => undefined)
	}, [access, accessKey, client, denied, listPrefix, revalidate])
	const mutation = useMutation({
		mutationKey: ['cinatoken', 'admin', props.scopeKey, 'users', 'create'],
		mutationFn: (draft: UserCreateDraft) => props.api.createUser(draft),
		retry: false,
		gcTime: 0,
	})

	async function create(draft: UserCreateDraft): Promise<boolean> {
		if (
			!props.canWrite ||
			readBlocked ||
			writeBlocked ||
			write.getSnapshot(accessKey) ||
			mutation.isPending ||
			query.isFetching ||
			query.error ||
			!query.data
		)
			return false
		setCreateError(null)
		setCreated(false)
		setCreatedRefreshFailed(false)
		setConfirmedButLocked(false)
		if (!currency) {
			setCreateError(new Error('currency-unavailable'))
			return false
		}
		try {
			normalizeUserCreate(draft)
		} catch (error) {
			setCreateError(error)
			return false
		}
		try {
			write.markPending(accessKey)
		} catch (error) {
			setCreateError(error)
			return false
		}
		try {
			await mutation.mutateAsync(draft)
		} catch (error) {
			setCreateError(error)
			if (!userWriteOutcomeUnknown(error)) {
				try {
					write.settleKnownPost(accessKey, 'definitive-rejection')
				} catch (settleError) {
					setCreateError(settleError)
				}
			}
			if (error instanceof CinaTokenApiError && error.status === 401) {
				if (access.blockRead(accessKey))
					void revalidate().catch(() => undefined)
			} else if (error instanceof CinaTokenApiError && error.status === 403)
				access.blockWrite(accessKey)
			return false
		}
		// A 2xx response confirms creation. Storage cleanup and list refresh are
		// separate; their failure must never reclassify the POST as uncertain.
		setCreated(true)
		try {
			write.settleKnownPost(accessKey, 'confirmed-2xx')
		} catch (error) {
			setConfirmedButLocked(true)
			setCreateError(error)
		}
		try {
			const result = await query.refetch()
			if (!result.isSuccess) setCreatedRefreshFailed(true)
		} catch {
			setCreatedRefreshFailed(true)
		}
		return true
	}

	function retry(): void {
		if (retrying.current || query.isFetching || currencyQuery.isFetching) return
		retrying.current = true
		access.settleRead(accessKey)
		access.settleWrite(accessKey)
		setRetryVersion((version) => version + 1)
		void currencyQuery.refetch().finally(() => {
			retrying.current = false
		})
	}
	const display = displayManager.display
	const currency = display?.currency ?? null
	return {
		query,
		currency,
		currencySource: display?.currencySource ?? null,
		display,
		timezone: display?.timezone ?? null,
		displayQuery: currencyQuery,
		writeSafetyUnavailable: write.isStorageUnavailable(accessKey),
		readBlocked,
		writeBlocked,
		writeUnknown,
		createError,
		created,
		createdRefreshFailed,
		confirmedButLocked,
		isCreating: mutation.isPending,
		canCreate:
			props.canWrite &&
			currency !== null &&
			!readBlocked &&
			!writeBlocked &&
			!writeUnknown &&
			!mutation.isPending &&
			!query.isFetching &&
			!query.error &&
			Boolean(query.data),
		create,
		retry,
	}
}
