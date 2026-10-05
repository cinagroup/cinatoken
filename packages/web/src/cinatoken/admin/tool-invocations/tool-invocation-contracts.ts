/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { requestLogSchema } from '../request-logs/request-log-contracts'

/** Project only fields required by Tool Invocations; other request-log columns are discarded. */
export const toolInvocationSchema = requestLogSchema.pick({
	id: true,
	model_id: true,
	provider_id: true,
	provider_model_name: true,
	request_body: true,
	raw_usage: true,
	pricing_audit: true,
	user_email: true,
	status: true,
	standard_cost: true,
	charged_cost: true,
	metered_cost: true,
	latency_ms: true,
	error_message: true,
	created_at: true,
})
export type ToolInvocation = z.infer<typeof toolInvocationSchema>
const count = z.number().int().nonnegative().safe()
export const toolInvocationsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(toolInvocationSchema).max(100),
		total: count,
		page: count.positive(),
		page_size: count.min(1).max(100),
	})
	.superRefine((value, context) => {
		if (
			value.data.length > value.page_size ||
			new Set(value.data.map((row) => row.id)).size !== value.data.length
		)
			context.addIssue({ code: 'custom', message: 'Tool page is inconsistent' })
	})
export type ToolInvocationPage = Pick<
	z.infer<typeof toolInvocationsResponseSchema>,
	'data' | 'total' | 'page' | 'page_size'
>
