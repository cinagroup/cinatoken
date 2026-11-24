/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
	analyticsDetailState,
	type AnalyticsDetailState,
} from '../models/analytics-drilldowns'
import type { ModelAnalyticsRow } from '../models/model-analytics-contracts'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import {
	emptyUserAnalyticsDrilldowns,
	retryUserAnalyticsKey,
	retryUserAnalyticsRow,
	toggleUserAnalyticsKey,
	toggleUserAnalyticsRow,
	userAnalyticsDrilldownQueryOptions,
	type UserAnalyticsDetailState,
	type UserAnalyticsDrilldownEntry,
	type UserAnalyticsPanelKind,
} from './user-analytics-drilldowns'
import type { UserKeyAnalyticsRow } from './user-key-analytics'

export function useUserAnalyticsDrilldowns(props: {
	prefix: readonly unknown[]
	context: string
	enabled: boolean
	readModels: (
		row: UserAnalyticsRow,
		signal: AbortSignal
	) => Promise<ModelAnalyticsRow[]>
	readKeys: (
		row: UserAnalyticsRow,
		signal: AbortSignal
	) => Promise<UserKeyAnalyticsRow[]>
	readKeyModels: (
		row: UserAnalyticsRow,
		id: string,
		signal: AbortSignal
	) => Promise<ModelAnalyticsRow[]>
	onDenied: () => void
}): {
	details: ReadonlyMap<string, UserAnalyticsDetailState>
	toggleRow: (row: UserAnalyticsRow, kind?: UserAnalyticsPanelKind) => void
	collapseRows: () => void
} {
	const client = useQueryClient()
	const [selection, setSelection] = useState(() =>
		emptyUserAnalyticsDrilldowns(props.context)
	)
	const valid = selection.context === props.context && props.enabled
	if (
		selection.context !== props.context ||
		(!props.enabled && selection.rows.size)
	)
		setSelection(
			emptyUserAnalyticsDrilldowns(props.context, selection.nextGeneration)
		)
	const entries = useMemo(
		() => (valid ? [...selection.rows.values()] : []),
		[valid, selection.rows]
	)
	const modelEntries = entries.filter((entry) => entry.kind === 'models')
	const keyEntries = entries.filter((entry) => entry.kind === 'keys')
	const modelQueries = modelEntries.map((entry) =>
		userAnalyticsDrilldownQueryOptions({
			prefix: props.prefix,
			context: props.context,
			entry,
			read: (signal) => props.readModels(entry.row, signal),
		})
	)
	const keyQueries = keyEntries.map((entry) =>
		userAnalyticsDrilldownQueryOptions({
			prefix: props.prefix,
			context: props.context,
			entry,
			read: (signal) => props.readKeys(entry.row, signal),
		})
	)
	// Each observer consumes its signal. Removing a panel cancels only its own
	// reads; there is no whole-prefix unmount cleanup that can affect another page.
	const modelResults = useQueries({ queries: modelQueries })
	const keyResults = useQueries({ queries: keyQueries })
	const childEntries = keyEntries.flatMap((entry, index) => {
		const result = keyResults[index]
		if (result?.isFetching || !result?.data?.rows || result.data.error)
			return []
		const availableKeys = result.data.rows
		return [...entry.keyModels].flatMap(([id, generation]) =>
			availableKeys.some((key) => key.api_key_id === id)
				? [{ parent: entry, id, generation }]
				: []
		)
	})
	const childQueries = childEntries.map((entry) =>
		userAnalyticsDrilldownQueryOptions({
			prefix: props.prefix,
			context: props.context,
			entry: entry.parent,
			keyId: entry.id,
			read: (signal) => props.readKeyModels(entry.parent.row, entry.id, signal),
		})
	)
	const childResults = useQueries({ queries: childQueries })
	const denied =
		modelResults.some((result) => result.data?.denied) ||
		keyResults.some((result) => result.data?.denied) ||
		childResults.some((result) => result.data?.denied)
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
	function cancelPanel(email: string): void {
		modelEntries.forEach((entry, index) => {
			if (entry.row.user_email === email) cancel(modelQueries[index].queryKey)
		})
		keyEntries.forEach((entry, index) => {
			if (entry.row.user_email === email) cancel(keyQueries[index].queryKey)
		})
		childEntries.forEach((entry, index) => {
			if (entry.parent.row.user_email === email)
				cancel(childQueries[index].queryKey)
		})
	}
	function toggleRow(
		row: UserAnalyticsRow,
		kind: UserAnalyticsPanelKind = 'models'
	): void {
		if (!props.enabled || denied || (kind === 'keys' && !row.user_id)) return
		cancelPanel(row.user_email)
		setSelection((current) =>
			toggleUserAnalyticsRow(current, props.context, row, kind)
		)
	}
	function collapseRows(): void {
		for (const query of [...modelQueries, ...keyQueries, ...childQueries])
			cancel(query.queryKey)
		setSelection((current) =>
			emptyUserAnalyticsDrilldowns(props.context, current.nextGeneration)
		)
	}
	function retryPanel(entry: UserAnalyticsDrilldownEntry): void {
		if (!props.enabled || denied) return
		cancelPanel(entry.row.user_email)
		setSelection((current) =>
			retryUserAnalyticsRow(
				current,
				props.context,
				entry.row.user_email,
				entry.generation
			)
		)
	}
	const details = new Map<string, UserAnalyticsDetailState>()
	for (const [index, entry] of modelEntries.entries()) {
		const result = modelResults[index]
		details.set(entry.row.user_email, {
			kind: 'models',
			state: analyticsDetailState({
				data: result?.data,
				isFetching: result?.isFetching ?? false,
				isPending: result?.isPending ?? true,
				error: result?.error,
				denied,
				retry: () => retryPanel(entry),
			}),
		})
	}
	for (const [index, entry] of keyEntries.entries()) {
		const result = keyResults[index]
		const keyModels = new Map<string, AnalyticsDetailState<ModelAnalyticsRow>>()
		for (const [childIndex, child] of childEntries.entries()) {
			if (child.parent !== entry) continue
			const childResult = childResults[childIndex]
			keyModels.set(
				child.id,
				analyticsDetailState({
					data: childResult?.data,
					isFetching: childResult?.isFetching ?? false,
					isPending: childResult?.isPending ?? true,
					error: childResult?.error,
					denied,
					retry: () => {
						if (!props.enabled || denied) return
						cancel(childQueries[childIndex].queryKey)
						setSelection((current) =>
							retryUserAnalyticsKey(
								current,
								props.context,
								entry.row.user_email,
								entry.generation,
								child.id,
								child.generation
							)
						)
					},
				})
			)
		}
		details.set(entry.row.user_email, {
			kind: 'keys',
			state: analyticsDetailState({
				data: result?.data,
				isFetching: result?.isFetching ?? false,
				isPending: result?.isPending ?? true,
				error: result?.error,
				denied,
				retry: () => retryPanel(entry),
			}),
			keyModels,
			toggleKey: (id) => {
				if (
					!props.enabled ||
					denied ||
					result?.isFetching ||
					!result?.data?.rows ||
					result.data.error
				)
					return
				const availableKeys = result.data.rows
				const childIndex = childEntries.findIndex(
					(child) => child.parent === entry && child.id === id
				)
				if (childIndex >= 0) cancel(childQueries[childIndex].queryKey)
				setSelection((current) =>
					toggleUserAnalyticsKey(
						current,
						props.context,
						entry.row.user_email,
						entry.generation,
						id,
						availableKeys
					)
				)
			},
		})
	}
	return { details, toggleRow, collapseRows }
}
