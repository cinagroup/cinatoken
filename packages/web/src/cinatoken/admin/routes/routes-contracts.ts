/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const noControls = (value: string): boolean =>
	!Array.from(value).some((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127
	})
export const routeIdentitySchema = z
	.string()
	.min(1)
	.max(600)
	.refine(
		(value) =>
			value !== '.' &&
			value !== '..' &&
			value.trim() === value &&
			noControls(value)
	)
export const routeTextSchema = z
	.string()
	.min(1)
	.max(2_000)
	.refine((value) => value.trim() === value && noControls(value))
export const routeProtocolSchema = z.enum([
	'openai',
	'anthropic',
	'gemini',
	'dashscope',
])
export const routeStrategySchema = z.enum([
	'hash_affinity',
	'weighted_random',
	'weight_priority',
	'weighted_round_robin',
])
const safeInteger = z.number().int().safe()
const nonnegativeInteger = safeInteger.nonnegative()
const nonnegativeFactor = z.number().finite().nonnegative()
const finiteShare = z.number().finite().min(0).max(1)
const timestamp = z
	.string()
	.max(128)
	.refine((value) => !Number.isNaN(Date.parse(value)))

/** The list JOIN and the detail SELECT * are different server projections. */
export const routeDetailSchema = z.object({
	id: routeIdentitySchema,
	model_id: routeIdentitySchema,
	provider_id: routeIdentitySchema,
	provider_model_name: routeTextSchema,
	priority: safeInteger,
	weight: z.number().finite().positive().optional(),
	status: routeTextSchema,
	route_group: routeTextSchema.optional(),
	price_override: z.string().max(1_000_000).nullable(),
	custom_params: z.string().max(1_000_000).nullable(),
	routing_metadata: z.string().max(1_000_000).nullable().optional(),
	upstream_protocol: routeProtocolSchema,
	upstream_operation: routeTextSchema.optional(),
	adapter: routeTextSchema.optional(),
	route_pool_id: routeIdentitySchema.nullable().optional(),
	created_at: timestamp.optional(),
})
export type AdminRouteDetail = z.infer<typeof routeDetailSchema>

export const routeSurfaceSchema = z.object({
	id: routeIdentitySchema,
	request_protocol: routeProtocolSchema,
	request_operation: routeTextSchema,
	status: routeTextSchema,
})
export type RouteSurface = z.infer<typeof routeSurfaceSchema>
const surfaceText = z.string().max(1_000_000).nullable()

export const adminRouteSchema = routeDetailSchema.extend({
	route_group: routeTextSchema,
	weight: z.number().finite().positive(),
	routing_metadata: z.string().max(1_000_000).nullable(),
	upstream_operation: routeTextSchema,
	adapter: routeTextSchema,
	route_pool_id: routeIdentitySchema.nullable(),
	surfaces: surfaceText,
	pool_name: z.string().max(2_000).nullable(),
	pool_strategy: z.string().max(64).nullable(),
	pool_tier_strategies: z.string().max(100_000).nullable(),
	pool_status: z.string().max(64).nullable(),
	pool_sticky_enabled: z
		.union([z.boolean(), z.literal(0), z.literal(1)])
		.nullable(),
	pool_sticky_idle_ttl_seconds: nonnegativeInteger.nullable(),
	pool_sticky_epoch: nonnegativeInteger.nullable(),
	model_name: z.string().max(2_000).nullable(),
	provider_name: z.string().max(2_000).nullable(),
	provider_status: z.string().max(64).nullable().optional(),
})
export type AdminRoute = z.infer<typeof adminRouteSchema>
export const routeListResponseSchema = z.object({
	success: z.literal(true),
	data: z.array(adminRouteSchema),
	count: nonnegativeInteger,
})
const businessTimezoneSchema = z
	.string()
	.min(1)
	.max(128)
	.refine((value) => {
		if (value.trim() !== value || !noControls(value)) return false
		try {
			new Intl.DateTimeFormat('en', { timeZone: value })
			return true
		} catch {
			return false
		}
	})
