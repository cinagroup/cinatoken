/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	normalizeAudioEndpointCapabilities,
	normalizeImageEndpointCapabilities,
	normalizeTextEndpointPricing,
	type AudioEndpointCapabilities,
	type ImageEndpointCapabilities,
	type TextEndpointPricing,
} from '../../../../core/src/model-endpoint-catalog'

export { AUDIO_ENDPOINT_PRICING_OPERATIONS } from '../../../../core/src/model-endpoint-catalog'
export { ROUTE_QUANTIZATIONS } from '../../../../core/src/db/route-routing-metadata'

export const endpointStatusSchema = z.enum(['draft', 'verified', 'disabled'])
export const endpointHasControls = (value: string) =>
	Array.from(value).some(
		(character) =>
			character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
	)
export const endpointIdSchema = z
	.string()
	.min(1)
	.max(191)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			!endpointHasControls(value)
	)
export const endpointForeignIdSchema = z
	.string()
	.min(1)
	.max(512)
	.refine((value) => value.trim() === value && !endpointHasControls(value))
const instant = z.iso.datetime({ offset: true })
const capacity = z.number().int().positive().max(2_147_483_647).nullable()
const evidence = z.boolean().nullable()
export const endpointToolChoiceSchema = z.object({
	auto: evidence,
	function: evidence,
	none: evidence,
	required: evidence,
})
function canonical<T>(normalize: (input: unknown) => T) {
	return z.unknown().transform((value, context): T => {
		try {
			return normalize(value)
		} catch {
			context.addIssue({
				code: 'custom',
				message: 'Invalid endpoint capability evidence',
			})
			return z.NEVER
		}
	})
}
export const endpointPricingSchema = canonical<TextEndpointPricing>(
	normalizeTextEndpointPricing
)
export const endpointImageSchema = canonical<ImageEndpointCapabilities>(
	normalizeImageEndpointCapabilities
)
export const endpointAudioSchema = canonical<AudioEndpointCapabilities>(
	normalizeAudioEndpointCapabilities
)
/** Explicit projection: provider credentials, route headers and additional response fields are discarded. */
export const adminEndpointSchema = z
	.object({
		id: endpointIdSchema,
		model_id: endpointForeignIdSchema,
		provider_id: endpointForeignIdSchema,
		provider_slug: z.string().min(1).max(128),
		tag: z.string().min(1).max(120),
		endpoint_class: z.enum(['standard', 'service_tier']).nullable(),
		region: z.string().max(64).nullable(),
		context_length: capacity,
		max_prompt_tokens: capacity,
		max_completion_tokens: capacity,
		quantization: z.string().max(32).nullable(),
		supported_parameters: z.array(z.string().min(1).max(64)).max(128),
		pricing: endpointPricingSchema.nullable(),
		supports_implicit_caching: evidence,
		supports_voice_cloning: evidence,
		supports_tool_choice: endpointToolChoiceSchema,
		image_capabilities: endpointImageSchema.nullable(),
		audio_capabilities: endpointAudioSchema.nullable(),
		evidence_url: z.string().max(2048).nullable(),
		verified_by: z.string().max(512).nullable(),
		verified_at: instant.nullable(),
		expires_at: instant.nullable(),
		status: endpointStatusSchema,
		created_at: instant,
		updated_at: instant,
		route_target_ids: z.array(endpointForeignIdSchema).max(10_000),
	})
	.refine(
		(row) => new Set(row.route_target_ids).size === row.route_target_ids.length,
		{ message: 'Duplicate endpoint route links' }
	)
export const endpointListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminEndpointSchema).max(1_000),
	count: z.number().int().nonnegative().max(1_000),
})
export const endpointResponseSchema = z.object({
	success: z.literal(true),
	data: adminEndpointSchema,
})
export const endpointWriteResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		id: endpointIdSchema,
		status: endpointStatusSchema,
		audio_capabilities: endpointAudioSchema.nullable(),
	}),
})
export const endpointSuccessSchema = z.object({ success: z.literal(true) })
const modelOption = z.object({
	id: endpointForeignIdSchema,
	display_name: z.string().max(2_000).nullable().optional(),
	vendor: z.string().max(512).nullable().optional(),
})
const providerOption = z.object({
	id: endpointForeignIdSchema,
	name: z.string().max(2_000).nullable().optional(),
})
const routeOption = z.object({
	id: endpointForeignIdSchema,
	model_id: endpointForeignIdSchema,
	provider_id: endpointForeignIdSchema,
	provider_name: z.string().max(2_000).nullable().optional(),
	provider_model_name: z.string().max(2_000).nullable().optional(),
	status: z.string().max(128).nullable().optional(),
})
const optionResponse = <T extends z.ZodType>(item: T) =>
	z.object({
		success: z.literal(true),
		data: z.array(item).max(50_000),
		count: z.number().int().nonnegative().max(50_000),
	})
export const endpointModelOptionsSchema = optionResponse(modelOption)
export const endpointProviderOptionsSchema = optionResponse(providerOption)
export const endpointRouteOptionsSchema = optionResponse(routeOption)
export const endpointBootstrapResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		provider_id: z.literal('deepseek-official'),
		evidence_url: z.string().url(),
		evidence_expires_at: instant,
		pricing_basis: z.literal('peak'),
		published: z.number().int().nonnegative(),
		linked_routes: z.number().int().nonnegative(),
		skipped: z.number().int().nonnegative(),
		failed: z.number().int().nonnegative(),
		models: z
			.array(
				z.object({
					model_id: endpointForeignIdSchema,
					endpoint_id: endpointIdSchema.nullable(),
					status: z.enum([
						'published',
						'skipped_missing_model',
						'skipped_no_routes',
						'failed',
					]),
					linked_routes: z.number().int().nonnegative(),
					// The service can include a raw exception message. Keep the per-model outcome,
					// but never retain an untrusted error body in UI state or query tooling.
					message: z
						.string()
						.max(10_000)
						.nullable()
						.transform(() => null),
				})
			)
			.max(1_000),
	}),
})
export type AdminEndpoint = z.infer<typeof adminEndpointSchema>
export type EndpointStatus = z.infer<typeof endpointStatusSchema>
export type EndpointMutationResult = z.infer<
	typeof endpointWriteResponseSchema
>['data']
export type EndpointBootstrapResult = z.infer<
	typeof endpointBootstrapResponseSchema
>['data']
export type EndpointChoices = {
	models: z.infer<typeof modelOption>[]
	providers: z.infer<typeof providerOption>[]
	routes: z.infer<typeof routeOption>[]
}
export type {
	AudioEndpointCapabilities,
	ImageEndpointCapabilities,
	TextEndpointPricing,
}
