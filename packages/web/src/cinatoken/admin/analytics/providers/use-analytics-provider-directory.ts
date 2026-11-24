/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useId, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
	AnalyticsProviderDirectoryRechecks,
	analyticsProviderDirectoryQueryOptions,
	visibleAnalyticsProviderDirectory,
	type AnalyticsProviderDirectory,
	type AnalyticsProviderDirectoryInput,
} from './analytics-provider-directory'

const automaticRechecks = new AnalyticsProviderDirectoryRechecks()

export function useAnalyticsProviderDirectory(
	props: AnalyticsProviderDirectoryInput & { revalidate: () => Promise<void> }
): {
	directory: AnalyticsProviderDirectory
	retry: () => void
	isFetching: boolean
} {
	const client = useQueryClient()
	const instanceKey = useId()
	const options = useMemo(
		() =>
			analyticsProviderDirectoryQueryOptions(
				{
					api: props.api,
					subject: props.subject,
					scopeKey: props.scopeKey,
					reconciliationKey: props.reconciliationKey,
					enabled: props.enabled,
				},
				instanceKey
			),
		[
			props.api,
			props.subject,
			props.scopeKey,
			props.reconciliationKey,
			props.enabled,
			instanceKey,
		]
	)
	const query = useQuery(options)
	const refetch = query.refetch
	const revalidate = props.revalidate
	useEffect(() => {
		// StrictMode can remove this observer's query between effect setups.
		// Restore it without cancelling a request already started by useQuery.
		const cached = client.getQueryState(options.queryKey)
		if (
			options.enabled &&
			(!cached ||
				(cached.status === 'pending' && cached.fetchStatus === 'idle'))
		)
			void refetch({ cancelRefetch: false }).catch(() => undefined)
		return () => {
			void client.cancelQueries({ queryKey: options.queryKey, exact: true })
			client.removeQueries({ queryKey: options.queryKey, exact: true })
		}
	}, [client, options.queryKey, options.enabled, refetch])
	useEffect(() => {
		if (
			!options.enabled ||
			!props.subject ||
			query.isFetching ||
			!query.data?.identityInvalid
		)
			return
		if (automaticRechecks.reserve(props.reconciliationKey, props.subject))
			void revalidate().catch(() => undefined)
	}, [
		options.enabled,
		props.subject,
		props.reconciliationKey,
		query.isFetching,
		query.data,
		revalidate,
	])
	const retry = useCallback(() => {
		if (options.enabled)
			void refetch({ cancelRefetch: true }).catch(() => undefined)
	}, [options.enabled, refetch])
	return {
		directory: visibleAnalyticsProviderDirectory({
			enabled: options.enabled,
			isFetching: query.isFetching,
			isPending: query.isPending,
			error: query.error,
			data: query.data,
		}),
		retry,
		isFetching: options.enabled && query.isFetching,
	}
}
