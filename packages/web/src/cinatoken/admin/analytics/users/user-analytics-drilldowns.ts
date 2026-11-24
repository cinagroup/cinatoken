/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	analyticsDrilldownQueryOptions,
	type AnalyticsDetailState,
} from '../models/analytics-drilldowns'
import type { ModelAnalyticsRow } from '../models/model-analytics-contracts'
import type { UserAnalyticsRow } from './user-analytics-contracts'
import type { UserKeyAnalyticsRow } from './user-key-analytics'

export type UserAnalyticsDetailState =
	| { kind: 'models'; state: AnalyticsDetailState<ModelAnalyticsRow> }
	| {
			kind: 'keys'
			state: AnalyticsDetailState<UserKeyAnalyticsRow>
			keyModels: ReadonlyMap<string, AnalyticsDetailState<ModelAnalyticsRow>>
			toggleKey: (id: string) => void
	  }
export type UserAnalyticsPanelKind = UserAnalyticsDetailState['kind']
export type UserAnalyticsDrilldownEntry = {
	row: UserAnalyticsRow
	kind: UserAnalyticsPanelKind
	generation: number
	keyModels: ReadonlyMap<string, number>
}
export type UserAnalyticsDrilldownSelection = {
	context: string
	nextGeneration: number
	rows: ReadonlyMap<string, UserAnalyticsDrilldownEntry>
}

export function emptyUserAnalyticsDrilldowns(
	context: string,
	nextGeneration = 0
): UserAnalyticsDrilldownSelection {
	return { context, nextGeneration, rows: new Map() }
}

export function toggleUserAnalyticsRow(
	selection: UserAnalyticsDrilldownSelection,
	context: string,
	row: UserAnalyticsRow,
	kind: UserAnalyticsPanelKind
): UserAnalyticsDrilldownSelection {
	if (kind === 'keys' && !row.user_id) return selection
	const current =
		selection.context === context
			? selection
			: emptyUserAnalyticsDrilldowns(context, selection.nextGeneration)
	const rows = new Map(current.rows)
	const existing = rows.get(row.user_email)
	if (existing?.kind === kind) {
		rows.delete(row.user_email)
		return { ...current, rows }
	}
	const nextGeneration = current.nextGeneration + 1
	rows.set(row.user_email, {
		row,
		kind,
		generation: nextGeneration,
		keyModels: new Map(),
	})
	return { context, nextGeneration, rows }
}

export function retryUserAnalyticsRow(
	selection: UserAnalyticsDrilldownSelection,
	context: string,
	email: string,
	generation: number
): UserAnalyticsDrilldownSelection {
	const entry = selection.rows.get(email)
	if (selection.context !== context || entry?.generation !== generation)
		return selection
	const nextGeneration = selection.nextGeneration + 1
	const rows = new Map(selection.rows)
	rows.set(email, {
		...entry,
		generation: nextGeneration,
		keyModels: new Map(),
	})
	return { ...selection, nextGeneration, rows }
}

export function toggleUserAnalyticsKey(
	selection: UserAnalyticsDrilldownSelection,
	context: string,
	email: string,
	parentGeneration: number,
	id: string,
	availableKeys: readonly Pick<UserKeyAnalyticsRow, 'api_key_id'>[]
): UserAnalyticsDrilldownSelection {
	const entry = selection.rows.get(email)
	if (
		selection.context !== context ||
		entry?.generation !== parentGeneration ||
		entry.kind !== 'keys' ||
		!entry.row.user_id ||
		!id ||
		!availableKeys.some((key) => key.api_key_id === id)
	)
		return selection
	const keyModels = new Map(entry.keyModels)
	let nextGeneration = selection.nextGeneration
	if (!keyModels.delete(id)) keyModels.set(id, ++nextGeneration)
	const rows = new Map(selection.rows)
	rows.set(email, { ...entry, keyModels })
	return { ...selection, nextGeneration, rows }
}

export function retryUserAnalyticsKey(
	selection: UserAnalyticsDrilldownSelection,
	context: string,
	email: string,
	parentGeneration: number,
	id: string,
	generation: number
): UserAnalyticsDrilldownSelection {
	const entry = selection.rows.get(email)
	if (
		selection.context !== context ||
		entry?.generation !== parentGeneration ||
		entry.kind !== 'keys' ||
		!entry.row.user_id ||
		entry.keyModels.get(id) !== generation
	)
		return selection
	const nextGeneration = selection.nextGeneration + 1
	const keyModels = new Map(entry.keyModels)
	keyModels.set(id, nextGeneration)
	const rows = new Map(selection.rows)
	rows.set(email, { ...entry, keyModels })
	return { ...selection, nextGeneration, rows }
}

export function userAnalyticsDetailKey(
	entry: UserAnalyticsDrilldownEntry,
	keyId?: string
): string {
	return JSON.stringify([
		entry.row.user_email,
		entry.row.user_id ?? null,
		entry.kind,
		keyId ?? null,
	])
}

export function userAnalyticsDrilldownQueryOptions<D>(input: {
	prefix: readonly unknown[]
	context: string
	entry: UserAnalyticsDrilldownEntry
	keyId?: string
	read: (signal: AbortSignal) => Promise<D[]>
}) {
	const generation =
		input.keyId === undefined
			? input.entry.generation
			: input.entry.keyModels.get(input.keyId)
	if (generation === undefined) throw new TypeError('Key is not expanded')
	const prefix =
		input.keyId === undefined
			? [...input.prefix, input.entry.kind]
			: [...input.prefix, 'keyModels', input.entry.generation]
	return analyticsDrilldownQueryOptions({
		prefix,
		context: input.context,
		key: userAnalyticsDetailKey(input.entry, input.keyId),
		generation,
		read: input.read,
	})
}
