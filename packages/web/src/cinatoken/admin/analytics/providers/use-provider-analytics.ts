/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../../api'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../../reliability/reliability-range'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../models/model-analytics-access'
import type { ModelProviderRow } from '../models/model-analytics-contracts'
import type { AdminProviderAnalyticsApi } from './provider-analytics-api'

export type ProviderAnalyticsProps = {
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
	const access = modelAnalyticsAccessRecovery(props.api)
	const accessKey = `providerAnalytics:${modelAnalyticsAccessKey(props.reconciliationKey)}`
	const revalidate = props.revalidate
	const [range, setRange] = useState<ReliabilityRange>({
		kind: 'calendar',
		preset: 'today',
	})
	const [anchor, setAnchor] = useState(() => new Date())
	const [tag, setTag] = useState('')
	const [expanded, setExpanded] = useState<{
		providerId: string
		context: string
	} | null>(null)
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
		() => ['cinatoken', 'admin', props.scopeKey, 'providerAnalytics'] as const,
		[props.scopeKey]
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
	const context = JSON.stringify([props.scopeKey, rangeParams, tag])
	const active = expanded?.context === context ? expanded : null
	const selectedRow: ModelProviderRow | undefined = main?.rows.find(
		(row) => row.provider_id === active?.providerId
	)
	const detailQuery = useQuery({
		queryKey: [
			...prefix,
			'models',
			context,
			active?.providerId,
			rangeParams,
			selectedRow,
			tag,
			retryVersion,
		],
		queryFn: ({ signal }) => {
			if (!rangeParams || !selectedRow)
				throw new TypeError('Analytics drilldown unavailable')
			return props.api.providerModels(
				rangeParams.startUtc,
				rangeParams.endUtc,
				selectedRow.provider_id,
				tag,
				{ signal }
			)
		},
		enabled: !analyticsBlocked && Boolean(main && selectedRow && rangeParams),
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const detail =
		!analyticsBlocked && !detailQuery.isFetching && !detailQuery.error
			? detailQuery.data
			: undefined
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
	useEffect(() => {
		if (denied(mainQuery.error) || denied(detailQuery.error)) block('analytics')
	}, [block, mainQuery.error, detailQuery.error])
	useEffect(() => {
		if (denied(displayQuery.error)) block('display')
	}, [block, displayQuery.error])
	useEffect(() => {
		if (denied(logsQuery.error)) block('logs')
	}, [block, logsQuery.error])
	function selectRange(next: ReliabilityRange): void {
		setRange(next)
		setAnchor(new Date())
	}
	function retry(): void {
		setAnchor(new Date())
		setRetryVersion((version) => version + 1)
		for (const domain of ['analytics', 'display', 'logs'] as const)
			access.settle(accessKey, domain)
	}
	function toggleRow(row: ModelProviderRow): void {
		setExpanded(
			active?.providerId === row.provider_id
				? null
				: { providerId: row.provider_id, context }
		)
	}
	return {
		range: effectiveRange,
		rangeParams,
		tag,
		setTag,
		selectRange,
		retry,
		toggleRow,
		mainQuery,
		main,
		detailQuery,
		detail,
		displayQuery,
		display,
		logsQuery,
		analyticsBlocked,
		displayBlocked,
		logsBlocked,
		active,
	}
}
