/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	isAudioSpeechModel,
	isAudioTranscriptionModel,
	isImageGenerationModel,
} from '@octafuse/core/db/model-modalities'

const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const cost = z.union([
	finite,
	z
		.string()
		.regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u)
		.max(40)
		.transform(Number)
		.pipe(finite),
])
const duration = finite.nonnegative().nullable().optional()
const small = z.string().max(2_000)
const nullable = small.nullable().optional()
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

/** All server extras are stripped before a log enters the private page state. */
export const requestLogSchema = z.object({
	id: small.min(1),
	user_id: nullable,
	api_key_id: nullable,
	user_email: nullable,
	external_system: nullable,
	model_id: nullable,
	model_name: nullable,
	provider_id: nullable,
	provider_name: nullable,
	provider_model_name: nullable,
	request_protocol: nullable,
	request_operation: nullable,
	upstream_protocol: nullable,
	upstream_operation: nullable,
	model_surface_id: nullable,
	route_pool_id: nullable,
	route_target_id: nullable,
	adapter: nullable,
	route_trace: raw,
	provider_key_id: nullable,
	provider_key_label: nullable,
	provider_key_fingerprint: nullable,
	upstream_request_id: nullable,
	upstream_message_id: nullable,
	request_body: raw,
	upstream_request_body: raw,
	input_tokens: count,
	output_tokens: count,
	cache_read_tokens: count,
	cache_write_tokens: count,
	reasoning_tokens: count.optional(),
	total_tokens: count.optional(),
	standard_cost: cost.optional(),
	metered_cost: cost,
	charged_cost: cost,
	route_group: nullable,
	status: small.min(1),
	latency_ms: duration,
	gateway_overhead_ms: duration,
	upstream_response_ms: duration,
	final_upstream_headers_ms: duration,
	first_reasoning_token_ms: duration,
	first_token_ms: duration,
	stream_duration_ms: duration,
	upstream_attempt_count: count.nullable().optional(),
	upstream_failover_count: count.nullable().optional(),
	timing_metadata: raw,
	error_message: z.string().max(8_192).nullable().optional(),
	raw_usage: raw,
	pricing_audit: raw,
	billing_kind: nullable,
	input_image_count: count.optional(),
	output_image_count: count.optional(),
	audio_duration_seconds: duration,
	audio_characters: count.nullable().optional(),
	created_at: createdAt,
})
export type RequestLog = z.infer<typeof requestLogSchema>

export const requestLogsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(requestLogSchema).max(100),
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
				message: 'Request log page is inconsistent',
			})
	})
export type RequestLogPage = Pick<
	z.infer<typeof requestLogsResponseSchema>,
	'data' | 'total' | 'page' | 'page_size'
>

const catalogId = z.string().min(1).max(600)
const catalogCount = z.number().int().nonnegative().safe()
function catalogModelKind(model: {
	input_modalities?: string | null
	output_modalities?: string | null
	pricing_profile?: string | null
}): 'llm' | 'image' | 'tts' | 'asr' {
	if (isImageGenerationModel(model)) return 'image'
	if (isAudioSpeechModel(model)) return 'tts'
	if (isAudioTranscriptionModel(model)) return 'asr'
	return 'llm'
}
export const logModelsCatalogSchema = z.object({
	success: z.literal(true),
	count: catalogCount,
	data: z.array(
		z
			.object({
				id: catalogId,
				display_name: small.nullable().optional(),
				input_modalities: small.nullable().optional(),
				output_modalities: small.nullable().optional(),
				pricing_profile: z.string().max(262_144).nullable().optional(),
			})
			.transform((model) => ({
				id: model.id,
				display_name: model.display_name,
				kind: catalogModelKind(model),
			}))
	),
})
export const logProvidersCatalogSchema = z.object({
	success: z.literal(true),
	count: catalogCount,
	data: z.array(z.object({ id: catalogId, name: small })),
})
export const logRoutesCatalogSchema = z.object({
	success: z.literal(true),
	count: catalogCount,
	data: z.array(z.object({ route_group: small })),
})
export type LogModelCatalog = z.infer<typeof logModelsCatalogSchema>['data']
export type LogProviderCatalog = z.infer<
	typeof logProvidersCatalogSchema
>['data']
export type LogRouteCatalog = z.infer<typeof logRoutesCatalogSchema>['data']