export const routeContextSchema = z.object({
	global_route_strategy: routeStrategySchema,
	billing_currency: z.string().regex(/^[A-Z]{3}$/),
	business_timezone: businessTimezoneSchema,
})
export type RouteContext = z.infer<typeof routeContextSchema>
export const routeContextResponseSchema = z.object({
	success: z.literal(true),
	data: routeContextSchema,
})
export const routeResponseSchema = z.object({
	success: z.literal(true),
	data: routeDetailSchema,
})
export const routeCreatedResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ id: routeIdentitySchema }),
})
export const routeSuccessSchema = z.object({ success: z.literal(true) })

const dailyWindowSchema = z
	.object({
		start: z.string().regex(/^\d{2}:\d{2}$/),
		end: z.string().regex(/^\d{2}:\d{2}$/),
		factor: nonnegativeFactor,
		days: z.array(z.number().int().min(1).max(7)).max(7).optional(),
	})
	.strict()
export const routePriceOverrideSchema = z
	.object({
		charged_factor: nonnegativeFactor.optional(),
		metered_factor: nonnegativeFactor.optional(),
		provider_factor: nonnegativeFactor.optional(),
		schedule: z
			.object({
				mode: z.enum(['multiply', 'override']),
				charged: z.array(dailyWindowSchema).max(256),
				metered: z.array(dailyWindowSchema).max(256),
			})
			.strict()
			.optional(),
	})
	.catchall(z.json())
	.superRefine((value, context) => {
		for (const key of ['user', '__proto__', 'constructor', 'prototype']) {
			if (Object.prototype.hasOwnProperty.call(value, key))
				context.addIssue({
					code: 'custom',
					message: `Unsupported price override key: ${key}`,
				})
		}
	})
	.transform((value) => {
		const output = { ...value }
		for (const key of [
			'metered',
			'charged',
			'input_price',
			'output_price',
			'cache_read_price',
			'cache_write_price',
		])
			delete output[key]
		return output
	})

function jsonObjectText(input: string): boolean {
	try {
		const value: unknown = JSON.parse(input)
		return value !== null && typeof value === 'object' && !Array.isArray(value)
	} catch {
		return false
	}
}
const jsonObjectString = z.string().max(1_000_000).refine(jsonObjectText)
const priceOverrideString = jsonObjectString
	.refine((raw) => {
		try {
			return routePriceOverrideSchema.safeParse(JSON.parse(raw) as unknown)
				.success
		} catch {
			return false
		}
	})
	.transform((raw) =>
		routePriceOverrideSchema.parse(JSON.parse(raw) as unknown)
	)
export const routePriceOverrideInputSchema = z.union([
	routePriceOverrideSchema,
	priceOverrideString,
	z.null(),
])
const routeMutationFields = {
	model_id: routeIdentitySchema,
	provider_id: routeIdentitySchema,
	provider_model_name: routeTextSchema,
	priority: safeInteger,
	weight: z.number().finite().min(1),
	status: z.enum(['active', 'inactive']),
	route_group: routeTextSchema,
	price_override: routePriceOverrideInputSchema,
	custom_params: jsonObjectString.nullable(),
	routing_metadata: jsonObjectString.nullable(),
	request_protocol: routeProtocolSchema,
	request_operation: routeTextSchema,
	upstream_protocol: routeProtocolSchema,
	upstream_operation: routeTextSchema,
	adapter: routeTextSchema,
}
export const createRouteInputSchema = z
	.object(routeMutationFields)
	.partial()
	.extend({
		model_id: routeIdentitySchema,
		provider_id: routeIdentitySchema,
		provider_model_name: routeTextSchema,
	})
	.strict()
