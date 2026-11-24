/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { queryOptions } from '@tanstack/react-query'
import { CinaTokenApiError } from '../../../api'

export type AnalyticsDetailState<D> = {
	rows: D[] | undefined
	loading: boolean
	error: boolean
	retry: () => void
}
export type AnalyticsDetailRead<D> = {
	rows: D[] | undefined
	error: boolean
	denied: boolean
}
export type AnalyticsDrilldownEntry<R> = { row: R; generation: number }
export type AnalyticsDrilldownSelection<R> = {
	context: string
	nextGeneration: number
	rows: ReadonlyMap<string, AnalyticsDrilldownEntry<R>>
}

export function modelAnalyticsRowKey(row: {
	model_id: string
	route_group: string
}): string {
	return JSON.stringify([row.model_id, row.route_group])
}

const apiIds = new WeakMap<object, number>()
let nextApiId = 0
export function analyticsQueryPrefix(input: {
	scopeKey: string
	reconciliationKey: string
	api: object
	instanceKey: string
	domain: 'modelAnalytics' | 'providerAnalytics' | 'userAnalytics'
}) {
	let apiId = apiIds.get(input.api)
	if (apiId === undefined) {
		apiId = ++nextApiId
		apiIds.set(input.api, apiId)
	}
	return [
		'cinatoken',
		'admin',
		input.scopeKey,
		input.domain,
		input.reconciliationKey,
		apiId,
		input.instanceKey,
	] as const
}

export function emptyAnalyticsDrilldowns<R>(
	context: string,
	nextGeneration = 0
): AnalyticsDrilldownSelection<R> {
	return { context, nextGeneration, rows: new Map() }
}

export function toggleAnalyticsDrilldown<R>(
	selection: AnalyticsDrilldownSelection<R>,
	context: string,
	key: string,
	row: R
): AnalyticsDrilldownSelection<R> {
	const current =
		selection.context === context
			? selection
			: emptyAnalyticsDrilldowns<R>(context, selection.nextGeneration)
	const rows = new Map(current.rows)
	if (rows.delete(key)) return { ...current, rows }
	const generation = current.nextGeneration + 1
	rows.set(key, { row, generation })
	return { context, rows, nextGeneration: generation }
}

/** A callback from a closed/replaced row cannot retry a newer selection. */
export function retryAnalyticsDrilldown<R>(
	selection: AnalyticsDrilldownSelection<R>,
	context: string,
	key: string,
	generation: number
): AnalyticsDrilldownSelection<R> {
	const entry = selection.rows.get(key)
	if (selection.context !== context || entry?.generation !== generation)
		return selection
	const nextGeneration = selection.nextGeneration + 1
	const rows = new Map(selection.rows)
	rows.set(key, { row: entry.row, generation: nextGeneration })
	return { ...selection, rows, nextGeneration }
}

export function analyticsDrilldownQueryOptions<D>(input: {
	prefix: readonly unknown[]
	context: string
	key: string
	generation: number
	read: (signal: AbortSignal) => Promise<D[]>
}) {
	return queryOptions({
		queryKey: [
			...input.prefix,
			input.context,
			input.key,
			input.generation,
		] as const,
		queryFn: async ({ signal }): Promise<AnalyticsDetailRead<D>> => {
			signal.throwIfAborted()
			try {
				const rows = await input.read(signal)
				signal.throwIfAborted()
				return { rows, error: false, denied: false }
			} catch (error) {
				signal.throwIfAborted()
				return {
					rows: undefined,
					error: true,
					denied:
						error instanceof CinaTokenApiError &&
						(error.status === 401 || error.status === 403),
				}
			}
		},
		retry: false,
		gcTime: 0,
		staleTime: Infinity,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	})
}

export function analyticsDetailState<D>(input: {
	data?: AnalyticsDetailRead<D>
	isFetching: boolean
	isPending: boolean
	error: unknown
	denied: boolean
	retry: () => void
}): AnalyticsDetailState<D> {
	if (input.denied)
		return { rows: undefined, loading: false, error: true, retry: input.retry }
	if (input.isFetching || input.isPending)
		return { rows: undefined, loading: true, error: false, retry: input.retry }
	const error = Boolean(input.error) || !input.data || input.data.error
	return {
		rows: error ? undefined : input.data?.rows,
		loading: false,
		error,
		retry: input.retry,
	}
}
