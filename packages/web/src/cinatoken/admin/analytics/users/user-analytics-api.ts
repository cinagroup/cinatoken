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
	type ModelAnalyticsRow,
} from '../models/model-analytics-contracts'
import {
	userAnalyticsResponseSchema,
	type UserAnalyticsRow,
} from './user-analytics-contracts'

function cleanEmail(value: string): string {
	const trimmed = value.trim()
	if (trimmed.length > 320 || /\p{Cc}/u.test(trimmed))
		throw new TypeError('Invalid analytics email filter')
	return trimmed
}

export function userAnalyticsPath(
	startUtc: string,
	endUtc: string,
	email: string
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	const filter = cleanEmail(email)
	if (filter) params.set('email', filter)
	return `/api/admin/analytics/users?${params.toString()}`
}

export function userModelsPath(
	startUtc: string,
	endUtc: string,
	selectedEmail: string
): string {
	if (!selectedEmail || selectedEmail !== selectedEmail.trim())
		throw new TypeError('Exact user email is required')
	return modelAnalyticsPath(startUtc, endUtc, {
		tag: '',
		providerId: '',
		userEmail: selectedEmail,
	})
}

export function createAdminUserAnalyticsApi(
	transport: ModelAnalyticsTransport
) {
	const shared = createAdminModelAnalyticsApi(transport)
	return {
		userAnalyticsDisplay(
			options: ModelAnalyticsOptions = {}
		): Promise<ReliabilityDisplay> {
			return shared.modelAnalyticsDisplay(options)
		},
		userAnalyticsLogsAccess(
			options: ModelAnalyticsOptions = {}
		): Promise<boolean> {
			return shared.modelAnalyticsLogsAccess(options)
		},
		async userAnalytics(
			startUtc: string,
			endUtc: string,
			email: string,
			options: ModelAnalyticsOptions = {}
		): Promise<UserAnalyticsRow[]> {
			const path = userAnalyticsPath(startUtc, endUtc, email)
			try {
				options.signal?.throwIfAborted()
				const response = await transport.send(
					path,
					userAnalyticsResponseSchema,
					{},
					options
				)
				options.signal?.throwIfAborted()
				return response.data
			} catch (error) {
				throw transport.sanitizeError(error)
			}
		},
		async userModels(
			startUtc: string,
			endUtc: string,
			selectedEmail: string,
			options: ModelAnalyticsOptions = {}
		): Promise<ModelAnalyticsRow[]> {
			const path = userModelsPath(startUtc, endUtc, selectedEmail)
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
export type AdminUserAnalyticsApi = ReturnType<
	typeof createAdminUserAnalyticsApi
>
