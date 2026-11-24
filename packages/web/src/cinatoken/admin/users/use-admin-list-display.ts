/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useId, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../api'
import {
	listDisplayQueryKey,
	markListDisplayUnauthorized,
} from './list-display-recovery'
import type { AdminUsersApi } from './users-api'

export function useAdminListDisplay(props: {
	api: Pick<AdminUsersApi, 'userDisplay'>
	scopeKey: string
	reconciliationKey: string
	domain: 'users' | 'gateway-keys' | 'access-keys'
	enabled: boolean
	revalidate: () => Promise<void>
}) {
	const instance = useId()
	const key = useMemo(
		() =>
			listDisplayQueryKey(
				props.scopeKey,
				props.reconciliationKey,
				props.domain,
				props.api,
				instance
			),
		[props.scopeKey, props.reconciliationKey, props.domain, props.api, instance]
	)
	const query = useQuery({
		queryKey: key,
		queryFn: ({ signal }) => props.api.userDisplay({ signal }),
		enabled: props.enabled,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const error = query.error
	const { api, reconciliationKey, revalidate, enabled } = props
	useEffect(() => {
		if (
			!enabled ||
			!(error instanceof CinaTokenApiError) ||
			error.status !== 401
		)
			return
		if (markListDisplayUnauthorized(api, reconciliationKey))
			void revalidate().catch(() => undefined)
	}, [api, reconciliationKey, revalidate, enabled, error])
	// Refetches must not present a previously verified setting as current.
	const display =
		props.enabled && !query.isFetching && !query.error
			? (query.data ?? null)
			: null
	return { query, display }
}
