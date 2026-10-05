/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	isAudioModel,
	isImageGenerationModel,
	isRerankModel,
	parseModelModalitiesJson,
} from '@octafuse/core/db/model-modalities'
import {
	parsePricingProfile,
	resolveAudioBillingMode,
	resolveImageBillingMode,
	type ParsedPricingProfile,
} from '@octafuse/core/db/pricing-profile'

export const modelIdentitySchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			!Array.from(value).some(
				(character) =>
					character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
			)
	)
const count = z.number().int().nonnegative().safe()
const nullableTokens = count.nullable()
const timestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)))
export const modelBillingCurrencySchema = z.enum(['USD', 'CNY'])
export type ModelBillingCurrency = z.infer<typeof modelBillingCurrencySchema>
/** Current gateway interpretation; historical model rows do not record their original currency. */
export const currentModelCurrencySchema = z.string().regex(/^[A-Z]{3}$/)
export type CurrentModelCurrency = z.infer<typeof currentModelCurrencySchema>
export type ModelKind = 'llm' | 'image' | 'audio' | 'rerank'
export type ModelPricingState = 'available' | 'missing' | 'invalid'

/** Prices use system BILLING_CURRENCY: token/cache/image tokens per million; image per image; audio per second/character. */
export function modelPricingDetails(raw: string | null): {
	profile: ParsedPricingProfile | null
	state: ModelPricingState
	imageBillingMode: ReturnType<typeof resolveImageBillingMode>
	audioBillingMode: ReturnType<typeof resolveAudioBillingMode>
} {
	const profile = parsePricingProfile(raw)
	let state: ModelPricingState = 'available'
	if (!raw?.trim()) state = 'missing'
	else if (!profile) state = 'invalid'
	return {
		profile,
		state,
		imageBillingMode: resolveImageBillingMode(profile),
		audioBillingMode: resolveAudioBillingMode(profile),
	}
}

/** Exact models-service projection; supplier links/credentials live in routes/endpoints, not this DTO. */
export const adminModelSchema = z
	.object({
		id: modelIdentitySchema,
		display_name: z.string().nullable(),
		vendor: z.string(),
		context_window: nullableTokens,
		max_tokens: nullableTokens,
		pricing_profile: z.string().nullable(),
		input_modalities: z.string().nullable(),
		output_modalities: z.string().nullable(),
		released_at: z.string().nullable(),
		description: z.string().nullable(),
		metadata: z.string().nullable(),
		route_policy: z.string().nullable(),
		created_at: timestamp,
		routes_count: count,
		active_routes_count: count,
		tags: z.array(z.string()),
	})
	.superRefine((row, context) => {
		if (row.active_routes_count > row.routes_count)
			context.addIssue({
				code: 'custom',
				message: 'Model route counts are inconsistent',
			})
	})
	.transform((row) => {
		let kind: ModelKind = 'llm'
		if (isImageGenerationModel(row)) kind = 'image'
		else if (isAudioModel(row)) kind = 'audio'
		else if (isRerankModel(row)) kind = 'rerank'
		return {
			...row,
			kind,
			pricing: modelPricingDetails(row.pricing_profile),
			inputModalities: parseModelModalitiesJson(row.input_modalities),
			outputModalities: parseModelModalitiesJson(row.output_modalities),
		}
	})
export type AdminModel = z.infer<typeof adminModelSchema>
/** Required even for an empty list; never infer model currency from the import catalog. */
export const modelListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminModelSchema),
	count,
	billing_currency: currentModelCurrencySchema,
})
export const modelResponseSchema = z.object({
	success: z.literal(true),
	data: adminModelSchema,
	billing_currency: currentModelCurrencySchema,
})
export type ModelListContext = {
	rows: AdminModel[]
	billingCurrency: CurrentModelCurrency
}
export type ModelDetailContext = {
	row: AdminModel
	billingCurrency: CurrentModelCurrency
}
export const modelCreatedResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: modelIdentitySchema }),
})
export const modelSuccessSchema = z.object({ success: z.literal(true) })

/** Static import catalog returns summaries, not full profiles or supplier routes. Backend labels rerank/embedding as llm here. */
export const modelCatalogItemSchema = z.object({
	id: modelIdentitySchema,
	display_name: z.string().nullable(),
	vendor: z.string(),
	kind: z.enum(['llm', 'image', 'audio']),
	context_window: nullableTokens,
	max_tokens: nullableTokens,
	description: z.string().nullable(),
	i18n: z.object({ en: z.string(), zh: z.string() }).nullable(),
	tier_count: count,
	pricing_label: z.string().nullable(),
	pricing_preview: z.string().nullable(),
})
export type ModelCatalogItem = z.infer<typeof modelCatalogItemSchema>
export const modelCatalogResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(modelCatalogItemSchema),
	count,
	billing_currency: modelBillingCurrencySchema,
})
export type ModelCatalog = {
	items: ModelCatalogItem[]
	billingCurrency: ModelBillingCurrency
}
export const modelImportResultSchema = z.object({
	billing_currency_used: modelBillingCurrencySchema,
	created: count,
	updated: z.literal(0),
	skipped_existing: z.array(modelIdentitySchema),
	// Import failure text is not trusted for a cache or UI; keep an actionable safe classification only.
	failed: z.array(
		z.object({
			id: modelIdentitySchema,
			message: z.string().transform(() => 'Model import failed'),
		})
	),
})
export type ModelImportResult = z.infer<typeof modelImportResultSchema>
export const modelImportResponseSchema = z.object({
	success: z.literal(true),
	data: modelImportResultSchema,
})

export const MODEL_OPERATION_PERMISSIONS = {
	read: 'models.read',
	write: 'models.write',
} as const
export type { ParsedPricingProfile }
