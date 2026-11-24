/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { adminConfigOverviewResponseSchema } from '../config/config-contracts'
import {
	resolveReliabilityRange,
	type ReliabilityRange,
} from '../reliability/reliability-range'
import {
	DashboardCurrencyUnavailableError,
	dashboardStatsResponseSchema,
	type DashboardDisplayConfig,
	type DashboardSnapshot,
} from './dashboard-contracts'
import { dashboardRangePath, type DashboardRange } from './dashboard-range'

export type DashboardRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
}
export type DashboardTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: DashboardRequestOptions
	): Promise<T>
	invalidResponse(): never
	sanitizeError(error: unknown): Error
}

/** Both reads use the verified Console Cookie session, without raw config or log-detail endpoints. */
export function createAdminDashboardApi(transport: DashboardTransport) {
	function readDisplayConfig(
		overviewResponse: z.infer<typeof adminConfigOverviewResponseSchema>
	): DashboardDisplayConfig {
		const overview = overviewResponse.data
		const currency = overview.billingCurrency
		if (
			(currency.value !== 'USD' && currency.value !== 'CNY') ||
			currency.source === 'unsupported' ||
			currency.source === 'invalid'
		)
			throw new DashboardCurrencyUnavailableError()
		const timezone = overview.businessTimezone.value
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: timezone })
		} catch {
			transport.invalidResponse()
		}
		const displayConfig: DashboardDisplayConfig = {
			businessTimezone: timezone,
			timezoneSource: overview.businessTimezone.source,
			billingCurrency: currency.value,
			currencySource: currency.source,
		}
		return displayConfig
	}

	return {
		async dashboardWindow(
			range: ReliabilityRange,
			options: DashboardRequestOptions = {},
			now = new Date()
		) {
			try {
				options.signal?.throwIfAborted()
				const overview = await transport.send(
					'/api/admin/config/overview',
					adminConfigOverviewResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				const displayConfig = readDisplayConfig(overview)
				const rangeParams = resolveReliabilityRange(
					range,
					displayConfig.businessTimezone,
					now
				)
				if (!rangeParams) throw new TypeError('Invalid dashboard range')
				const params = new URLSearchParams({
					start_date: rangeParams.startUtc,
					end_date: rangeParams.endUtc,
				})
				const response = await transport.send(
					`/api/admin/stats?${params}`,
					dashboardStatsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return { stats: response.data, displayConfig, rangeParams }
			} catch (error) {
				if (error instanceof DashboardCurrencyUnavailableError) throw error
				throw transport.sanitizeError(error)
			}
		},
		async dashboard(
			range: DashboardRange,
			options: DashboardRequestOptions = {}
		): Promise<DashboardSnapshot> {
			const statsPath = dashboardRangePath(range)
			try {
				options.signal?.throwIfAborted()
				const [response, overviewResponse] = await Promise.all([
					transport.send(statsPath, dashboardStatsResponseSchema, {}, options),
					transport.send(
						'/api/admin/config/overview',
						adminConfigOverviewResponseSchema,
						{},
						options
					),
				])
				options.signal?.throwIfAborted()
				const displayConfig = readDisplayConfig(overviewResponse)
				return { stats: response.data, displayConfig }
			} catch (error) {
				if (error instanceof DashboardCurrencyUnavailableError) throw error
				throw transport.sanitizeError(error)
			}
		},
	}
}

export type AdminDashboardApi = ReturnType<typeof createAdminDashboardApi>
