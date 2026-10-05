/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import type { z } from 'zod'
import {
	adminConfigOverviewResponseSchema,
	adminTimezoneWriteResponseSchema,
	billingCurrencyWrite,
	billingCurrencyWriteResponseSchema,
	configRevisionSchema,
	normalizeBusinessTimezoneWrite,
	normalizeWebhookWrite,
	routeStrategyName,
	routeStrategyWriteResponseSchema,
	webhookChannel,
	webhookRevealResponseSchema,
	webhookVerifyResponseSchema,
	webhookWriteResponseSchema,
	type AdminConfigBillingCurrency,
	type AdminConfigOverview,
	type AdminConfigRouteStrategy,
	type AdminConfigRevision,
	type AdminConfigWebhookChannel,
} from './config-contracts'

export type AdminConfigRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
}
export type AdminConfigTransport = {
	send<T>(
		path: string,
		schema: z.ZodType<T>,
		init: RequestInit,
		options: AdminConfigRequestOptions
	): Promise<T>
	invalidResponse(): never
	sanitizeError(error: unknown): Error
}

/** Browser Console Cookie transport; never calls the secret-bearing generic GET. */
export function createAdminConfigApi(transport: AdminConfigTransport) {
	function channelPath(channel: AdminConfigWebhookChannel): string {
		if (!webhookChannel.safeParse(channel).success) transport.invalidResponse()
		return `/api/admin/config/webhooks/${channel}`
	}
	function requestOptions(
		options: AdminConfigRequestOptions
	): AdminConfigRequestOptions {
		return { signal: options.signal, timeoutMs: options.timeoutMs }
	}
	function revisionHeaders(
		expectedRevision: AdminConfigRevision
	): Record<string, string> {
		if (expectedRevision === null) return { 'If-None-Match': '*' }
		if (!configRevisionSchema.safeParse(expectedRevision).success)
			transport.invalidResponse()
		return { 'If-Match': `"${expectedRevision}"` }
	}
	return {
		async configOverview(
			options: AdminConfigRequestOptions = {}
		): Promise<AdminConfigOverview> {
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/overview',
					adminConfigOverviewResponseSchema,
					{},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				return result.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async updateBusinessTimezone(
			value: string,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<void> {
			const normalized = normalizeBusinessTimezoneWrite(value)
			try {
				options.signal?.throwIfAborted()
				await transport.send(
					'/api/admin/config',
					adminTimezoneWriteResponseSchema,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...revisionHeaders(expectedRevision),
						},
						body: JSON.stringify({
							key: 'BUSINESS_TIMEZONE',
							value: normalized,
						}),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async updateBillingCurrency(
			value: AdminConfigBillingCurrency,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<AdminConfigOverview['billingCurrency']> {
			if (!billingCurrencyWrite.safeParse(value).success)
				transport.invalidResponse()
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/billing-currency',
					billingCurrencyWriteResponseSchema,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...revisionHeaders(expectedRevision),
						},
						body: JSON.stringify({ value }),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.billingCurrency.value !== value)
					transport.invalidResponse()
				return result.data.billingCurrency
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async updateRouteStrategy(
			value: AdminConfigRouteStrategy,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<AdminConfigOverview['routeStrategy']> {
			if (!routeStrategyName.safeParse(value).success)
				transport.invalidResponse()
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/route-strategy',
					routeStrategyWriteResponseSchema,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...revisionHeaders(expectedRevision),
						},
						body: JSON.stringify({ value }),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.routeStrategy.value !== value)
					transport.invalidResponse()
				return result.data.routeStrategy
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async replaceWebhook(
			channel: AdminConfigWebhookChannel,
			value: string,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<void> {
			const path = channelPath(channel)
			const normalized = normalizeWebhookWrite(channel, value)
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path,
					webhookWriteResponseSchema,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...revisionHeaders(expectedRevision),
						},
						body: JSON.stringify({ value: normalized }),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (!result.data.webhook.configured) transport.invalidResponse()
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async clearWebhook(
			channel: AdminConfigWebhookChannel,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<void> {
			const path = channelPath(channel)
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path,
					webhookWriteResponseSchema,
					{ method: 'DELETE', headers: revisionHeaders(expectedRevision) },
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.webhook.configured) transport.invalidResponse()
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async revealWebhook(
			channel: AdminConfigWebhookChannel,
			options: AdminConfigRequestOptions = {}
		): Promise<string> {
			const path = channelPath(channel) + '/reveal'
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path,
					webhookRevealResponseSchema,
					{},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.channel !== channel) transport.invalidResponse()
				return result.data.value
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async verifyWebhook(
			channel: AdminConfigWebhookChannel,
			value: string,
			options: AdminConfigRequestOptions = {}
		): Promise<{ matched: boolean; configured: boolean }> {
			const path = channelPath(channel) + '/verify'
			const normalized = normalizeWebhookWrite(channel, value)
			try {
				options.signal?.throwIfAborted()
				const result = await transport.send(
					path,
					webhookVerifyResponseSchema,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({ value: normalized }),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				if (result.data.channel !== channel) transport.invalidResponse()
				return {
					matched: result.data.matched,
					configured: result.data.configured,
				}
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
	}
}
export type AdminConfigApi = ReturnType<typeof createAdminConfigApi>
