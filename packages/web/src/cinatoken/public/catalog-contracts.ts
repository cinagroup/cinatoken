import { z } from 'zod'

const text = (maximum: number) => z.string().min(1).max(maximum)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const finite = z.number().finite()
const price = finite.nonnegative()
const instant = z.iso.datetime({ offset: true })
const protocol = z.enum(['openai', 'anthropic', 'gemini'])
const strings = z.array(text(2_000)).max(2_048)
const priceMap = z
	.record(text(256), price)
	.refine((value) => Object.keys(value).length <= 1_024)
const imageSide = z.object({
	default: price,
	by_quality: priceMap.optional(),
	by_size: priceMap.optional(),
	by_quality_size: priceMap.optional(),
})

/** Catalog prices use billing_currency; token prices are per million tokens. */
export const catalogPricingSchema = z
	.object({
		tiers: z
			.array(
				z.object({
					upto: price.nullable(),
					label: z.string().max(2_000).nullable(),
					input_price: finite,
					output_price: finite,
					cache_read_price: finite.nullable(),
					cache_write_price: finite.nullable(),
					image_input_price: price.nullable(),
					image_input_cache_price: price.nullable(),
					image_output_price: price.nullable(),
				})
			)
			.max(1_024),
		image_billing_mode: z.enum(['token', 'per_image']).optional(),
		image: imageSide
			.extend({
				input: imageSide.optional(),
				uncertain_result_policy: z.enum(['requested', 'zero']).optional(),
			})
			.nullable()
			.optional(),
		audio_billing_mode: z
			.enum(['token', 'per_second', 'per_character'])
			.optional(),
		audio: z
			.union([
				z.object({
					price_per_second: price,
					minimum_seconds: price.optional(),
				}),
				z.object({
					price_per_character: price,
					minimum_characters: count.optional(),
				}),
			])
			.nullable()
			.optional(),
	})
	.superRefine((value, context) => {
		if (
			value.tiers.length === 0 &&
			value.image_billing_mode !== 'per_image' &&
			value.audio_billing_mode !== 'per_second' &&
			value.audio_billing_mode !== 'per_character'
		) {
			context.addIssue({
				code: 'custom',
				message: 'Token pricing requires tiers',
			})
		}
		for (let index = 0; index < value.tiers.length; index++) {
			const bound = value.tiers[index]!.upto
			if (bound === null && index !== value.tiers.length - 1) {
				context.addIssue({
					code: 'custom',
					message: 'Invalid pricing tier bounds',
				})
			}
		}
	})

export const catalogModelSchema = z
	.object({
		id: text(2_000),
		slug: text(256).regex(/^[A-Za-z0-9._:~-]+$/),
		display_name: z.string().max(2_000).nullable(),
		vendor: text(80),
		context_window: count.nullable(),
		max_tokens: count.nullable(),
		pricing_profile: catalogPricingSchema.nullable(),
		tags: strings,
		route_groups: strings,
		protocols: z.array(protocol).min(1).max(3),
		protocols_by_group: z.record(text(2_000), z.array(protocol).min(1).max(3)),
		recommended_protocol: protocol,
		description: z.string().max(100_000).nullable(),
		input_modalities: strings.nullable(),
		output_modalities: strings.nullable(),
		released_at: z.string().max(128).nullable(),
		endpoint_slugs: strings,
		regions: strings,
		data_policy_summary: z.object({
			verified_route_count: count,
			zdr_available: z.boolean(),
			latest_verified_at: z.string().max(128).nullable(),
		}),
	})
	.refine((value) => value.protocols.includes(value.recommended_protocol), {
		message: 'Recommended protocol must be available',
	})

export const catalogProviderSchema = z.object({
	id: text(2_000),
	display_name: text(2_000),
	model_count: count,
	protocols: z.array(protocol).max(3),
	route_groups: strings,
	input_modalities: strings,
	output_modalities: strings,
	latest_released_at: z.string().max(128).nullable(),
})

const metadata = {
	billing_currency: z.string().regex(/^[A-Z]{3}$/),
	generated_at: instant,
}
const uniqueIds = (rows: readonly { id: string }[]) =>
	new Set(rows.map((row) => row.id)).size === rows.length
export const catalogModelsSchema = z
	.object({
		object: z.literal('list'),
		data: z.array(catalogModelSchema).max(5_000),
		...metadata,
	})
	.refine((value) => uniqueIds(value.data), {
		message: 'Duplicate catalog models',
	})
export const catalogDetailSchema = z.object({
	object: z.literal('model'),
	data: catalogModelSchema,
	...metadata,
})
export const catalogProvidersSchema = z
	.object({
		object: z.literal('list'),
		data: z.array(catalogProviderSchema).max(1_000),
		...metadata,
	})
	.refine((value) => uniqueIds(value.data), {
		message: 'Duplicate catalog providers',
	})
export const catalogStatsRangeSchema = z.enum(['7d', '30d', '90d'])
export const catalogStatsSchema = z
	.object({
		object: z.literal('list'),
		data: z
			.array(
				z.object({
					id: text(2_000),
					slug: text(256).regex(/^[A-Za-z0-9._:~-]+$/),
					display_name: text(2_000),
					vendor: text(80),
					request_count: count,
					success_rate: z.number().finite().min(0).max(100),
					avg_latency_ms: price.nullable(),
					output_tokens: count,
					total_tokens: count,
				})
			)
			.max(5_000),
		range: catalogStatsRangeSchema,
		window_start: instant,
		window_end: instant,
		minimum_sample_size: count.min(20),
		generated_at: instant,
	})
	.refine(
		(value) =>
			uniqueIds(value.data) &&
			Date.parse(value.window_start) <= Date.parse(value.window_end) &&
			value.data.every(
				(row) =>
					row.request_count >= value.minimum_sample_size &&
					row.output_tokens <= row.total_tokens
			),
		{ message: 'Invalid public statistics scope or sample' }
	)

export type CatalogModel = z.infer<typeof catalogModelSchema>
export type CatalogPricing = z.infer<typeof catalogPricingSchema>
export type CatalogStatsRange = z.infer<typeof catalogStatsRangeSchema>
