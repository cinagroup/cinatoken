/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

export const userIdSchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value.trim() === value &&
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
			)
	)
const count = z.number().int().nonnegative().safe()
const money = z.number().finite()
const timestamp = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	.refine((value) => Number.isFinite(Date.parse(value)))

/** Strip extra database columns before a row enters the Console query cache. */
export const adminUserListRowSchema = z
	.object({
		id: userIdSchema,
		email: z.string().min(1).max(320),
		external_system: z.string().max(600).nullable(),
		external_user_id: z.string().max(600).nullable(),
		budget_max: money.nullable(),
		budget_base: money,
		budget_spent: money,
		budget_period: z.enum(['none', 'daily', 'weekly', 'monthly']),
		budget_reset_at: timestamp.nullable(),
		status: z.string().min(1).max(80),
		metadata: z.string().max(131_072).nullable(),
		charged_cost_factors: z
			.record(z.string().min(1).max(600), money.nonnegative())
			.nullable(),
		created_at: timestamp,
		updated_at: timestamp,
		active_keys_count: count,
		keys_count: count,
	})
	.superRefine((row, context) => {
		if (row.active_keys_count > row.keys_count)
			context.addIssue({ code: 'custom', message: 'Invalid key counts' })
		if ((row.external_system === null) !== (row.external_user_id === null))
			context.addIssue({ code: 'custom', message: 'Invalid external identity' })
	})
export type AdminUserListRow = z.infer<typeof adminUserListRowSchema>

export const adminUserListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminUserListRowSchema).max(20),
	total: count,
	page: z.number().int().positive().safe(),
	page_size: z.literal(20),
})
export type AdminUserListResponse = z.infer<typeof adminUserListResponseSchema>

export const adminUserCreatedResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: userIdSchema }),
})

/** The full overview is safe, but this reader keeps only its currency field. */
export const usersCurrencyResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		billingCurrency: z.object({
			value: z.string().regex(/^[A-Z]{3}$/),
			source: z.enum(['configured', 'missing', 'invalid', 'unsupported']),
		}),
	}),
})