export type CreateRouteInput = z.input<typeof createRouteInputSchema>
export const updateRouteInputSchema = z
	.object(routeMutationFields)
	.partial()
	.strict()
	.refine(
		(value) => Object.keys(value).length > 0,
		'Route patch cannot be empty'
	)
	.refine((value) => {
		const topology = [
			'model_id',
			'request_protocol',
			'request_operation',
			'upstream_protocol',
			'upstream_operation',
			'adapter',
			'route_group',
		] as const
		return (
			!topology.some((key) => value[key] !== undefined) ||
			(value.request_protocol !== undefined &&
				value.request_operation !== undefined)
		)
	}, 'Topology updates require request_protocol and request_operation')
export type UpdateRouteInput = z.input<typeof updateRouteInputSchema>

const tierStrategies = z.record(
	z.string().regex(/^-?\d+$/),
	routeStrategySchema
)
const tierStrategiesText = z
	.string()
	.max(100_000)
	.transform((raw, context) => {
		if (raw.trim() === '') return null
		try {
			return tierStrategies.parse(JSON.parse(raw) as unknown)
		} catch {
			context.addIssue({ code: 'custom', message: 'Invalid tier strategies' })
			return z.NEVER
		}
	})
export const routePoolPolicyPatchSchema = z
	.object({
		strategy: routeStrategySchema.nullable().optional(),
		tier_strategies: z
			.union([tierStrategies, tierStrategiesText, z.null()])
			.optional(),
		sticky_routing: z
			.object({
				enabled: z.boolean(),
				idle_ttl_seconds: z.number().int().min(60).max(86_400),
			})
			.optional(),
	})
	.strict()
	.refine(
		(value) => Object.keys(value).length > 0,
		'Pool patch cannot be empty'
	)
export type RoutePoolPolicyPatch = z.input<typeof routePoolPolicyPatchSchema>

export const stickyBindingsSummarySchema = z.object({
	total_active: nonnegativeInteger,
	stale_count: nonnegativeInteger,
	targets: z.array(
		z.object({
			route_target_id: routeIdentitySchema,
			active_count: nonnegativeInteger,
			share: finiteShare,
			last_updated_at: timestamp.nullable(),
		})
	),
})
export type StickyBindingsSummary = z.infer<typeof stickyBindingsSummarySchema>
export const stickyBindingsSummaryResponseSchema = z.object({
	success: z.literal(true),
	data: stickyBindingsSummarySchema,
})
export const stickyBindingLookupQuerySchema = z
	.object({
		model_id: routeIdentitySchema,
		route_group: routeTextSchema.optional(),
		protocol: routeProtocolSchema,
		request_operation: routeTextSchema.optional(),
		user_id: routeIdentitySchema.optional(),
		email: z.email().max(320).optional(),
	})
	.refine(
		(value) => Boolean(value.user_id || value.email),
		'User ID or email is required'
	)
export type StickyBindingLookupQuery = z.input<
	typeof stickyBindingLookupQuerySchema
>
export const affinityHashSchema = z.string().regex(/^[0-9a-f]{64}$/i)
export const stickyBindingLookupSchema = z.object({
	user_id: routeIdentitySchema,
	affinity_hash: affinityHashSchema,
	affinity_key: z.string().min(1).max(2_000),
	binding: z
		.object({
			route_target_id: routeIdentitySchema,
			expires_at: timestamp,
			pool_epoch: nonnegativeInteger,
			remaining_seconds: nonnegativeInteger,
			epoch_valid: z.boolean(),
			expired: z.boolean(),
		})
		.nullable(),
})
export type StickyBindingLookup = z.infer<typeof stickyBindingLookupSchema>
export const stickyBindingLookupResponseSchema = z.object({
	success: z.literal(true),
	data: stickyBindingLookupSchema,
})
export const stickyBindingClearResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ cleared: z.boolean() }),
})
export const stickyBindingResetResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({ sticky_epoch: nonnegativeInteger }),
})
