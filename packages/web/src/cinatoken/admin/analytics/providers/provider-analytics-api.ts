/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { ReliabilityDisplay } from '../../reliability/reliability-contracts'
import {
	createAdminModelAnalyticsApi,
	modelAnalyticsPath,
	modelAnalyticsRangeParams,
	type ModelAnalyticsOptions,
	type ModelAnalyticsTransport,
} from '../models/model-analytics-api'
import {
	modelAnalyticsResponseSchema,
	modelProvidersResponseSchema,
	type ModelAnalyticsRow,
	type ModelProviderRow,
} from '../models/model-analytics-contracts'

function filter(value: string, name: string): string {
	const trimmed = value.trim()
	if (trimmed.length > 600 || /\p{Cc}/u.test(trimmed))
		throw new TypeError(`Invalid ${name} filter`)
	return trimmed
}

export function providerAnalyticsPath(
	startUtc: string,
	endUtc: string,
	tag: string
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	const validTag = filter(tag, 'tag')
	if (validTag) params.set('tag', validTag)
	return `/api/admin/analytics/providers?${params.toString()}`
}

export function providerModelsPath(
	startUtc: string,
	endUtc: string,
	providerId: string,
	tag: string
): string {
	const id = filter(providerId, 'provider')
	if (!id) throw new TypeError('Provider is required')
	return modelAnalyticsPath(startUtc, endUtc, {
		tag,
		providerId: id,
		userEmail: '',
	})
}

export function createAdminProviderAnalyticsApi(
	transport: ModelAnalyticsTransport
) {
	const shared = createAdminModelAnalyticsApi(transport)
	return {
		providerAnalyticsDisplay(
			options: ModelAnalyticsOptions = {}
		): Promise<ReliabilityDisplay> {
			return shared.modelAnalyticsDisplay(options)
		},
		providerAnalyticsLogsAccess(
			options: ModelAnalyticsOptions = {}
		): Promise<boolean> {
			return shared.modelAnalyticsLogsAccess(options)
		},
		async providerAnalytics(
			startUtc: string,
			endUtc: string,
			tag: string,
			options: ModelAnalyticsOptions = {}
		): Promise<{ rows: ModelProviderRow[]; tags: string[] }> {
			const path = providerAnalyticsPath(startUtc, endUtc, tag)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					modelProvidersResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return { rows: response.data, tags: response.tags }
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async providerModels(
			startUtc: string,
			endUtc: string,
			providerId: string,
			tag: string,
			options: ModelAnalyticsOptions = {}
		): Promise<ModelAnalyticsRow[]> {
			const path = providerModelsPath(startUtc, endUtc, providerId, tag)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					modelAnalyticsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return response.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminProviderAnalyticsApi = ReturnType<
	typeof createAdminProviderAnalyticsApi
>
