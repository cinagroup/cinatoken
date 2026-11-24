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
import { CinaTokenApiError } from '../../api'
import type { AdminModelAnalyticsApi } from '../analytics/models/model-analytics-api'
import type { ProvidersApi } from '../provider-api'
import {
	reliabilityAccessIdentityKey,
	reliabilityAccessRecovery,
} from './reliability-access-recovery'
import type { AdminReliabilityApi } from './reliability-api'
import { reliabilityQueryPrefix } from './reliability-domain'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from './reliability-range'

export type AdminReliabilityProps = {
	api: AdminReliabilityApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
	directoryApi?: Pick<ProvidersApi, 'providerList'>
	subject?: string
	logsApi?: Pick<AdminModelAnalyticsApi, 'modelAnalyticsLogsAccess'>
}

function isDenied(error: unknown): boolean {
	return (
		error instanceof CinaTokenApiError &&
		(error.status === 401 || error.status === 403)
	)
}

export function useAdminReliability(props: AdminReliabilityProps) {
	const client = useQueryClient()
	const instance = useId()
	const access = reliabilityAccessRecovery(props.api)
	const accessKey = reliabilityAccessIdentityKey(props.reconciliationKey)
	const revalidate = props.revalidate
	const [range, setRange] = useState<ReliabilityRange>({
		kind: 'calendar',
		preset: 'today',
	})
	const [anchor, setAnchor] = useState(() => new Date())
	const [retryVersion, setRetryVersion] = useState(0)
	const analyticsSnapshot = useCallback(
		() => access.getSnapshot(accessKey, 'analytics'),
		[access, accessKey]
	)
	const displaySnapshot = useCallback(
		() => access.getSnapshot(accessKey, 'display'),
		[access, accessKey]
	)
	const logsSnapshot = useCallback(
		() => access.getSnapshot(accessKey, 'logs'),
		[access, accessKey]
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
			reliabilityQueryPrefix(
				props.scopeKey,
				props.reconciliationKey,
				props.api,
				instance
			),
		[props.scopeKey, props.reconciliationKey, props.api, instance]
	)
	const analyticsKey = useMemo(
		() => [...prefix, 'analytics'] as const,
		[prefix]
	)
	const displayKey = useMemo(() => [...prefix, 'display'] as const, [prefix])
	const logsKey = useMemo(
		() =>
			[
				...reliabilityQueryPrefix(
					props.scopeKey,
					props.reconciliationKey,
					props.logsApi ?? props.api,
					instance
				),
				'logs',
			] as const,
		[
			props.scopeKey,
			props.reconciliationKey,
			props.logsApi,
			props.api,
			instance,
		]
	)
	const logsQuery = useQuery({
		queryKey: [...logsKey, retryVersion],
		queryFn: ({ signal }) =>
			props.logsApi?.modelAnalyticsLogsAccess({ signal }) ?? false,
		enabled: Boolean(props.logsApi) && !logsBlocked && !analyticsBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const displayQuery = useQuery({
		queryKey: [...displayKey, retryVersion],
		queryFn: ({ signal }) => props.api.display({ signal }),
		enabled: !displayBlocked,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	const display =
		!displayBlocked && !displayQuery.error ? displayQuery.data : undefined
	const timezone = display?.timezone ?? null
	const effectiveRange = useMemo<ReliabilityRange>(() => {
		if (range.kind === 'calendar' && (displayBlocked || displayQuery.error))
			return { kind: 'rolling', preset: '1d' }
		return range
	}, [range, displayBlocked, displayQuery.error])
	const rangeParams = useMemo(
		() => resolveReliabilityRange(effectiveRange, timezone, anchor),
		[effectiveRange, timezone, anchor]
	)
	const analyticsQuery = useQuery({
		queryKey: [...analyticsKey, rangeParams, retryVersion],
		queryFn: ({ signal }) => {
			if (!rangeParams) throw new TypeError('Reliability range unavailable')
			return props.api.reliability(rangeParams.startUtc, rangeParams.endUtc, {
				signal,
			})
		},
		enabled: !analyticsBlocked && rangeParams !== null,
		retry: false,
		refetchOnWindowFocus: false,
		gcTime: 0,
	})
	useEffect(() => {
		if (!isDenied(analyticsQuery.error)) return
		if (!access.block(accessKey, 'analytics')) return
		void client.cancelQueries({ queryKey: analyticsKey })
		client.removeQueries({ queryKey: analyticsKey })
		void revalidate().catch(() => undefined)
	}, [
		access,
		accessKey,
		analyticsKey,
		analyticsQuery.error,
		client,
		revalidate,
	])
	useEffect(() => {
		if (!isDenied(displayQuery.error)) return
		if (!access.block(accessKey, 'display')) return
		void client.cancelQueries({ queryKey: displayKey })
		client.removeQueries({ queryKey: displayKey })
		void revalidate().catch(() => undefined)
	}, [access, accessKey, client, displayKey, displayQuery.error, revalidate])
	useEffect(() => {
		if (!isDenied(logsQuery.error) || !access.block(accessKey, 'logs')) return
		void client.cancelQueries({ queryKey: logsKey })
		client.removeQueries({ queryKey: logsKey })
		void revalidate().catch(() => undefined)
	}, [access, accessKey, client, logsKey, logsQuery.error, revalidate])
	function selectRange(next: ReliabilityRange): void {
		setRange(next)
		setAnchor(new Date())
	}

	function retry(): void {
		setAnchor(new Date())
		setRetryVersion((version) => version + 1)
		access.settle(accessKey, 'analytics')
		access.settle(accessKey, 'display')
		access.settle(accessKey, 'logs')
	}

	const snapshot =
		!analyticsBlocked && !analyticsQuery.isFetching && !analyticsQuery.error
			? analyticsQuery.data
			: undefined
	return {
		range: effectiveRange,
		selectRange,
		rangeParams,
		analyticsQuery,
		logsQuery,
		logsAllowed:
			!analyticsBlocked &&
			!logsBlocked &&
			!logsQuery.error &&
			!logsQuery.isFetching &&
			logsQuery.data === true,
		displayQuery,
		snapshot,
		display,
		analyticsBlocked,
		displayBlocked,
		retry,
	}
}
