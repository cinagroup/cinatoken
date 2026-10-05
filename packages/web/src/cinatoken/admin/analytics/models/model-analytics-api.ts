/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { createAdminReliabilityApi } from '../../reliability/reliability-api'
import type { ReliabilityDisplay } from '../../reliability/reliability-contracts'
import {
	logsPermissionResponseSchema,
	modelAnalyticsResponseSchema,
	modelProvidersResponseSchema,
	type ModelAnalyticsRow,
	type ModelProviderRow,
} from './model-analytics-contracts'

export type ModelAnalyticsOptions = { signal?: AbortSignal; timeoutMs?: number }
export type ModelAnalyticsTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ModelAnalyticsOptions
	): Promise<T>
	invalidResponse(): never
	sanitizeError(error: unknown): Error
}
export type ModelAnalyticsFilters = {
	tag: string
	providerId: string
	userEmail: string
}
const utcPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export function modelAnalyticsRangeParams(
	startUtc: string,
	endUtc: string
): URLSearchParams {
	if (!utcPattern.test(startUtc) || !utcPattern.test(endUtc))
		throw new TypeError('Invalid UTC range')
	const start = Date.parse(startUtc.replace(' ', 'T') + 'Z')
	const end = Date.parse(endUtc.replace(' ', 'T') + 'Z')
	if (
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start > end ||
		new Date(start).toISOString().slice(0, 19).replace('T', ' ') !== startUtc ||
		new Date(end).toISOString().slice(0, 19).replace('T', ' ') !== endUtc ||
		end - start > 180 * 86400000
	)
		throw new TypeError('Invalid UTC range')
	return new URLSearchParams({ start_date: startUtc, end_date: endUtc })
}

function clean(value: string, max: number): string {
	const trimmed = value.trim()
	if (trimmed.length > max || /\p{Cc}/u.test(trimmed))
		throw new TypeError('Invalid analytics filter')
	return trimmed
}

export function modelAnalyticsPath(
	startUtc: string,
	endUtc: string,
	filters: ModelAnalyticsFilters
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	const tag = clean(filters.tag, 600)
	const providerId = clean(filters.providerId, 600)
	const userEmail = clean(filters.userEmail, 320)
	if (tag) params.set('tag', tag)
	if (providerId) params.set('provider_id', providerId)
	if (userEmail) params.set('user_email', userEmail)
	return `/api/admin/analytics/models?${params.toString()}`
}

export function modelProvidersPath(
	startUtc: string,
	endUtc: string,
	row: Pick<ModelAnalyticsRow, 'model_id' | 'route_group'>,
	tag = ''
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	params.set('model_id', clean(row.model_id, 600))
	params.set('route_group', clean(row.route_group, 600))
	const validTag = clean(tag, 600)
	if (validTag) params.set('tag', validTag)
	return `/api/admin/analytics/providers?${params.toString()}`
}

export function createAdminModelAnalyticsApi(
	transport: ModelAnalyticsTransport
) {
	const display = createAdminReliabilityApi(transport).display
	return {
		modelAnalyticsDisplay(
			options: ModelAnalyticsOptions = {}
		): Promise<ReliabilityDisplay> {
			return display(options)
		},
		async modelAnalytics(
			startUtc: string,
			endUtc: string,
			filters: ModelAnalyticsFilters,
			options: ModelAnalyticsOptions = {}
		): Promise<{ rows: ModelAnalyticsRow[]; tags: string[] }> {
			const path = modelAnalyticsPath(startUtc, endUtc, filters)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					modelAnalyticsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return { rows: response.data, tags: response.tags }
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async modelProviders(
			startUtc: string,
			endUtc: string,
			row: Pick<ModelAnalyticsRow, 'model_id' | 'route_group'>,
			tag: string,
			options: ModelAnalyticsOptions = {}
		): Promise<ModelProviderRow[]> {
			const path = modelProvidersPath(startUtc, endUtc, row, tag)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					modelProvidersResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return response.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		/** A one-row logs read proves logs.read; the response body is projected away. */
		async modelAnalyticsLogsAccess(
			options: ModelAnalyticsOptions = {}
		): Promise<boolean> {
			try {
				options.signal?.throwIfAborted()
				await transport.send(
					'/api/admin/request-logs?page=1&page_size=1',
					logsPermissionResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return true
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminModelAnalyticsApi = ReturnType<
	typeof createAdminModelAnalyticsApi
>
