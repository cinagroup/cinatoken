/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

const id = z.string().min(1).max(600)
const count = z.number().int().nonnegative().safe()
const finite = z.number().finite()
const nullableDuration = finite.nonnegative().nullable()
const rate = finite.min(0).max(100)

const metrics = {
	request_count: count,
	input_tokens: count,
	output_tokens: count,
	cache_read_tokens: count,
	cache_write_tokens: count,
	cache_hit_rate: rate,
	standard_cost: finite.optional(),
	charged_cost: finite,
	metered_cost: finite,
	success_count: count,
	error_count: count,
	success_rate: rate,
	avg_latency_ms: nullableDuration,
	avg_first_reasoning_token_ms: nullableDuration,
	avg_first_token_ms: nullableDuration,
	avg_effective_ttft_ms: nullableDuration,
	avg_reasoning_phase_ms: nullableDuration,
	reasoning_ttft_rate: rate,
	content_ttft_rate: rate,
	avg_upstream_response_ms: nullableDuration,
	tokens_per_second: finite.nonnegative().nullable(),
	// Additive pairs stay absent for older services; absence never means zero.
	stream_tokens_per_second: finite.nonnegative().nullable().optional(),
	stream_sample_count: count.optional(),
	failover_request_count: count.optional(),
	failover_request_rate: rate.optional(),
	// This is SUM(failover_count)/request_count, and can exceed 100%.
	failover_rate: finite.nonnegative(),
	avg_attempts: nullableDuration,
	avg_charged_per_request: finite,
}
const countsAgree = (row: {
	request_count: number
	success_count: number
	error_count: number
}) => row.success_count + row.error_count <= row.request_count

function qualityMetricsAgree(row: {
	request_count: number
	success_count: number
	stream_tokens_per_second?: number | null
	stream_sample_count?: number
	failover_request_count?: number
	failover_request_rate?: number
}): boolean {
	if (
		(row.stream_sample_count === undefined) !==
		(row.stream_tokens_per_second === undefined)
	)
		return false
	if (row.stream_sample_count !== undefined) {
		if (row.stream_sample_count > row.success_count) return false
		// The same successful, positive-duration cohort supplies count and TPS.
		if (
			(row.stream_sample_count === 0) !==
			(row.stream_tokens_per_second === null)
		)
			return false
	}
	if (
		(row.failover_request_count === undefined) !==
		(row.failover_request_rate === undefined)
	)
		return false
	if (row.failover_request_count === undefined) return true
	if (row.failover_request_count > row.request_count) return false
	if (row.failover_request_count === 0) return row.failover_request_rate === 0
	if (row.failover_request_count === row.request_count)
		return row.failover_request_rate === 100
	// Keep the server's ratio precision; SQL drivers may round nonzero fractions.
	return true
}

export const modelAnalyticsRowSchema = z
	.object({
		model_id: id,
		route_group: z.string().min(1).max(600),
		...metrics,
	})
	.refine(countsAgree)
	.refine(qualityMetricsAgree, 'Inconsistent analytics quality metrics')
export type ModelAnalyticsRow = z.infer<typeof modelAnalyticsRowSchema>

export const modelProviderRowSchema = z
	.object({
		provider_id: id,
		provider_name: z.string().max(600).nullable(),
		distinct_models: count,
		...metrics,
	})
	.refine(countsAgree)
	.refine(qualityMetricsAgree, 'Inconsistent analytics quality metrics')
export type ModelProviderRow = z.infer<typeof modelProviderRowSchema>

export const modelAnalyticsResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(modelAnalyticsRowSchema),
		tags: z.array(z.string().max(600)),
	})
	.superRefine((response, context) => {
		const keys = new Set<string>()
		for (const row of response.data) {
			const key = JSON.stringify([row.model_id, row.route_group])
			if (keys.has(key))
				context.addIssue({
					code: 'custom',
					message: 'Duplicate model analytics row',
				})
			keys.add(key)
		}
	})
export const modelProvidersResponseSchema = z
	.object({
		success: z.literal(true),
		data: z.array(modelProviderRowSchema),
		tags: z.array(z.string().max(600)),
	})
	.superRefine((response, context) => {
		const ids = new Set<string>()
		for (const row of response.data) {
			if (ids.has(row.provider_id))
				context.addIssue({
					code: 'custom',
					message: 'Duplicate model provider row',
				})
			ids.add(row.provider_id)
		}
	})
export const logsPermissionResponseSchema = z.object({
	success: z.literal(true),
})
