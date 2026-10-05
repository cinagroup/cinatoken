/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const utcIso = z.string().refine((value) => {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value))
		return false
	const ms = Date.parse(value)
	return (
		Number.isFinite(ms) &&
		new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
	)
})
// The route normally normalizes D1 SQL timestamps; accept only the canonical
// UTC-seconds legacy shape as a defensive fallback, then store ISO in Query.
const lastActive = z
	.union([
		utcIso,
		z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
			.transform((value) => `${value.replace(' ', 'T')}.000Z`)
			.pipe(utcIso),
	])
	.nullable()

export const userAnalyticsRowSchema = z
	.object({
		user_email: z
			.string()
			.min(1)
			.max(320)
			.refine(
				(value) =>
					value === value.trim() && value.length > 0 && !/\p{Cc}/u.test(value)
			),
		request_count: count,
		input_tokens: count,
		output_tokens: count,
		standard_cost: finite.optional(),
		charged_cost: finite,
		metered_cost: finite,
		distinct_models: count,
		last_active_at: lastActive,
		budget_max: finite.nullable(),
		budget_spent: finite,
		// Current joined-user budget snapshot, not a selected-range spend.
		budget_usage_rate: finite.nonnegative().nullable(),
		success_rate: finite.min(0).max(100),
		error_count: count,
	})
	.refine(
		(row) =>
			row.error_count <= row.request_count &&
			row.distinct_models <= row.request_count &&
			(row.budget_max !== null && row.budget_max > 0
				? row.budget_usage_rate !== null
				: row.budget_usage_rate === null)
	)
export type UserAnalyticsRow = z.infer<typeof userAnalyticsRowSchema>

export const userAnalyticsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(userAnalyticsRowSchema),
	})
	.superRefine((response, context) => {
		const emails = new Set<string>()
		for (const row of response.data) {
			if (emails.has(row.user_email))
				context.addIssue({
					code: 'custom',
					message: 'Duplicate user analytics row',
				})
			emails.add(row.user_email)
		}
	})
