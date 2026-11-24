/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
	analyticsDetailState,
	analyticsDrilldownQueryOptions,
	emptyAnalyticsDrilldowns,
	retryAnalyticsDrilldown,
	toggleAnalyticsDrilldown,
	type AnalyticsDetailState,
} from './analytics-drilldowns'

export function useAnalyticsDrilldowns<R, D>(props: {
	prefix: readonly unknown[]
	context: string
	enabled: boolean
	rowKey: (row: R) => string
	read: (row: R, signal: AbortSignal) => Promise<D[]>
	onDenied: () => void
}): {
	details: ReadonlyMap<string, AnalyticsDetailState<D>>
	toggleRow: (row: R) => void
	collapseRows: () => void
} {
	const client = useQueryClient()
	const [selection, setSelection] = useState(() =>
		emptyAnalyticsDrilldowns<R>(props.context)
	)
	const valid = selection.context === props.context && props.enabled
	if (
		selection.context !== props.context ||
		(!props.enabled && selection.rows.size)
	)
		setSelection(
			emptyAnalyticsDrilldowns(props.context, selection.nextGeneration)
		)
	const entries = useMemo(
		() => (valid ? [...selection.rows.entries()] : []),
		[valid, selection.rows]
	)
	const queries = entries.map(([key, entry]) =>
		analyticsDrilldownQueryOptions({
			prefix: props.prefix,
			context: props.context,
			key,
			generation: entry.generation,
			read: (signal) => props.read(entry.row, signal),
		})
	)
	// useQueries owns observer unsubscription. Reading its signal makes removal
	// cancel only the removed row; StrictMode can resubscribe a pending query.
	const results = useQueries({ queries })
	const denied = results.some((result) => result.data?.denied)
	const onDenied = props.onDenied
	useEffect(() => {
		if (denied) onDenied()
	}, [denied, onDenied])
	const cancel = useCallback(
		(queryKey: readonly unknown[]) => {
			void client.cancelQueries({ queryKey, exact: true })
			client.removeQueries({ queryKey, exact: true })
		},
		[client]
	)
	function toggleRow(row: R): void {
		if (!props.enabled || denied) return
		const key = props.rowKey(row)
		const index = entries.findIndex(([selected]) => selected === key)
		if (index >= 0) cancel(queries[index].queryKey)
		setSelection((current) =>
			toggleAnalyticsDrilldown(current, props.context, key, row)
		)
	}
	function collapseRows(): void {
		for (const query of queries) cancel(query.queryKey)
		setSelection((current) =>
			emptyAnalyticsDrilldowns(props.context, current.nextGeneration)
		)
	}
	const details = new Map<string, AnalyticsDetailState<D>>()
	for (const [index, [key, entry]] of entries.entries()) {
		const result = results[index]
		details.set(
			key,
			analyticsDetailState({
				data: result?.data,
				isFetching: result?.isFetching ?? false,
				isPending: result?.isPending ?? true,
				error: result?.error,
				denied,
				retry: () => {
					if (!props.enabled || denied) return
					cancel(queries[index].queryKey)
					setSelection((current) =>
						retryAnalyticsDrilldown(
							current,
							props.context,
							key,
							entry.generation
						)
					)
				},
			})
		)
	}
	return { details, toggleRow, collapseRows }
}
