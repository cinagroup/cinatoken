/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const identifier = z
	.string()
	.min(1)
	.max(600)
	.refine((value) => value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value))
const modalities = z.array(z.string())
export const simulatorModelSchema = z.object({
	id: identifier,
	display_name: z.string().nullable().optional(),
	vendor: z.string(),
	kind: z.enum(['llm', 'image', 'audio', 'rerank']),
	audio_operation: z.enum(['transcriptions', 'speech']).nullable().optional(),
	input_modalities: modalities,
	output_modalities: modalities,
})
export const simulatorRouteSchema = z.object({
	id: identifier,
	model_id: identifier,
	provider_id: identifier,
	provider_model_name: z.string().nullable().optional(),
	provider_name: z.string().nullable().optional(),
	priority: z.number().finite(),
	status: z.string(),
	route_group: z.string(),
	upstream_protocol: z.string().nullable().optional(),
	upstream_operation: z.string().nullable().optional(),
	adapter: z.string().nullable().optional(),
	surfaces: z
		.array(
			z.object({
				id: identifier,
				request_protocol: z.enum([
					'openai',
					'anthropic',
					'gemini',
					'dashscope',
				]),
				request_operation: z.string(),
				status: z.string(),
			})
		)
		.transform((entries) => JSON.stringify(entries)),
	route_pool_id: z.string().nullable().optional(),
	pool_name: z.string().nullable().optional(),
})
export const simulatorContextSchema = z.object({
	success: z.literal(true),
	data: z.object({
		models: z.array(simulatorModelSchema),
		routes: z.array(simulatorRouteSchema),
		billing_currency: z.string().nullable(),
		realtime_supported: z.boolean(),
		realtime_tts_supported: z.literal(false),
		capabilities: z.object({
			can_read_keys: z.boolean(),
			can_read_logs: z.boolean(),
		}),
		limits: z.object({
			image_file_bytes: z.number().int().positive(),
			image_count: z.number().int().positive(),
			audio_file_bytes: z.number().int().positive(),
		}),
	}),
})
export const simulatorVerifiedKeySchema = z.object({
	success: z.literal(true),
	data: z.object({
		id: identifier,
		user_id: identifier,
		workspace_id: identifier,
		verified: z.literal(true),
	}),
})
export type SimulatorModel = z.infer<typeof simulatorModelSchema>
export type SimulatorRoute = z.infer<typeof simulatorRouteSchema>
export type SimulatorContext = z.infer<typeof simulatorContextSchema>['data']
