/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
	userAccessDenied,
	userWriteOutcomeUnknown,
} from '../users/users-errors'
import { useUserDetailKeys } from './use-user-detail-keys'
import type { AdminUserDetailApi } from './user-detail-api'
import type {
	UserBudgetTransitionInput,
	UserBudgetTransitionPreview,
} from './user-detail-contracts'
import {
	buildFactorPatch,
	buildUserDetailPatches,
	type ChargedFactorRow,
	type UserDetailDraft,
} from './user-detail-domain'
import {
	userDetailAccessRecovery,
	type UserDetailAccessRecovery,
	type UserDetailDomain,
} from './user-detail-recovery'
import { budgetTransitionRecovery } from './user-detail-transition-recovery'

export type UserDetailManagerProps = {
	api: AdminUserDetailApi
	scopeKey: string
	reconciliationKey: string
	routeId: string
	canWrite: boolean
	revalidate: () => Promise<void>
	onCanonicalize: (userId: string) => void
	onDeleted: () => void
}

function isDenied(error: unknown): boolean {
	return userAccessDenied(error)
}
function useDomainBlocked(
	access: UserDetailAccessRecovery,
	identity: string,
	domain: UserDetailDomain
): boolean {
	const key = access.key(identity, domain)
	const snapshot = useCallback(() => access.getSnapshot(key), [access, key])
	return useSyncExternalStore(access.subscribe, snapshot, snapshot)
}

