import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ActivityData, ActivityLog } from '../../activity-contracts'
import { accountQueryKey, cinatokenApi, CinaTokenApiError } from '../../api'
import { requiresSessionRevalidation } from '../account-access'
import { createActivityDownloadScope } from './activity-download'
import {
	EMPTY_ACTIVITY_FILTERS,
	type ActivityFilterForm,
} from './activity-filter-schema'
import { canOpenActivityGeneration } from './activity-format'

export type ActivityScope = {
	userId: string
	workspaceId: string
	scopeVersion: number
}
export type ActivityAccessFailure =
	'permission' | 'workspace' | 'user' | 'metadata'
export type SelectedActivityGeneration = {
	id: string
	chargedCost: number
	billingCurrency: string
}
type ExportNotice = { rowCount: number; total: number; truncated: boolean }

export function activityAccessFailure(
	error: unknown
): ActivityAccessFailure | null {
	if (!(error instanceof CinaTokenApiError)) return null
	if (error.code === 'user-mismatch') return 'user'
	if (error.status === 401 || error.status === 403) return 'permission'
	if (error.code === 'workspace-mismatch')
		return error.status === 409 ? 'workspace' : 'metadata'
	return null
}

export function activityErrorKey(error: unknown): string {
	if (error instanceof CinaTokenApiError) {
		if (error.code === 'user-mismatch')
			return 'cinatoken.account.sessionChanged'
		if (error.code === 'workspace-mismatch')
			return 'cinatoken.account.activity.workspaceChanged'
		if (error.status === 409) return 'cinatoken.account.activity.conflict'
	}
	return 'cinatoken.account.activity.loadFailed'
}

export function activityQueryKey(
	scope: ActivityScope,
	...parts: readonly unknown[]
) {
	return accountQueryKey(
		scope.userId,
		scope.workspaceId,
		'activity',
		scope.scopeVersion,
		...parts
	)
}

export function useActivityManager(scope: ActivityScope) {
	const queryClient = useQueryClient()
	const active = useRef(false)
	const controllers = useRef(new Set<AbortController>())
	const [downloads] = useState(() => createActivityDownloadScope())
	const [filters, setFilters] = useState<ActivityFilterForm>(
		EMPTY_ACTIVITY_FILTERS
	)
	const [page, setPage] = useState(1)
	const [selected, setSelected] = useState<SelectedActivityGeneration | null>(
		null
	)
	const [blocked, setBlocked] = useState<ActivityAccessFailure | null>(null)
	const [revalidationRequired, setRevalidationRequired] = useState(false)
	const [exportNotice, setExportNotice] = useState<ExportNotice | null>(null)
	const queryPrefix = useMemo(() => activityQueryKey(scope), [scope])
	const options = useMemo(
		() => ({
			expectedUserId: scope.userId,
			expectedWorkspaceId: scope.workspaceId,
		}),
		[scope]
	)
	const queryKey = useMemo(
		() => [...queryPrefix, 'list', filters, page, options],
		[queryPrefix, filters, page, options]
	)
	const query = useQuery({
		queryKey,
		queryFn: ({ signal }) =>
			cinatokenApi.activity({
				...options,
				...filters,
				page,
				page_size: 20,
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
			downloads.clear()
		}
	}, [downloads])
	const denyAccess = (failure: ActivityAccessFailure, error: unknown) => {
		setBlocked(failure)
		setRevalidationRequired(requiresSessionRevalidation(error))
		setSelected(null)
		setExportNotice(null)
		for (const controller of controllers.current) controller.abort()
		downloads.clear()
	}
	useEffect(
		() =>
			queryClient.getQueryCache().subscribe((event) => {
				if (
					event.type !== 'updated' ||
					!queryPrefix.every(
						(part, index) => event.query.queryKey[index] === part
					)
				)
					return
				if (
					event.action.type === 'success' &&
					queryClient.getQueryCache().find({ queryKey, exact: true }) ===
						event.query
				) {
					const data = event.query.state.data as ActivityData
					setPage((current) => Math.min(current, data.pagination.totalPages))
				}
				if (event.action.type !== 'error') return
				const failure = activityAccessFailure(event.query.state.error)
				if (!failure) return
				setBlocked(failure)
				setRevalidationRequired(
					requiresSessionRevalidation(event.query.state.error)
				)
				setSelected(null)
				setExportNotice(null)
				for (const controller of controllers.current) controller.abort()
				downloads.clear()
			}),
		[queryClient, queryPrefix, queryKey, downloads]
	)
	const exportCsv = useMutation({
		mutationKey: [...queryPrefix, 'export'],
		gcTime: 0,
		retry: false,
		// Download payloads stay in this promise only: no args, no Blob result in the mutation cache.
		mutationFn: async (): Promise<void> => {
			const controller = new AbortController()
			controllers.current.add(controller)
			try {
				const result = await cinatokenApi.exportActivityCsv({
					...options,
					...filters,
					signal: controller.signal,
				})
				if (!active.current || controller.signal.aborted) return
				downloads.download(result.blob, result.filename)
				setExportNotice({
					rowCount: result.rowCount,
					total: result.total,
					truncated: result.truncated,
				})
			} finally {
				controllers.current.delete(controller)
			}
		},
		onError: (error) => {
			if (active.current) {
				const failure = activityAccessFailure(error)
				if (failure) denyAccess(failure, error)
			}
		},
	})
	const accessFailure =
		blocked ||
		activityAccessFailure(query.error) ||
		activityAccessFailure(exportCsv.error)
	const applyFilters = (next: ActivityFilterForm) => {
		if (exportCsv.isPending || accessFailure) return
		setSelected(null)
		setExportNotice(null)
		exportCsv.reset()
		setPage(1)
		setFilters(next)
	}
	const retry = () => {
		setBlocked(null)
		setRevalidationRequired(false)
		setSelected(null)
		setExportNotice(null)
		exportCsv.reset()
		void query.refetch()
	}
	return {
		query,
		filters,
		page,
		setPage,
		selected,
		setSelected,
		exportCsv,
		exportNotice,
		accessFailure,
		applyFilters,
		retry,
		revalidationRequired:
			revalidationRequired ||
			requiresSessionRevalidation(query.error) ||
			requiresSessionRevalidation(exportCsv.error),
		openDetails: (row: ActivityLog) => {
			if (
				!query.isSuccess ||
				!query.data ||
				accessFailure ||
				!canOpenActivityGeneration(row)
			)
				return
			setSelected({
				id: row.id,
				chargedCost: row.chargedCost,
				billingCurrency: query.data.billingCurrency,
			})
		},
	}
}
