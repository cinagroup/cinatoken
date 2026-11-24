/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useState,
	useSyncExternalStore,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../../api'
import type { ProvidersApi } from '../../provider-api'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../../reliability/reliability-range'
import { analyticsQueryPrefix } from '../models/analytics-drilldowns'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../models/model-analytics-access'
import type {
	ModelAnalyticsRow,
	ModelProviderRow,
} from '../models/model-analytics-contracts'
import { useAnalyticsDrilldowns } from '../models/use-analytics-drilldowns'
import type { AdminProviderAnalyticsApi } from './provider-analytics-api'

export type ProviderAnalyticsProps = {
	directoryApi?: Pick<ProvidersApi, 'providerList'>
	directorySubject?: string
	api: AdminProviderAnalyticsApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
}
const denied = (error: unknown): boolean =>
	error instanceof CinaTokenApiError &&
	(error.status === 401 || error.status === 403)

export function useProviderAnalytics(props: ProviderAnalyticsProps) {
	const client = useQueryClient()
	const instanceKey = useId()
	const access = modelAnalyticsAccessRecovery(props.api)
	const accessKey = `providerAnalytics:${modelAnalyticsAccessKey(props.reconciliationKey)}`
	const revalidate = props.revalidate
	const [range, setRange] = useState<ReliabilityRange>({
		kind: 'calendar',
		preset: 'today',
	})
	const [anchor, setAnchor] = useState(() => new Date())
	const [tag, setTag] = useState('')
	const [retryVersion, setRetryVersion] = useState(0)
	const blockedSnapshot = useCallback(
		(domain: 'analytics' | 'display' | 'logs') =>
			access.getSnapshot(accessKey, domain),
		[access, accessKey]
	)
	const analyticsSnapshot = useCallback(
		() => blockedSnapshot('analytics'),
		[blockedSnapshot]
	)
	const displaySnapshot = useCallback(
		() => blockedSnapshot('display'),
		[blockedSnapshot]
	)
	const logsSnapshot = useCallback(
		() => blockedSnapshot('logs'),
		[blockedSnapshot]
	)
	const analyticsBlocked = useSyncExternalStore(
		access.subscribe,
		analyticsSnapshot,
		analyticsSnapshot
	)
	const displayBlocked = useSyncExternalStore(
		access.subscribe,
		displaySnapshot,
		displaySnapshot
	)
	const logsBlocked = useSyncExternalStore(
		access.subscribe,
		logsSnapshot,
		logsSnapshot
	)
	const prefix = useMemo(
		() =>
			analyticsQueryPrefix({
				scopeKey: props.scopeKey,
				reconciliationKey: props.reconciliationKey,
				api: props.api,
				instanceKey,
				domain: 'providerAnalytics',
			}),
		[props.scopeKey, props.reconciliationKey, props.api, instanceKey]
	)
	const displayQuery = useQuery({
		queryKey: [...prefix, 'display', retryVersion],
		queryFn: ({ signal }) => props.api.providerAnalyticsDisplay({ signal }),
		enabled: !displayBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const logsQuery = useQuery({
		queryKey: [...prefix, 'logsAccess', retryVersion],
		queryFn: ({ signal }) => props.api.providerAnalyticsLogsAccess({ signal }),
		enabled: !logsBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const display =
		!displayBlocked && !displayQuery.error ? displayQuery.data : undefined
	const effectiveRange = useMemo<ReliabilityRange>(
		() =>
			range.kind === 'calendar' && (displayBlocked || displayQuery.error)
				? { kind: 'rolling', preset: '1d' }
				: range,
		[range, displayBlocked, displayQuery.error]
	)
	const rangeParams = useMemo(
		() =>
			resolveReliabilityRange(
				effectiveRange,
				display?.timezone ?? null,
				anchor
			),
		[effectiveRange, display?.timezone, anchor]
	)
	const mainQuery = useQuery({
		queryKey: [...prefix, 'providers', rangeParams, tag, retryVersion],
		queryFn: ({ signal }) => {
			if (!rangeParams) throw new TypeError('Analytics range unavailable')
			return props.api.providerAnalytics(
				rangeParams.startUtc,
				rangeParams.endUtc,
				tag,
				{ signal }
			)
		},
		enabled: !analyticsBlocked && rangeParams !== null,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const main =
		!analyticsBlocked && !mainQuery.isFetching && !mainQuery.error
			? mainQuery.data
			: undefined
	const context = JSON.stringify([prefix, rangeParams, tag, retryVersion])
	const block = useCallback(
		(domain: 'analytics' | 'display' | 'logs') => {
			if (!access.block(accessKey, domain)) return
			const domains =
				domain === 'analytics'
					? ['providers', 'models']
					: domain === 'display'
						? ['display']
						: ['logsAccess']
			for (const item of domains) {
				const queryKey = [...prefix, item]
				void client.cancelQueries({ queryKey })
				client.removeQueries({ queryKey })
			}
			void revalidate().catch(() => undefined)
		},
		[access, accessKey, client, prefix, revalidate]
	)
	const detailPrefix = useMemo(() => [...prefix, 'models'], [prefix])
	const onDetailDenied = useCallback(() => block('analytics'), [block])
	const { details, toggleRow, collapseRows } = useAnalyticsDrilldowns<
		ModelProviderRow,
		ModelAnalyticsRow
	>({
		prefix: detailPrefix,
		context,
		enabled: !analyticsBlocked && Boolean(main && rangeParams),
		rowKey: (row) => row.provider_id,
		read: (row, signal) => {
			if (!rangeParams) throw new TypeError('Analytics drilldown unavailable')
			return props.api.providerModels(
				rangeParams.startUtc,
				rangeParams.endUtc,
				row.provider_id,
				tag,
				{ signal }
			)
		},
		onDenied: onDetailDenied,
	})
	useEffect(() => {
		if (denied(mainQuery.error)) block('analytics')
	}, [block, mainQuery.error])
	useEffect(() => {
		if (denied(displayQuery.error)) block('display')
	}, [block, displayQuery.error])
	useEffect(() => {
		if (denied(logsQuery.error)) block('logs')
	}, [block, logsQuery.error])
	function selectRange(next: ReliabilityRange): void {
		collapseRows()
		setRange(next)
		setAnchor(new Date())
	}
	function retry(): void {
		collapseRows()
		setAnchor(new Date())
		setRetryVersion((version) => version + 1)
		for (const domain of ['analytics', 'display', 'logs'] as const)
			access.settle(accessKey, domain)
	}
	return {
		range: effectiveRange,
		rangeParams,
		tag,
		setTag,
		selectRange,
		retry,
		toggleRow,
		collapseRows,
		details,
		mainQuery,
		main,
		displayQuery,
		display,
		logsQuery,
		analyticsBlocked,
		displayBlocked,
		logsBlocked,
	}
}