export function useAdminUserDetail(props: UserDetailManagerProps) {
	const client = useQueryClient()
	const access = userDetailAccessRecovery(props.api)
	const identity = props.reconciliationKey
	const revalidate = props.revalidate
	const scopeKey = props.scopeKey
	const userKey = [
		'cinatoken',
		'admin',
		props.scopeKey,
		'user-detail',
		props.routeId,
		'user',
	] as const
	const userBlocked = useDomainBlocked(access, identity, 'user')
	const keysBlocked = useDomainBlocked(access, identity, 'keys')
	const logsBlocked = useDomainBlocked(access, identity, 'logs')
	const auditsBlocked = useDomainBlocked(access, identity, 'audits')
	const modelsBlocked = useDomainBlocked(access, identity, 'models')
	const displayBlocked = useDomainBlocked(access, identity, 'display')
	const userWriteBlocked = useDomainBlocked(access, identity, 'user-write')
	const keyWriteBlocked = useDomainBlocked(access, identity, 'key-write')
	const [retryVersion, setRetryVersion] = useState(0)
	const [writeError, setWriteError] = useState<unknown>(null)
	const [writeNote, setWriteNote] = useState<
		'saved' | 'partial' | 'deleted' | null
	>(null)
	const [busy, setBusy] = useState(false)
	const [unknownWrite, setUnknownWrite] = useState(false)
	const [transitionState, setTransitionState] = useState<{
		input: UserBudgetTransitionInput
		preview: UserBudgetTransitionPreview
		identity: string
		budgetStateKey: string
	} | null>(null)
	const [transitionError, setTransitionError] = useState<unknown>(null)
	const userQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			props.routeId,
			'user',
			retryVersion,
		],
		queryFn: ({ signal }) => props.api.userDetail(props.routeId, { signal }),
		enabled: !userBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const user =
		userBlocked || userQuery.isFetching || userQuery.error
			? null
			: (userQuery.data ?? null)
	const userId = user?.id ?? ''
	const childKey = [
		'cinatoken',
		'admin',
		props.scopeKey,
		'user-detail',
		props.routeId,
		userId,
	] as const
	const keysQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			props.routeId,
			userId,
			'keys',
			retryVersion,
		],
		queryFn: ({ signal }) =>
			props.api.userDetailKeys(userId, userId, { signal }),
		enabled: Boolean(userId) && !keysBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const logsQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			props.routeId,
			userId,
			'logs',
			retryVersion,
		],
		queryFn: ({ signal }) =>
			props.api.userDetailLogs(userId, userId, { signal }),
		enabled: Boolean(userId) && !logsBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const auditsQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			props.routeId,
			userId,
			'audits',
			retryVersion,
		],
		queryFn: ({ signal }) =>
			props.api.userDetailAudits(userId, userId, { signal }),
		enabled: Boolean(userId) && !auditsBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const modelsQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			'models',
			retryVersion,
		],
		queryFn: ({ signal }) => props.api.userDetailModels({ signal }),
		enabled: Boolean(userId) && !modelsBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const displayQuery = useQuery({
		queryKey: [
			'cinatoken',
			'admin',
			props.scopeKey,
			'user-detail',
			'display',
			retryVersion,
		],
		queryFn: ({ signal }) => props.api.userDetailDisplay({ signal }),
		enabled: !displayBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const deniedDomains = useMemo(() => {
		const errors: [UserDetailDomain, unknown][] = [
			['user', userQuery.error],
			['keys', keysQuery.error],
			['logs', logsQuery.error],
			['audits', auditsQuery.error],
			['models', modelsQuery.error],
			['display', displayQuery.error],
		]
		return errors
			.filter(([, error]) => isDenied(error))
			.map(([domain]) => domain)
	}, [
		userQuery.error,
		keysQuery.error,
		logsQuery.error,
		auditsQuery.error,
		modelsQuery.error,
		displayQuery.error,
	])
	useEffect(() => {
		let changed = false
		for (const domain of deniedDomains)
			changed = access.block(access.key(identity, domain)) || changed
		if (changed) {
			void client.cancelQueries({
				queryKey: ['cinatoken', 'admin', scopeKey, 'user-detail'],
			})
			void revalidate().catch(() => undefined)
		}
	}, [access, client, deniedDomains, identity, revalidate, scopeKey])
	const userPatch = useMutation({
		mutationKey: [...childKey, 'write-user'],
		mutationFn: (patch: Record<string, unknown>) =>
			props.api.patchUserDetail(userId, userId, patch),
		retry: false,
		gcTime: 0,
	})
	const deleteUser = useMutation({
		mutationKey: [...childKey, 'delete-user'],
		mutationFn: () => props.api.deleteUserDetail(userId),
		retry: false,
		gcTime: 0,
	})
	const transitionPreviewMutation = useMutation({
		mutationKey: [...childKey, 'preview-budget-transition'],
		mutationFn: (input: UserBudgetTransitionInput) =>
			props.api.previewUserBudgetTransition(userId, input),
		retry: false,
		gcTime: 0,
	})
	const transitionApplyMutation = useMutation({
		mutationKey: [...childKey, 'apply-budget-transition'],
		mutationFn: (state: NonNullable<typeof transitionState>) =>
			props.api.applyUserBudgetTransition(
				userId,
				userId,
				state.input,
				state.preview
			),
		retry: false,
		gcTime: 0,
	})
	const transitionRecovery = budgetTransitionRecovery(props.api)
	const transitionSnapshot = useCallback(
		() => transitionRecovery.getSnapshot(identity, userId),
		[transitionRecovery, identity, userId]
	)
	const transitionUnknownSnapshot = useSyncExternalStore(
		transitionRecovery.subscribe,
		transitionSnapshot,
		transitionSnapshot
	)
	const transitionUnknown = Boolean(userId) && transitionUnknownSnapshot
	const budgetStateKey = user
		? JSON.stringify([
				user.id,
				user.updated_at,
				user.budget_max,
				user.budget_base,
				user.budget_spent,
				user.budget_period,
				user.budget_reset_at,
			])
		: null
	const activeTransitionState =
		budgetStateKey &&
		transitionState?.identity === identity &&
		transitionState.budgetStateKey === budgetStateKey
			? transitionState
			: null
	const keyAccessValid =
		props.canWrite &&
		Boolean(user) &&
		!keysBlocked &&
		!keysQuery.error &&
		!keyWriteBlocked
	const keyReadDenied = useCallback(() => {
		if (access.block(access.key(identity, 'keys')))
			void revalidate().catch(() => undefined)
	}, [access, identity, revalidate])
	const keyWriter = useUserDetailKeys({
		api: props.api,
		identity,
		scopeKey,
		userId,
		authorized: keyAccessValid,
		canStart:
			!busy && !unknownWrite && !transitionUnknown && !keysQuery.isFetching,
		onError: (error) => recordWriteError(error, 'key-write'),
		onInputError: setWriteError,
		onStart: () => {
			setWriteError(null)
			setWriteNote(null)
		},
		onSaved: async () => {
			setWriteNote('saved')
			await Promise.allSettled([keysQuery.refetch(), auditsQuery.refetch()])
		},
	})
	const keyCreateUnknown = keyWriter.legacyPending
	const canWriteUser =
		props.canWrite &&
		Boolean(user) &&
		!userWriteBlocked &&
		!busy &&
		!unknownWrite &&
		!keyCreateUnknown &&
		!transitionUnknown &&
		!keyWriter.busy &&
		!keyWriter.unknown
	const canWriteKeys = keyWriter.canWrite

	function recordWriteError(
		error: unknown,
		domain: 'user-write' | 'key-write'
	): void {
		setWriteError(error)
		if (userWriteOutcomeUnknown(error)) setUnknownWrite(true)
		if (isDenied(error)) {
			if (access.block(access.key(identity, domain)))
				void props.revalidate().catch(() => undefined)
		}
	}
	async function refreshAfterWrite(): Promise<void> {
		await Promise.allSettled([
			userQuery.refetch(),
			keysQuery.refetch(),
			logsQuery.refetch(),
			auditsQuery.refetch(),
		])
	}
	async function saveDraft(draft: UserDetailDraft): Promise<void> {
		if (!user || !canWriteUser) return
		setWriteError(null)
		setWriteNote(null)
		let patches: ReturnType<typeof buildUserDetailPatches>
		try {
			patches = buildUserDetailPatches(user, draft)
		} catch (error) {
			setWriteError(error)
			return
		}
		if (!patches.profile && !patches.budget) return
		setBusy(true)
		let saved = false
		try {
			if (patches.profile) {
				const updated = await userPatch.mutateAsync(patches.profile)
				client.setQueryData([...userKey, retryVersion], updated)
				saved = true
			}
			if (patches.budget) {
				const updated = await userPatch.mutateAsync(patches.budget)
				client.setQueryData([...userKey, retryVersion], updated)
				saved = true
			}
			setWriteNote('saved')
			if (props.routeId !== user.id) props.onCanonicalize(user.id)
			else await refreshAfterWrite()
		} catch (error) {
			setWriteNote(saved ? 'partial' : null)
			recordWriteError(error, 'user-write')
			if (saved) props.onCanonicalize(user.id)
		} finally {
			setBusy(false)
		}
	}
	async function previewBudgetTransition(
		input: UserBudgetTransitionInput
	): Promise<void> {
		if (!user || !canWriteUser || !currency) return
		setTransitionState(null)
		setTransitionError(null)
		setWriteError(null)
		setBusy(true)
		try {
			const preview = await transitionPreviewMutation.mutateAsync(input)
			if (budgetStateKey)
				setTransitionState({ input, preview, identity, budgetStateKey })
		} catch (error) {
			setTransitionError(error)
			if (isDenied(error) && access.block(access.key(identity, 'user-write')))
				void props.revalidate().catch(() => undefined)
		} finally {
			setBusy(false)
		}
	}
	async function applyBudgetTransition(): Promise<void> {
		if (!user || !canWriteUser || !activeTransitionState || !currency) return
		if (transitionRecovery.isStorageUnavailable(identity, userId)) return
		try {
			transitionRecovery.markPending(identity, userId)
		} catch (error) {
			setTransitionError(error)
			return
		}
		setBusy(true)
		setTransitionError(null)
		setWriteError(null)
		let confirmed = false
		try {
			const updated = await transitionApplyMutation.mutateAsync(
				activeTransitionState
			)
			confirmed = true
			client.setQueryData([...userKey, retryVersion], updated)
			transitionRecovery.settleKnownPost(identity, userId)
			setTransitionState(null)
			setWriteNote('saved')
			await refreshAfterWrite()
		} catch (error) {
			setTransitionState(null)
			setTransitionError(error)
			if (!confirmed && !userWriteOutcomeUnknown(error)) {
				try {
					transitionRecovery.settleKnownPost(identity, userId)
				} catch (settleError) {
					setTransitionError(settleError)
				}
			}
			if (!confirmed && userWriteOutcomeUnknown(error)) setUnknownWrite(true)
			if (isDenied(error) && access.block(access.key(identity, 'user-write')))
				void props.revalidate().catch(() => undefined)
		} finally {
			setBusy(false)
		}
	}
	async function saveFactors(rows: ChargedFactorRow[]): Promise<void> {
		if (!user || !canWriteUser) return
		setWriteError(null)
		let patch: Record<string, unknown> | null
		try {
			patch = buildFactorPatch(user.charged_cost_factors, rows)
		} catch (error) {
			setWriteError(error)
			return
		}
		if (!patch) return
		setBusy(true)
		try {
			const updated = await userPatch.mutateAsync(patch)
			client.setQueryData([...userKey, retryVersion], updated)
			setWriteNote('saved')
			await refreshAfterWrite()
		} catch (error) {
			recordWriteError(error, 'user-write')
		} finally {
			setBusy(false)
		}
	}
	async function hardDeleteUser(): Promise<void> {
		if (!user || !canWriteUser) return
		setBusy(true)
		setWriteError(null)
		try {
			await deleteUser.mutateAsync()
			props.onDeleted()
		} catch (error) {
			recordWriteError(error, 'user-write')
		} finally {
			setBusy(false)
		}
	}
	function retry(): void {
		for (const domain of [
			'user',
			'keys',
			'logs',
			'audits',
			'models',
			'display',
		] as const)
			access.clear(access.key(identity, domain))
		setRetryVersion((value) => value + 1)
	}
	const display =
		displayBlocked || displayQuery.error || displayQuery.isFetching
			? null
			: (displayQuery.data ?? null)
	const currency = display?.currency ?? null
	return {
		user,
		userQuery,
		keysQuery,
		logsQuery,
		auditsQuery,
		modelsQuery,
		displayQuery,
		currency,
		timezone: display?.timezone ?? null,
		blocked: {
			user: userBlocked,
			keys: keysBlocked,
			logs: logsBlocked,
			audits: auditsBlocked,
			models: modelsBlocked,
			display: displayBlocked,
			userWrite: userWriteBlocked,
			keyWrite: keyWriteBlocked,
		},
		canWriteUser,
		canWriteKeys,
		busy: busy || keyWriter.busy,
		writeError,
		writeNote,
		unknownWrite: unknownWrite || keyWriter.unknown,
		keyCreateUnknown,
		transitionUnknown,
		transitionSafetyUnavailable: transitionRecovery.isStorageUnavailable(
			identity,
			userId
		),
		transitionPreview: activeTransitionState?.preview ?? null,
		transitionError,
		keyCreateSafetyUnavailable: keyWriter.storageUnavailable,
		keyAccessValid,
		keyReadDenied,
		keyWriter,
		saveDraft,
		previewBudgetTransition,
		applyBudgetTransition,
		invalidateBudgetTransition: () => setTransitionState(null),
		saveFactors,
		hardDeleteUser,
		addKey: keyWriter.create,
		setKeyStatus: keyWriter.status,
		hardDeleteKey: keyWriter.remove,
		retry,
	}
}
