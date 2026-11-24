/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import {
	summarizeAnalyticsRows,
	type AnalyticsInsightsSummary,
} from '../analytics/models/analytics-insights'
import { reliabilityRequestPath } from './reliability-api'
import type {
	ModelProviderReliability,
	ProviderReliability,
} from './reliability-contracts'

const apiIds = new WeakMap<object, number>()
let nextApiId = 0
export function reliabilityQueryPrefix(
	scope: string,
	reconciliation: string,
	api: object,
	instance: string
) {
	let id = apiIds.get(api)
	if (id === undefined) {
		id = ++nextApiId
		apiIds.set(api, id)
	}
	return [
		'cinatoken',
		'admin',
		scope,
		'reliability',
		reconciliation,
		id,
		instance,
	] as const
}

export function summarizeReliabilityRows(
	rows: readonly ProviderReliability[]
): AnalyticsInsightsSummary {
	return summarizeAnalyticsRows(rows)
}

/** Keep every provider for a model adjacent without modifying the response. */
export function groupReliabilityModels(
	rows: readonly ModelProviderReliability[]
): ModelProviderReliability[] {
	const groups = new Map<string, ModelProviderReliability[]>()
	for (const row of rows) {
		const group = groups.get(row.model_id) ?? []
		group.push(row)
		groups.set(row.model_id, group)
	}
	return Array.from(groups.values()).flat()
}

export function reliabilityErrorLogHref(
	range: { startUtc: string; endUtc: string },
	providerId?: string
): string {
	// Use the same validated UTC window as the aggregate request.
	reliabilityRequestPath(range.startUtc, range.endUtc)
	const params = new URLSearchParams({
		status: 'error',
		start_date: range.startUtc,
		end_date: range.endUtc,
	})
	if (providerId !== undefined) params.set('provider_id', providerId)
	return `/admin/request-logs?${params.toString()}`
}
