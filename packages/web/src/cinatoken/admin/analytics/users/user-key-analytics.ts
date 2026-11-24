/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { modelAnalyticsRangeParams } from '../models/model-analytics-api'
import { userAnalyticsLastActive } from './user-analytics-contracts'

const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const id = z
	.string()
	.min(1)
	.max(600)
	.refine((value) => value === value.trim() && !/[\p{Cc}\p{Cf}]/u.test(value))
export const userKeyAnalyticsRowSchema = z
	.object({
		api_key_id: id.nullable(),
		key_name: z.string().nullable(),
		request_count: count,
		input_tokens: count,
		output_tokens: count,
		standard_cost: finite.optional(),
		charged_cost: finite,
		metered_cost: finite,
		distinct_models: count,
		last_active_at: userAnalyticsLastActive,
		success_count: count,
		error_count: count,
		success_rate: finite.min(0).max(100),
	})
	.refine(
		(row) =>
			row.success_count + row.error_count <= row.request_count &&
			row.distinct_models <= row.request_count &&
			(row.api_key_id !== null || row.key_name === null)
	)
export const userKeyAnalyticsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(userKeyAnalyticsRowSchema),
	})
	.superRefine((value, context) => {
		if (
			new Set(value.data.map((row) => row.api_key_id)).size !==
			value.data.length
		)
			context.addIssue({
				code: 'custom',
				message: 'Duplicate key analytics row',
			})
	})
export type UserKeyAnalyticsRow = z.infer<typeof userKeyAnalyticsRowSchema>
export function userKeysPath(
	startUtc: string,
	endUtc: string,
	userId: string
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	params.set('user_id', z.string().uuid().parse(userId))
	return '/api/admin/analytics/keys?' + params.toString()
}
export function userKeyModelsPath(
	startUtc: string,
	endUtc: string,
	userId: string,
	apiKeyId: string
): string {
	const params = modelAnalyticsRangeParams(startUtc, endUtc)
	params.set('user_id', z.string().uuid().parse(userId))
	if (apiKeyId !== apiKeyId.trim()) throw new TypeError('Exact key ID required')
	params.set('api_key_id', id.parse(apiKeyId))
	return '/api/admin/analytics/models?' + params.toString()
}
