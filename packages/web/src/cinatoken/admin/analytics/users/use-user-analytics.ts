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
import type { AdminUserAnalyticsApi } from './user-analytics-api'
import type { UserAnalyticsRow } from './user-analytics-contracts'

export type UserAnalyticsProps = {
	api: AdminUserAnalyticsApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
}
const denied = (error: unknown): boolean =>
	error instanceof CinaTokenApiError &&
	(error.status === 401 || error.status === 403)

export function useUserAnalytics(props: UserAnalyticsProps) {
	const client = useQueryClient()
	const access = modelAnalyticsAccessRecovery(props.api)
	const accessKey = `userAnalytics:${modelAnalyticsAccessKey(props.reconciliationKey)}`
	const revalidate = props.revalidate
	const [range, setRange] = useState<ReliabilityRange>({
		kind: 'calendar',
		preset: 'today',
	})
	const [anchor, setAnchor] = useState(() => new Date())
	const [email, setEmail] = useState('')
	const [expanded, setExpanded] = useState<{
		email: string
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
		() => ['cinatoken', 'admin', props.scopeKey, 'userAnalytics'] as const,
		[props.scopeKey]
	)
	const displayQuery = useQuery({
		queryKey: [...prefix, 'display', retryVersion],
		queryFn: ({ signal }) => props.api.userAnalyticsDisplay({ signal }),
		enabled: !displayBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const logsQuery = useQuery({
		queryKey: [...prefix, 'logsAccess', retryVersion],
		queryFn: ({ signal }) => props.api.userAnalyticsLogsAccess({ signal }),
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
		queryKey: [...prefix, 'users', rangeParams, email, retryVersion],
		queryFn: ({ signal }) => {
			if (!rangeParams) throw new TypeError('Analytics range unavailable')
			return props.api.userAnalytics(
				rangeParams.startUtc,
				rangeParams.endUtc,
				email,
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
	const context = JSON.stringify([props.scopeKey, rangeParams, email])
	const active = expanded?.context === context ? expanded : null
	const selectedRow: UserAnalyticsRow | undefined = main?.find(
		(row) => row.user_email === active?.email
	)
	const detailQuery = useQuery({
		queryKey: [
			...prefix,
			'models',
			context,
			active?.email,
			rangeParams,
			selectedRow,
			retryVersion,
		],
		queryFn: ({ signal }) => {
			if (!rangeParams || !selectedRow)
				throw new TypeError('Analytics drilldown unavailable')
			return props.api.userModels(
				rangeParams.startUtc,
				rangeParams.endUtc,
				selectedRow.user_email,
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
					? ['users', 'models']
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
	function toggleRow(row: UserAnalyticsRow): void {
		setExpanded(
			active?.email === row.user_email
				? null
				: { email: row.user_email, context }
		)
	}
	return {
		range: effectiveRange,
		rangeParams,
		email,
		setEmail,
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
