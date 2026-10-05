/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const count = z.number().int().nonnegative().safe()
const money = z.number().finite()
const text = z.string().max(2_000)
const nullableText = text.nullable().optional()
const raw = z.string().max(262_144).nullable().optional()
const utcIso = z.string().refine((value) => {
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value))
		return false
	const ms = Date.parse(value)
	return (
		Number.isFinite(ms) &&
		new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)
	)
})
const createdAt = z.union([
	utcIso,
	z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u)
		.transform((value) => `${value.replace(' ', 'T')}.000Z`)
		.pipe(utcIso),
])

/** Project the server's audit row before retaining it in private, component-local state. */
export const auditLogSchema = z.object({
	id: text.min(1),
	user_id: nullableText,
	api_key_id: nullableText,
	user_email: nullableText,
	event_type: text.min(1),
	actor_type: text.min(1),
	actor_id: nullableText,
	reason_code: nullableText,
	reason_text: nullableText,
	source: nullableText,
	correlation_id: nullableText,
	request_log_id: nullableText,
	before_spent: money.nullable().optional(),
	after_spent: money.nullable().optional(),
	delta_spent: money.nullable().optional(),
	before_budget_max: money.nullable().optional(),
	after_budget_max: money.nullable().optional(),
	before_budget_base: money.nullable().optional(),
	after_budget_base: money.nullable().optional(),
	before_budget_period: nullableText,
	after_budget_period: nullableText,
	before_budget_reset_at: nullableText,
	after_budget_reset_at: nullableText,
	change_payload: raw,
	before_user_snapshot: raw,
	after_user_snapshot: raw,
	changed_fields: raw,
	created_at: createdAt,
})
export type AuditLog = z.infer<typeof auditLogSchema>

export const auditLogsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(auditLogSchema).max(100),
		total: count,
		page: count.positive(),
		page_size: count.min(1).max(100),
	})
	.superRefine((value, context) => {
		if (
			value.data.length > value.page_size ||
			new Set(value.data.map((row) => row.id)).size !== value.data.length
		)
			context.addIssue({
				code: 'custom',
				message: 'Audit-log page is inconsistent',
			})
	})
export type AuditLogPage = Pick<
	z.infer<typeof auditLogsResponseSchema>,
	'data' | 'total' | 'page' | 'page_size'
>

export const auditFilterOptionsResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		reasonCodes: z.array(text.min(1)).max(10_000),
	}),
})
export type AuditFilterOptions = z.infer<
	typeof auditFilterOptionsResponseSchema
>['data']
