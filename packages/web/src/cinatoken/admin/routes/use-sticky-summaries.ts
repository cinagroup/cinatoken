/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { RoutePoolView } from './route-domain'
import type { RoutesRequestOptions } from './routes-api'
import {
	readStickyRefreshInterval,
	writeStickyRefreshInterval,
	subscribeStickyRefreshInterval,
} from './sticky-refresh-preference'
import { createStickySummaryScheduler } from './sticky-summary-concurrency'
import type { RoutesUiApi } from './use-routes-manager'

export type { StickyRefreshInterval } from './sticky-refresh-preference'

export function useStickySummaries(props: {
	api: RoutesUiApi
	prefix: readonly unknown[]
	pools: RoutePoolView[]
	enabled: boolean
	readOptions: (signal: AbortSignal) => RoutesRequestOptions
}) {
	const client = useQueryClient()
	const interval = useSyncExternalStore(
		subscribeStickyRefreshInterval,
		readStickyRefreshInterval,
		() => 0
	)
	const [visible, setVisible] = useState(
		() =>
			typeof document === 'undefined' || document.visibilityState !== 'hidden'
	)
	const [schedule] = useState(() => createStickySummaryScheduler(6))
	const ids = [
		...new Set(
			props.pools
				.map((pool) => pool.id)
				.filter((id): id is string => Boolean(id))
		),
	]
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== 'hidden')
		document.addEventListener('visibilitychange', update)
		return () => document.removeEventListener('visibilitychange', update)
	}, [])
	useEffect(() => {
		if (!visible || !props.enabled)
			void client.cancelQueries({
				queryKey: [...props.prefix, 'sticky', 'summary'],
			})
	}, [client, visible, props.enabled, props.prefix])
	const queries = useQueries({
		queries: ids.map((id) => ({
			queryKey: [...props.prefix, 'sticky', 'summary', id],
			queryFn: ({ signal }: { signal: AbortSignal }) =>
				schedule(signal, () =>
					props.api.stickyBindingsSummary(id, props.readOptions(signal))
				),
			enabled: props.enabled && visible,
			staleTime: 30000,
			refetchOnWindowFocus: false,
			refetchInterval: interval || false,
			refetchIntervalInBackground: false,
			retry: false,
		})),
	})
	return {
		interval,
		setInterval: writeStickyRefreshInterval,
		visible,
		fetching: queries.some((query) => query.isFetching),
		summaries: new Map(
			ids.map((id, index) => [
				id,
				props.enabled && !queries[index]!.error && !queries[index]!.isFetching
					? queries[index]!.data
					: null,
			])
		),
		refresh: () => Promise.all(queries.map((query) => query.refetch())),
	}
}
