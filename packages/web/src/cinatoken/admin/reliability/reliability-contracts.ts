/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const nonnegative = finite.nonnegative()
const percent = finite.min(0).max(100)
const identity = z.string().min(1).max(600)
const optionalIdentity = identity.nullable()
const providerName = z.string().max(600).nullable()
const utcInstant = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
	.refine((value) => {
		const ms = Date.parse(value)
		return Number.isFinite(ms) && new Date(ms).toISOString() === value
	})

const costs = {
	charged_cost: finite,
	metered_cost: finite,
	// Current Admin always returns this; old rolling Admin deployments may omit it.
	standard_cost: finite.optional(),
}
const reliabilityMeasures = {
	request_count: count,
	success_rate: percent,
	avg_latency_ms: nonnegative.nullable(),
	avg_upstream_response_ms: nonnegative.nullable(),
	// This is SUM(failover_count) / request_count, and may exceed 100.
	failover_rate: nonnegative,
	avg_attempts: nonnegative.nullable(),
	...costs,
}

/** Project aggregate rows before they enter the Console query cache. */
export const providerReliabilitySchema = z
	.object({
		provider_id: identity,
		provider_name: providerName,
		success_count: count,
		error_count: count,
		...reliabilityMeasures,
	})
	.refine((row) => row.success_count + row.error_count <= row.request_count)
export type ProviderReliability = z.infer<typeof providerReliabilitySchema>

export const modelProviderReliabilitySchema = z.object({
	model_id: identity,
	provider_id: identity,
	provider_name: providerName,
	...reliabilityMeasures,
})
export type ModelProviderReliability = z.infer<
	typeof modelProviderReliabilitySchema
>

export const reliabilityRecentErrorSchema = z.object({
	id: identity,
	model_id: optionalIdentity,
	provider_id: optionalIdentity,
	provider_name: providerName,
	status: z.string().min(1).max(80),
	created_at: utcInstant,
})
export type ReliabilityRecentError = z.infer<
	typeof reliabilityRecentErrorSchema
>

export const reliabilityResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		providers: z.array(providerReliabilitySchema),
		modelProviders: z.array(modelProviderReliabilitySchema),
		recentErrors: z.array(reliabilityRecentErrorSchema).max(10),
	}),
})
export type ReliabilityPayload = z.infer<
	typeof reliabilityResponseSchema
>['data']

/** Safe projection of /config/overview: no webhook URLs or reveal fields. */
export const reliabilityDisplayResponseSchema = z.object({
	success: z.literal(true),
	data: z.object({
		businessTimezone: z.object({
			value: z
				.string()
				.min(1)
				.max(128)
				.regex(/^[A-Za-z0-9_+:/-]+$/),
			source: z.enum(['configured', 'legacy', 'missing', 'invalid']),
		}),
		billingCurrency: z.object({
			value: z.string().regex(/^[A-Z]{3}$/),
			source: z.enum(['configured', 'missing', 'invalid', 'unsupported']),
		}),
	}),
})

export type ReliabilityDisplay = {
	timezone: string
	timezoneSource: 'configured' | 'legacy' | 'missing' | 'invalid'
	currency: 'USD' | 'CNY' | null
	currencySource: 'configured' | 'missing' | null
}
