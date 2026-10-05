/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import { ROUTE_QUANTIZATIONS } from '../../../../core/src/db/route-routing-metadata'
import { audioEndpointReferenceEvidenceMatchesVoiceCloning } from '../../../../core/src/model-endpoint-catalog'
import {
	endpointAudioSchema,
	endpointForeignIdSchema,
	endpointImageSchema,
	endpointPricingSchema,
	endpointStatusSchema,
	endpointToolChoiceSchema,
} from './endpoint-contracts'

const foreignId = z.string().trim().pipe(endpointForeignIdSchema)
const providerSlug = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(128)
	.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
const tag = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(120)
	.regex(/^[a-z0-9][a-z0-9._-]{0,63}(?:\/[a-z0-9][a-z0-9._-]{0,63})*$/u)
const integer = z.number().int().positive().max(2_147_483_647).nullable()
const parameters = z
	.array(
		z
			.string()
			.trim()
			.regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u)
	)
	.max(128)
	.refine(
		(rows) =>
			new Set(rows.map((name) => name.toLowerCase())).size === rows.length
	)
const evidenceUrl = z
	.string()
	.trim()
	.max(2048)
	.transform((value, context) => {
		try {
			const url = new URL(value)
			if (url.protocol !== 'https:' || url.username || url.password)
				throw new Error()
			return url.toString()
		} catch {
			context.addIssue({
				code: 'custom',
				message: 'Evidence must be an HTTPS URL without embedded credentials',
			})
			return z.NEVER
		}
	})
	.nullable()
const fields = {
	model_id: foreignId,
	provider_id: foreignId,
	provider_slug: providerSlug,
	tag,
	endpoint_class: z.enum(['standard', 'service_tier']).nullable(),
	region: z
		.string()
		.trim()
		.toLowerCase()
		.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u)
		.nullable(),
	context_length: integer,
	max_prompt_tokens: integer,
	max_completion_tokens: integer,
	quantization: z.enum(ROUTE_QUANTIZATIONS).nullable(),
	supported_parameters: parameters,
	pricing: endpointPricingSchema.nullable(),
	supports_implicit_caching: z.boolean().nullable(),
	supports_voice_cloning: z.boolean().nullable(),
	supports_tool_choice: endpointToolChoiceSchema,
	image_capabilities: endpointImageSchema.nullable(),
	audio_capabilities: endpointAudioSchema.nullable(),
	evidence_url: evidenceUrl,
	expires_at: z.iso.datetime({ offset: true }).nullable(),
	status: endpointStatusSchema,
}
const mutation = z.object(fields).partial().strict()
function relationships(
	value: z.infer<typeof mutation>,
	context: z.RefinementCtx
) {
	if (
		value.tag?.includes('/') &&
		value.provider_slug &&
		!value.tag.startsWith(value.provider_slug + '/')
	)
		context.addIssue({
			code: 'custom',
			path: ['tag'],
			message: 'Tag must belong to the provider',
		})
	if (
		value.endpoint_class === 'service_tier' &&
		value.tag !== undefined &&
		!value.tag.includes('/')
	)
		context.addIssue({
			code: 'custom',
			path: ['tag'],
			message: 'Service tiers require a slash-qualified tag',
		})
	if (value.tag?.includes('/') && value.endpoint_class === null)
		context.addIssue({
			code: 'custom',
			path: ['endpoint_class'],
			message: 'Slash-qualified tags require an endpoint class',
		})
	if (
		value.image_capabilities &&
		value.provider_slug &&
		value.image_capabilities.provider_slug !== value.provider_slug
	)
		context.addIssue({
			code: 'custom',
			path: ['image_capabilities'],
			message: 'Image evidence must match the provider',
		})
	if (
		value.audio_capabilities &&
		value.supports_voice_cloning !== undefined &&
		!audioEndpointReferenceEvidenceMatchesVoiceCloning(
			value.audio_capabilities,
			value.supports_voice_cloning
		)
	)
		context.addIssue({
			code: 'custom',
			path: ['audio_capabilities'],
			message: 'Reference audio requires affirmative voice cloning evidence',
		})
}
export const endpointMutationSchema = mutation.superRefine(relationships)
export const createEndpointSchema = z
	.object(fields)
	.partial()
	.extend({
		model_id: foreignId,
		provider_id: foreignId,
		provider_slug: providerSlug,
		tag,
		endpoint_class: fields.endpoint_class.default(null),
		supported_parameters: parameters.default([]),
		status: z.enum(['draft', 'disabled']).default('draft'),
	})
	.strict()
	.superRefine(relationships)
export type UpdateEndpointInput = z.output<typeof endpointMutationSchema>
export type CreateEndpointInput = z.input<typeof createEndpointSchema>
export class EndpointInputError extends Error {
	constructor() {
		super('Check the endpoint fields and capability evidence')
		this.name = 'EndpointInputError'
	}
}
export function checkedEndpointInput(
	input: CreateEndpointInput | UpdateEndpointInput,
	creating: boolean
): UpdateEndpointInput {
	const result = (
		creating ? createEndpointSchema : endpointMutationSchema
	).safeParse(input)
	if (!result.success) throw new EndpointInputError()
	return result.data
}
