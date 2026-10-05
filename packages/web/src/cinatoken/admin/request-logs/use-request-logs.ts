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
import { requestLogCatalogAccess } from './catalog-access'
import type { AdminRequestLogsApi } from './request-log-api'
import type {
	LogModelCatalog,
	LogProviderCatalog,
	LogRouteCatalog,
	RequestLogPage,
} from './request-log-contracts'
import type { RequestLogSearch } from './request-log-domain'

export type RequestLogsProps = {
	api: AdminRequestLogsApi
	scopeKey: string
	reconciliationKey: string
	revalidate: () => Promise<void>
	search: RequestLogSearch
	onSearch: (next: RequestLogSearch) => void
}
const denied = (error: unknown): boolean =>
	error instanceof CinaTokenApiError &&
	(error.status === 401 || error.status === 403)
type Display = Awaited<ReturnType<AdminRequestLogsApi['requestLogDisplay']>>
type Catalogs = {
	models: LogModelCatalog | null
	providers: LogProviderCatalog | null
	routes: LogRouteCatalog | null
}

export function useRequestLogs(props: RequestLogsProps) {
	const api = props.api
	const revalidate = props.revalidate
	const access = modelAnalyticsAccessRecovery(api)
	const principalKey = modelAnalyticsAccessKey(props.reconciliationKey)
	const accessKey = `requestLogs:${principalKey}`
	const catalogAccess = requestLogCatalogAccess(api)
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
	const [catalogState, setCatalogState] = useState<{
		key: string
		value: Catalogs
	} | null>(null)
	const [pageState, setPageState] = useState<{
		key: string
		value: RequestLogPage
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
	const invalidateLogs = useCallback(() => block('logs'), [block])

	const displayKey = JSON.stringify([props.scopeKey, version])
	useEffect(() => {
		if (displayBlocked) return
		const controller = new AbortController()
		let alive = true
		void api.requestLogDisplay({ signal: controller.signal }).then(
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

	const catalogKey = JSON.stringify([props.scopeKey, version])
	useEffect(() => {
		const controller = new AbortController()
		let alive = true
		async function load<T>(
			domain: 'models' | 'providers' | 'routes',
			request: () => Promise<T>
		): Promise<T | null> {
			if (!catalogAccess.canRead(principalKey, domain)) return null
			try {
				return await request()
			} catch (failure) {
				if (alive && denied(failure)) catalogAccess.block(principalKey, domain)
				return null
			}
		}
		void Promise.all([
			load('models', () => api.requestLogModels({ signal: controller.signal })),
			load('providers', () =>
				api.requestLogProviders({ signal: controller.signal })
			),
			load('routes', () => api.requestLogRoutes({ signal: controller.signal })),
		]).then(([models, providers, routes]) => {
			if (!alive) return
			setCatalogState({ key: catalogKey, value: { models, providers, routes } })
		})
		return () => {
			alive = false
			controller.abort()
		}
	}, [api, catalogAccess, catalogKey, principalKey])
	const catalogs = catalogState?.key === catalogKey ? catalogState.value : null

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
		void api.requestLogs(effectiveSearch, { signal: controller.signal }).then(
			(value) => {
				if (alive) setPageState({ key: requestKey, value })
			},
			(failure: unknown) => {
				if (!alive) return
				setErrorState({ key: requestKey, value: failure })
				if (denied(failure)) block('logs')
			}
		)
		return () => {
			alive = false
			controller.abort()
		}
	}, [api, requestKey, logsBlocked, block, effectiveSearch])
	const page =
		!logsBlocked && pageState?.key === requestKey ? pageState.value : null
	const error = errorState?.key === requestKey ? errorState.value : null
	function retry(): void {
		access.settle(accessKey, 'logs')
		access.settle(accessKey, 'display')
		catalogAccess.settle(principalKey)
		setAnchor(new Date())
		setVersion((value) => value + 1)
	}
	return {
		page,
		loading: !page && !error && !logsBlocked,
		error,
		logsBlocked,
		invalidateLogs,
		display,
		displaySettled,
		timezone,
		currency,
		effectiveSearch,
		models: catalogs?.models ?? null,
		providers: catalogs?.providers ?? null,
		routes: catalogs?.routes ?? null,
		catalogSettled: catalogs !== null,
		retry,
	}
}
