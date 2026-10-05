/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	reliabilityDisplayResponseSchema,
	reliabilityResponseSchema,
	type ReliabilityDisplay,
	type ReliabilityPayload,
} from './reliability-contracts'

export type ReliabilityRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
}
export type ReliabilityTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: ReliabilityRequestOptions
	): Promise<T>
	invalidResponse(): never
	sanitizeError(error: unknown): Error
}

const sqlUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

export function reliabilityRequestPath(
	startUtc: string,
	endUtc: string
): string {
	if (!sqlUtc.test(startUtc) || !sqlUtc.test(endUtc))
		throw new TypeError('Invalid reliability UTC range')
	const start = Date.parse(startUtc.replace(' ', 'T') + 'Z')
	const end = Date.parse(endUtc.replace(' ', 'T') + 'Z')
	if (
		!Number.isFinite(start) ||
		!Number.isFinite(end) ||
		start > end ||
		new Date(start).toISOString().slice(0, 19).replace('T', ' ') !== startUtc ||
		new Date(end).toISOString().slice(0, 19).replace('T', ' ') !== endUtc ||
		end - start > 180 * 24 * 60 * 60 * 1000
	)
		throw new TypeError('Invalid reliability UTC range')
	const params = new URLSearchParams({ start_date: startUtc, end_date: endUtc })
	return `/api/admin/analytics/reliability?${params.toString()}`
}

export function createAdminReliabilityApi(transport: ReliabilityTransport) {
	return {
		async display(
			options: ReliabilityRequestOptions = {}
		): Promise<ReliabilityDisplay> {
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					'/api/admin/config/overview',
					reliabilityDisplayResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				const timezone = response.data.businessTimezone
				if (
					(timezone.source === 'missing' || timezone.source === 'invalid') &&
					timezone.value !== 'UTC'
				)
					transport.invalidResponse()
				try {
					new Intl.DateTimeFormat('en-US', { timeZone: timezone.value })
				} catch {
					transport.invalidResponse()
				}
				const billing = response.data.billingCurrency
				let currency: ReliabilityDisplay['currency'] = null
				let currencySource: ReliabilityDisplay['currencySource'] = null
				if (billing.source === 'missing' && billing.value === 'USD') {
					currency = 'USD'
					currencySource = 'missing'
				} else if (
					billing.source === 'configured' &&
					(billing.value === 'USD' || billing.value === 'CNY')
				) {
					currency = billing.value
					currencySource = 'configured'
				}
				return {
					timezone: timezone.value,
					timezoneSource: timezone.source,
					currency,
					currencySource,
				}
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async reliability(
			startUtc: string,
			endUtc: string,
			options: ReliabilityRequestOptions = {}
		): Promise<ReliabilityPayload> {
			const path = reliabilityRequestPath(startUtc, endUtc)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					reliabilityResponseSchema,
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

export type AdminReliabilityApi = ReturnType<typeof createAdminReliabilityApi>
