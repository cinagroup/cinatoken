/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { CinaTokenApiError } from '../../api'
import { authCheckSchema, portalMeSchema } from '../../contracts'
import {
	adminConfigOverviewResponseSchema,
	adminTimezoneWriteResponseSchema,
	billingCurrencyWrite,
	billingCurrencyWriteResponseSchema,
	configRevisionSchema,
	userChargedCostFactorMode,
	factorModeWriteResponseSchema,
	type AdminConfigFactorMode,
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
import { createStreamTimeoutApi } from './config-stream-timeout-api'

export type AdminConfigRequestOptions = {
	signal?: AbortSignal
	timeoutMs?: number
	expectedConsoleSubject?: string
	expectedUserId?: string
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

class ConfigSubjectError extends CinaTokenApiError {
	constructor() {
		super('Console identity could not be verified', 401, 'http')
	}
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
	async function verifyFactorModeSubject(
		options: AdminConfigRequestOptions
	): Promise<string> {
		try {
			const subject = options.expectedConsoleSubject
			if (
				!subject ||
				subject.length > 600 ||
				subject !== subject.trim() ||
				/[\p{Cc}\p{Cf}]/u.test(subject) ||
				!options.expectedUserId
			)
				throw new ConfigSubjectError()
			const header = encodeURIComponent(subject)
			options.signal?.throwIfAborted()
			const check = await transport.send(
				'/api/auth/check',
				authCheckSchema,
				{},
				requestOptions(options)
			)
			options.signal?.throwIfAborted()
			if (
				!check.authenticated ||
				check.verification !== 'verified' ||
				check.principalType !== 'console' ||
				check.subject !== subject
			)
				throw new ConfigSubjectError()
			const me = await transport.send(
				'/api/user/me',
				z.object({ success: z.literal(true), data: portalMeSchema }),
				{},
				requestOptions(options)
			)
			options.signal?.throwIfAborted()
			if (
				!me.data.isAdmin ||
				me.data.userId !== options.expectedUserId ||
				me.data.subject !== subject
			)
				throw new ConfigSubjectError()
			return header
		} catch {
			throw new ConfigSubjectError()
		}
	}
	return {
		...createStreamTimeoutApi(
			transport,
			verifyFactorModeSubject,
			revisionHeaders
		),
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
		async updateUserChargedCostFactorMode(
			value: AdminConfigFactorMode,
			expectedRevision: AdminConfigRevision,
			options: AdminConfigRequestOptions = {}
		): Promise<NonNullable<AdminConfigOverview['userChargedCostFactorMode']>> {
			if (!userChargedCostFactorMode.safeParse(value).success)
				transport.invalidResponse()
			const revisions = revisionHeaders(expectedRevision)
			try {
				const subject = await verifyFactorModeSubject(options)
				options.signal?.throwIfAborted()
				const result = await transport.send(
					'/api/admin/config/user-charged-cost-factor-mode',
					factorModeWriteResponseSchema,
					{
						method: 'PUT',
						headers: {
							'Content-Type': 'application/json',
							...revisions,
							'X-CinaToken-Expected-Console-Subject': subject,
						},
						body: JSON.stringify({ value }),
					},
					requestOptions(options)
				)
				options.signal?.throwIfAborted()
				const field = result.data.userChargedCostFactorMode
				if (
					field.value !== value ||
					field.revision === expectedRevision ||
					field.revision === 'legacy'
				)
					transport.invalidResponse()
				return field
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
