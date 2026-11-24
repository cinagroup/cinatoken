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
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../../reliability/reliability-range'
import { analyticsQueryPrefix } from '../models/analytics-drilldowns'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../models/model-analytics-access'
import { useUserAnalyticsDrilldowns } from './use-user-analytics-drilldowns'
import type { AdminUserAnalyticsApi } from './user-analytics-api'

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
	const instanceKey = useId()
	const access = modelAnalyticsAccessRecovery(props.api)
	const accessKey = `userAnalytics:${modelAnalyticsAccessKey(props.reconciliationKey)}`
	const revalidate = props.revalidate
	const [range, setRange] = useState<ReliabilityRange>({
		kind: 'calendar',
		preset: 'today',
	})
	const [anchor, setAnchor] = useState(() => new Date())
	const [email, setEmail] = useState('')
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
				domain: 'userAnalytics',
			}),
		[props.scopeKey, props.reconciliationKey, props.api, instanceKey]
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
	const block = useCallback(
		(domain: 'analytics' | 'display' | 'logs') => {
			if (!access.block(accessKey, domain)) return
			let domains = ['logsAccess']
			if (domain === 'analytics')
				domains = ['users', 'models', 'keys', 'keyModels']
			else if (domain === 'display') domains = ['display']
			for (const item of domains) {
				const queryKey = [...prefix, item]
				void client.cancelQueries({ queryKey })
				client.removeQueries({ queryKey })
			}
			void revalidate().catch(() => undefined)
		},
		[access, accessKey, client, prefix, revalidate]
	)
	const context = JSON.stringify([prefix, rangeParams, email, retryVersion])
	const onDenied = useCallback(() => block('analytics'), [block])
	const drilldowns = useUserAnalyticsDrilldowns({
		prefix,
		context,
		enabled: !analyticsBlocked && Boolean(main && rangeParams),
		readModels: (row, signal) => {
			if (!rangeParams) throw new TypeError('Analytics range unavailable')
			return props.api.userModels(
				rangeParams.startUtc,
				rangeParams.endUtc,
				row.user_email,
				{ signal }
			)
		},
		readKeys: (row, signal) => {
			if (!rangeParams || !row.user_id)
				throw new TypeError('Exact user unavailable')
			return props.api.userKeys(
				rangeParams.startUtc,
				rangeParams.endUtc,
				row.user_id,
				{ signal }
			)
		},
		readKeyModels: (row, id, signal) => {
			if (!rangeParams || !row.user_id)
				throw new TypeError('Exact user unavailable')
			return props.api.userKeyModels(
				rangeParams.startUtc,
				rangeParams.endUtc,
				row.user_id,
				id,
				{ signal }
			)
		},
		onDenied,
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
	function selectEmail(next: string): void {
		if (next !== email) drilldowns.collapseRows()
		setEmail(next)
	}
	function selectRange(next: ReliabilityRange): void {
		drilldowns.collapseRows()
		setRange(next)
		setAnchor(new Date())
	}
	function retry(): void {
		drilldowns.collapseRows()
		setAnchor(new Date())
		setRetryVersion((version) => version + 1)
		for (const domain of ['analytics', 'display', 'logs'] as const)
			access.settle(accessKey, domain)
	}
	return {
		range: effectiveRange,
		rangeParams,
		email,
		setEmail: selectEmail,
		selectRange,
		retry,
		toggleRow: drilldowns.toggleRow,
		collapseRows: drilldowns.collapseRows,
		details: drilldowns.details,
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
