/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	useSyncExternalStore,
} from 'react'
import { CinaTokenApiError } from '../../api'
import {
	modelAnalyticsAccessKey,
	modelAnalyticsAccessRecovery,
} from '../analytics/models/model-analytics-access'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'
import type { AdminAuditLogsApi } from './audit-log-api'
import type { AuditFilterOptions, AuditLogPage } from './audit-log-contracts'
import type { AuditLogSearch } from './audit-log-domain'

export type AuditLogsProps = {
	api: AdminAuditLogsApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
	search: AuditLogSearch
	onSearch: (next: AuditLogSearch) => void
}
type Display = Awaited<ReturnType<AdminAuditLogsApi['auditLogDisplay']>>
const denied = (failure: unknown): boolean =>
	failure instanceof CinaTokenApiError &&
	(failure.status === 401 || failure.status === 403)

export function useAuditLogs(props: AuditLogsProps) {
	const api = props.api
	const revalidate = props.revalidate
	const access = modelAnalyticsAccessRecovery(api)
	const principalKey = modelAnalyticsAccessKey(props.reconciliationKey)
	const accessKey = `auditLogs:${principalKey}`
	const logsSnapshot = useCallback(
		() => access.getSnapshot(accessKey, 'logs'),
		[access, accessKey]
	)
	const displaySnapshot = useCallback(
		() => access.getSnapshot(accessKey, 'display'),
		[access, accessKey]
	)
	const logsBlocked = useSyncExternalStore(
		access.subscribe,
		logsSnapshot,
		logsSnapshot
	)
	const displayBlocked = useSyncExternalStore(
		access.subscribe,
		displaySnapshot,
		displaySnapshot
	)
	const [version, setVersion] = useState(0)
	const [anchor, setAnchor] = useState(() => new Date())
	const [displayState, setDisplayState] = useState<{
		key: string
		value: Display | null
	} | null>(null)
	const [optionsState, setOptionsState] = useState<{
		key: string
		value: AuditFilterOptions | null
	} | null>(null)
	const [pageState, setPageState] = useState<{
		key: string
		value: AuditLogPage
	} | null>(null)
	const [errorState, setErrorState] = useState<{
		key: string
		value: unknown
	} | null>(null)
	const block = useCallback(
		(domain: 'logs' | 'display') => {
			if (access.block(accessKey, domain))
				void revalidate().catch(() => undefined)
		},
		[access, accessKey, revalidate]
	)

	const displayKey = JSON.stringify([props.scopeKey, version])
	useEffect(() => {
		if (displayBlocked) return
		const controller = new AbortController()
		let alive = true
		void api.auditLogDisplay({ signal: controller.signal }).then(
			(value) => {
				if (alive) setDisplayState({ key: displayKey, value })
			},
			(failure) => {
				if (!alive) return
				setDisplayState({ key: displayKey, value: null })
				if (denied(failure)) block('display')
			}
		)
		return () => {
			alive = false
			controller.abort()
		}
	}, [api, displayBlocked, displayKey, block])
	const display =
		!displayBlocked && displayState?.key === displayKey
			? displayState.value
			: null
	const displaySettled = displayBlocked || displayState?.key === displayKey

	const optionsKey = JSON.stringify([props.scopeKey, version])
	useEffect(() => {
		if (logsBlocked) return
		const controller = new AbortController()
		let alive = true
		void api.auditLogFilterOptions({ signal: controller.signal }).then(
			(value) => {
				if (alive) setOptionsState({ key: optionsKey, value })
			},
			(failure) => {
				if (!alive) return
				setOptionsState({ key: optionsKey, value: null })
				if (denied(failure)) block('logs')
			}
		)
		return () => {
			alive = false
			controller.abort()
		}
	}, [api, block, logsBlocked, optionsKey])

	const timezone =
		display && display.timezoneSource !== 'invalid' ? display.timezone : null
	const currency = display?.currency ?? null
	const effectiveSearch = useMemo(() => {
		if (
			props.search.start_date !== undefined ||
			props.search.end_date !== undefined
		)
			return props.search
		if (!displaySettled) return null
		const range: ReliabilityRange = timezone
			? { kind: 'calendar', preset: 'today' }
			: { kind: 'rolling', preset: '1d' }
		const resolved = resolveReliabilityRange(range, timezone, anchor)
		return resolved
			? {
					...props.search,
					start_date: resolved.startUtc,
					end_date: resolved.endUtc,
				}
			: null
	}, [props.search, displaySettled, timezone, anchor])
	const requestKey = JSON.stringify([props.scopeKey, effectiveSearch, version])
	useEffect(() => {
		if (logsBlocked || !effectiveSearch) return
		const controller = new AbortController()
		let alive = true
		void api.auditLogs(effectiveSearch, { signal: controller.signal }).then(
			(value) => {
				if (alive) setPageState({ key: requestKey, value })
			},
			(failure) => {
				if (!alive) return
				setErrorState({ key: requestKey, value: failure })
				if (denied(failure)) block('logs')
			}
		)
		return () => {
			alive = false
			controller.abort()
		}
	}, [api, block, effectiveSearch, logsBlocked, requestKey])
	const page =
		!logsBlocked && pageState?.key === requestKey ? pageState.value : null
	const error = errorState?.key === requestKey ? errorState.value : null
	function retry(): void {
		access.settle(accessKey, 'logs')
		access.settle(accessKey, 'display')
		setAnchor(new Date())
		setVersion((value) => value + 1)
	}
	return {
		page,
		loading: !page && !error && !logsBlocked,
		error,
		logsBlocked,
		displaySettled,
		timezone,
		currency,
		effectiveSearch,
		reasonCodes:
			optionsState?.key === optionsKey
				? (optionsState.value?.reasonCodes ?? [])
				: [],
		retry,
		denyLogs: () => block('logs'),
	}
}
