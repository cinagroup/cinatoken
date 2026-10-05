/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { requestLogSchema } from './request-log-contracts'
import { safeLogText } from './request-log-domain'
import { requestLogIdSchema } from './request-log-target'

/** Explicit endpoint has a narrower projection than the existing list. Raw extras are discarded. */
export const requestLogDetailSchema = requestLogSchema
	.omit({
		external_system: true,
		route_trace: true,
		provider_key_label: true,
		provider_key_fingerprint: true,
		request_body: true,
		upstream_request_body: true,
		timing_metadata: true,
		error_message: true,
		raw_usage: true,
		pricing_audit: true,
	})
	.extend({
		id: requestLogIdSchema,
		workspace_id: z.string().max(2000).nullable().optional(),
		metered_cost: z.number().finite(),
		charged_cost: z.number().finite(),
		standard_cost: z.number().finite().optional(),
		reasoning_tokens: z
			.number()
			.int()
			.nonnegative()
			.safe()
			.nullish()
			.transform((value) => value ?? undefined),
		total_tokens: z
			.number()
			.int()
			.nonnegative()
			.safe()
			.nullish()
			.transform((value) => value ?? undefined),
		input_image_count: z
			.number()
			.int()
			.nonnegative()
			.safe()
			.nullish()
			.transform((value) => value ?? undefined),
		output_image_count: z
			.number()
			.int()
			.nonnegative()
			.safe()
			.nullish()
			.transform((value) => value ?? undefined),
	})
	.transform((log) => {
		const projected = { ...log }
		for (const key of [
			'user_id',
			'api_key_id',
			'workspace_id',
			'user_email',
			'model_id',
			'model_name',
			'provider_id',
			'provider_name',
			'provider_model_name',
			'provider_key_id',
			'request_protocol',
			'request_operation',
			'upstream_protocol',
			'upstream_operation',
			'model_surface_id',
			'route_pool_id',
			'route_target_id',
			'adapter',
			'route_group',
			'upstream_request_id',
			'upstream_message_id',
			'billing_kind',
			'status',
		] as const) {
			const value = projected[key]
			if (typeof value === 'string') projected[key] = safeLogText(value)
		}
		return projected
	})
export const requestLogDetailResponseSchema = z.object({
	success: z.literal(true),
	data: requestLogDetailSchema,
})
