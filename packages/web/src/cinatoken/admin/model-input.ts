/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'
import {
	coerceModelInputModalitiesInput,
	coerceModelOutputModalitiesInput,
	coerceModelReleasedAtInput,
	type ModelInputModality,
	type ModelOutputModality,
} from '@octafuse/core/db/model-modalities'
import { normalizeModelRoutePolicyInput } from '@octafuse/core/db/model-route-policy'
import {
	parsePricingProfile,
	type ParsedPricingProfile,
} from '@octafuse/core/db/pricing-profile'
import { parsePublicCatalogTopProviderSelection } from '@octafuse/core/public-model-catalog'
import vendorCatalog from '../../../../admin/lib/model-vendors.json'
import { modelIdentitySchema } from './model-contracts'

export class ModelInputError extends Error {
	constructor() {
		super('Model input is invalid')
		this.name = 'ModelInputError'
	}
}
export type ModelPricingInput =
	string | ParsedPricingProfile | Record<string, unknown>
type ModelFields = {
	display_name?: string | null
	vendor?: string
	context_window?: number | null
	max_tokens?: number | null
	pricing_profile?: ModelPricingInput | null
	description?: string | null
	metadata?: string | Record<string, unknown> | null
	input_modalities?: ModelInputModality[] | null
	output_modalities?: ModelOutputModality[] | null
	released_at?: string | null
	tags?: string[]
}
/** POST does not persist route_policy; use the explicit PATCH operation afterward. */
export type CreateModelInput = ModelFields & {
	id: string
	pricing_profile: ModelPricingInput
}
export type UpdateModelInput = ModelFields & {
	route_policy?: string | Record<string, unknown> | null
	expected_route_policy?: string | null
}
type NormalizedFields = Omit<ModelFields, 'pricing_profile' | 'metadata'> & {
	pricing_profile?: string | null
	metadata?: string | null
}
export type NormalizedCreateModelInput = NormalizedFields & {
	id: string
	pricing_profile: string
}
export type NormalizedUpdateModelInput = NormalizedFields & {
	route_policy?: string | null
	expected_route_policy?: string | null
}

const fields = {
	display_name: z.string().nullable().optional(),
	vendor: z.string().optional(),
	context_window: z.number().int().nonnegative().safe().nullable().optional(),
	max_tokens: z.number().int().nonnegative().safe().nullable().optional(),
	pricing_profile: z.unknown().optional(),
	description: z.string().nullable().optional(),
	metadata: z.unknown().optional(),
	input_modalities: z.array(z.string()).nullable().optional(),
	output_modalities: z.array(z.string()).nullable().optional(),
	released_at: z.string().nullable().optional(),
	tags: z.array(z.string()).optional(),
}
const createSchema = z.object({ ...fields, id: modelIdentitySchema }).strict()
const patchSchema = z
	.object({
		...fields,
		route_policy: z.unknown().optional(),
		expected_route_policy: z.string().nullable().optional(),
	})
	.strict()
const vendorKeys = new Map(
	vendorCatalog.map((item) => [item.key.toLowerCase(), item.key])
)
/** Static labels are shared with the existing server vendor normalizer; no server runtime import. */
export const MODEL_VENDOR_OPTIONS = vendorCatalog.map((item) => ({ ...item }))

function parse<T>(run: () => T): T {
	try {
		return run()
	} catch {
		throw new ModelInputError()
	}
}
function jsonObject(raw: unknown): Record<string, unknown> {
	const value: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new ModelInputError()
	return value as Record<string, unknown>
}
function optionalJson(raw: unknown): string | null {
	if (
		raw === null ||
		raw === undefined ||
		(typeof raw === 'string' && !raw.trim())
	)
		return null
	return JSON.stringify(jsonObject(raw))
}
/** Mirrors Admin pricing-input, including the per-image canonical write and retained finite token/cache prices. */
export function normalizeModelPricingInput(raw: unknown): string | null {
	return parse(() => {
		const json = optionalJson(raw)
		if (json === null) return null
		const profile = parsePricingProfile(json)
		if (!profile) throw new ModelInputError()
		if (
			profile.image_billing_mode === 'token' &&
			profile.image?.default !== undefined
		)
			throw new ModelInputError()
		if (profile.image_billing_mode !== 'per_image') return json
		if (!profile.image) throw new ModelInputError()
		if (
			profile.tiers.some((tier) =>
				[
					tier.image_input_price,
					tier.image_input_cache_price,
					tier.image_output_price,
				].some((price) => price !== null && price > 0)
			)
		)
			throw new ModelInputError()
		const image = { ...profile.image }
		if (image.uncertain_result_policy === 'requested')
			delete image.uncertain_result_policy
		return JSON.stringify({ image_billing_mode: 'per_image', image })
	})
}
function normalizeMetadata(raw: unknown): string | null {
	const json = optionalJson(raw)
	if (json === null) return null
	if (
		parsePublicCatalogTopProviderSelection(jsonObject(json)).status ===
		'invalid'
	)
		throw new ModelInputError()
	return json
}
function normalizeFields(
	value: z.infer<typeof patchSchema>
): NormalizedUpdateModelInput {
	const result = { ...value } as NormalizedUpdateModelInput
	if (value.vendor !== undefined)
		result.vendor = vendorKeys.get(value.vendor.trim().toLowerCase()) ?? 'other'
	if (value.pricing_profile !== undefined)
		result.pricing_profile = normalizeModelPricingInput(value.pricing_profile)
	if (value.metadata !== undefined)
		result.metadata = normalizeMetadata(value.metadata)
	if (value.input_modalities !== undefined) {
		const raw = coerceModelInputModalitiesInput(value.input_modalities)
		result.input_modalities = raw
			? (JSON.parse(raw) as ModelInputModality[])
			: null
	}
	if (value.output_modalities !== undefined) {
		const raw = coerceModelOutputModalitiesInput(value.output_modalities)
		result.output_modalities = raw
			? (JSON.parse(raw) as ModelOutputModality[])
			: null
	}
	if (value.released_at !== undefined)
		result.released_at = coerceModelReleasedAtInput(value.released_at)
	if (value.route_policy !== undefined)
		result.route_policy = normalizeModelRoutePolicyInput(
			optionalJson(value.route_policy)
		)
	if (value.tags !== undefined)
		result.tags = [
			...new Set(value.tags.map((tag) => tag.trim()).filter(Boolean)),
		]
	return result
}
export function createModelInput(
	input: CreateModelInput
): NormalizedCreateModelInput {
	return parse(() => {
		const checked = createSchema.parse(input)
		const result = normalizeFields(checked)
		if (!result.pricing_profile) throw new ModelInputError()
		return {
			...result,
			id: checked.id,
			pricing_profile: result.pricing_profile,
		}
	})
}
export function updateModelInput(
	input: UpdateModelInput
): NormalizedUpdateModelInput {
	return parse(() => {
		const result = normalizeFields(patchSchema.parse(input))
		if (!Object.values(result).some((value) => value !== undefined))
			throw new ModelInputError()
		return result
	})
}
export function modelImportIds(input: string[]): string[] {
	return parse(() =>
		z
			.array(modelIdentitySchema)
			.min(1)
			.parse([...new Set(input)])
	)
}
