/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { auditLogSchema } from '../audit-logs/audit-log-contracts'
import {
	gatewayKeyDetailSchema,
	gatewayKeyIdSchema,
	gatewayKeyOwnerIdSchema,
} from '../gateway-keys/gateway-key-contracts'
import { parseGatewayKeyMetadata } from '../gateway-keys/gateway-key-metadata'
import { requestLogSchema } from '../request-logs/request-log-contracts'
import { userIdSchema } from '../users/users-contracts'

const count = z.number().int().nonnegative().safe()
const money = z.number().finite().nonnegative()
const shortText = z.string().max(2_000)
const timestamp = z.string().refine((value) => {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value))
		return false
	const ms = Date.parse(value)
	return (
		Number.isFinite(ms) &&
		new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
	)
})
const metadata = z.record(z.string().max(600), z.unknown()).nullable()

/** Extra repository columns never enter page state. */
export const userDetailSchema = z
	.object({
		id: userIdSchema,
		email: z.email().max(320),
		external_system: shortText.nullable(),
		external_user_id: shortText.nullable(),
		budget_max: money.nullable(),
		budget_base: money,
		budget_spent: money,
		budget_period: z.enum(['none', 'daily', 'weekly', 'monthly']),
		budget_reset_at: timestamp.nullable(),
		status: shortText.min(1),
		metadata,
		charged_cost_factors: z
			.record(userIdSchema, z.number().finite().nonnegative())
			.nullable(),
		created_at: timestamp,
		updated_at: timestamp,
	})
	.refine(
		(user) =>
			(user.external_system === null) === (user.external_user_id === null)
	)
export type UserDetail = z.infer<typeof userDetailSchema>

export const userDetailResponseSchema = z.object({
	success: z.literal(true),
	data: userDetailSchema,
})

const keySummary = z.object({ field_count: count.max(1000) }).strict()
function metadataSummary(raw: unknown): { field_count: number } | null {
	if (raw === null) return null
	if (typeof raw !== 'string') throw new TypeError('Metadata unavailable')
	const parsed = parseGatewayKeyMetadata(raw)
	return parsed ? { field_count: Object.keys(parsed).length } : null
}

/** Legacy raw columns are consumed once for a count and never retained by Query. */
export const userDetailKeySchema = z
	.object({
		id: gatewayKeyIdSchema,
		key: z
			.string()
			.max(600)
			.transform(() => 'sk-…' as const),
		user_id: gatewayKeyOwnerIdSchema,
		workspace_id: gatewayKeyOwnerIdSchema,
		name: shortText.nullable(),
		status: shortText.min(1),
		metadata: z.unknown().optional(),
		metadata_raw: z.unknown().optional(),
		metadata_preview: z.string().max(1024).nullable().optional(),
		metadata_unavailable: z.boolean().optional(),
		last_used_at: gatewayKeyDetailSchema.shape.created_at.nullable(),
		created_at: gatewayKeyDetailSchema.shape.created_at,
		updated_at: gatewayKeyDetailSchema.shape.updated_at,
	})
	.transform((row, context) => {
		let summary: { field_count: number } | null = null
		let unavailable = row.metadata_unavailable ?? false
		if (row.metadata_preview !== undefined) {
			try {
				summary =
					row.metadata_preview === null
						? null
						: keySummary.parse(JSON.parse(row.metadata_preview) as unknown)
				if (unavailable && summary !== null)
					throw new TypeError('Invalid metadata summary')
			} catch {
				context.addIssue({
					code: 'custom',
					message: 'Invalid metadata summary',
				})
				return z.NEVER
			}
		} else if (!unavailable) {
			try {
				summary = metadataSummary(row.metadata)
			} catch {
				unavailable = true
			}
		}
		return {
			id: row.id,
			key: row.key,
			user_id: row.user_id,
			workspace_id: row.workspace_id,
			name: row.name,
			status: row.status,
			metadata_preview: summary,
			metadata_unavailable: unavailable,
			last_used_at: row.last_used_at,
			created_at: row.created_at,
			updated_at: row.updated_at,
		}
	})
export type UserDetailKey = z.infer<typeof userDetailKeySchema>

export const userDetailKeysResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(userDetailKeySchema).max(10_000),
})

/** The full secret is returned only by the create response and must stay in memory. */
export const userDetailKeyCreatedSchema = z.object({
	success: z.literal(true),
	data: z.object({
		key: z.string().startsWith('sk-').min(10).max(256),
		key_id: userIdSchema,
		workspace_id: userIdSchema,
	}),
})

export const userDetailKeyUpdatedSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: userIdSchema }),
})

export const userDetailDeletedSchema = z.object({ success: z.literal(true) })

const recentPage = z.object({
	success: z.literal(true),
	total: count,
	page: z.literal(1),
	page_size: z.literal(5),
})
export const userDetailLogsResponseSchema = recentPage.extend({
	data: z.array(requestLogSchema).max(5),
})
export const userDetailAuditsResponseSchema = recentPage.extend({
	data: z.array(auditLogSchema).max(5),
})

export const userDetailModelsResponseSchema = z.object({
	success: z.literal(true),
	count,
	data: z.array(
		z.object({
			id: userIdSchema,
			display_name: shortText.nullable().optional(),
			vendor: shortText.nullable().optional(),
		})
	),
})
export type UserDetailModel = z.infer<
	typeof userDetailModelsResponseSchema
>['data'][number]

export const userBudgetTransitionSnapshotSchema = z.object({
	budget_max: money.nullable(),
	budget_base: money,
	budget_spent: money,
	budget_period: z.enum(['none', 'daily', 'weekly', 'monthly']),
	budget_reset_at: timestamp.nullable(),
	budget_epoch: count,
	budget_reserved_micros: count,
})
export const userBudgetTransitionPreviewSchema = z.object({
	before: userBudgetTransitionSnapshotSchema,
	after: userBudgetTransitionSnapshotSchema,
	carryover: z.number().finite(),
})
export type UserBudgetTransitionPreview = z.infer<
	typeof userBudgetTransitionPreviewSchema
>
export type UserBudgetTransitionInput = {
	target_budget_base: number
	budget_period: UserDetail['budget_period']
	budget_reset_at?: string | null
	carryover_strategy: 'remaining_or_overage' | 'none'
	reset_spent: boolean
	reason: string
}
export const userBudgetTransitionPreviewResponseSchema = z.object({
	success: z.literal(true),
	data: userBudgetTransitionPreviewSchema,
})
export const userBudgetTransitionApplyResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		transition: userBudgetTransitionPreviewSchema,
		user: userDetailSchema,
	}),
})
