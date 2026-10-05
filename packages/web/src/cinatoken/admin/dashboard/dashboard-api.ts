/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import { adminConfigOverviewResponseSchema } from '../config/config-contracts'
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
	return {
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
				return { stats: response.data, displayConfig }
			} catch (error) {
				if (error instanceof DashboardCurrencyUnavailableError) throw error
				throw transport.sanitizeError(error)
			}
		},
	}
}

export type AdminDashboardApi = ReturnType<typeof createAdminDashboardApi>
